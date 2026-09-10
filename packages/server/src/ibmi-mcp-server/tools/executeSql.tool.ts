/**
 * Execute SQL Tool
 *
 * Executes SQL queries on IBM i database with optional security restrictions.
 * Migrated from 3-file pattern to factory pattern.
 *
 * @module executeSql.tool
 * @feature 001-tool-factory
 */

import { z } from "zod";
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import { JsonRpcErrorCode, McpError } from "../../types-global/errors.js";
import {
  getRequestContext,
  requestContextService,
  type RequestContext,
} from "../../utils/index.js";
import { logger } from "../../utils/internal/logger.js";
import { SqlSecurityValidator } from "../utils/security/sqlSecurityValidator.js";
import type { SqlValidationClassification } from "../utils/security/sqlSecurityValidator.js";
import {
  logOperationStart,
  logOperationSuccess,
} from "../../utils/internal/logging-helpers.js";
import { IBMiConnectionPool } from "../services/connectionPool.js";
import {
  accessAtLeast,
  accessFromLegacyReadOnly,
  getExecuteSqlAccessCeiling,
  resolveAccess,
  setExecuteSqlAccessPolicy,
  EXECUTE_SQL_ACCESS_ENV,
  type ExecuteSqlAccess,
} from "../services/executeSqlAccess.js";
import { defineTool } from "../../mcp-server/tools/utils/tool-factory.js";
import type { SdkContext } from "../../mcp-server/tools/utils/types.js";
import { config } from "../../config/index.js";

// =============================================================================
// Constants & Configuration
// =============================================================================

const TOOL_NAME = "execute_sql";
const TOOL_DESCRIPTION =
  "Executes a SELECT query on the IBM i database and returns the results. Use this after validating your query with validate_query.";

/**
 * Configuration for the execute SQL tool
 */
export interface ExecuteSqlToolConfig {
  enabled: boolean;
  description?: string;
  security?: {
    /**
     * Access mode: `read` (SELECT and functions), `read-call` (+ CALL),
     * `write` (everything). Defaults to IBMI_EXECUTE_SQL_ACCESS, then `read`.
     */
    access?: ExecuteSqlAccess;
    /** @deprecated Use `access`. `true` → `read`, `false` → `write`. */
    readOnly?: boolean;
    maxQueryLength?: number;
  };
}

/**
 * Default tool configuration
 * Access mode is controlled by IBMI_EXECUTE_SQL_ACCESS (defaults to `read`)
 * so CALL and write statements are opt-in for security
 *
 * Enabled when:
 * - IBMI_ENABLE_EXECUTE_SQL=true (explicit override), OR
 * - IBMI_ENABLE_DEFAULT_TOOLS=true (part of default text-to-SQL toolset)
 */
let toolConfig: ExecuteSqlToolConfig = {
  enabled: config.ibmi_enableExecuteSql || config.ibmi_enableDefaultTools,
  security: {
    access: config.ibmi_executeSqlAccess,
    maxQueryLength: 10000,
  },
};

/**
 * Configure the execute SQL tool
 * @param config - Configuration options
 * @returns The effective access mode after applying the operator's env
 *   ceiling. Compare with what you requested to detect a downgrade.
 */
export function configureExecuteSqlTool(
  config: Partial<ExecuteSqlToolConfig>,
): ExecuteSqlAccess {
  const context =
    getRequestContext() ??
    requestContextService.createRequestContext({
      operation: "ConfigureExecuteSqlTool",
    });
  logOperationStart(context, "Configuring Execute SQL tool", {
    config,
    toolName: TOOL_NAME,
  });

  // Translate the deprecated boolean before merging so it cannot be shadowed
  // by the access level already present in the defaults.
  const { readOnly, ...incomingSecurity } = config.security ?? {};
  if (incomingSecurity.access === undefined && readOnly !== undefined) {
    incomingSecurity.access = accessFromLegacyReadOnly(readOnly);
  }

  // Merge with existing config
  toolConfig = {
    ...toolConfig,
    ...config,
    security: {
      ...toolConfig.security,
      ...incomingSecurity,
    },
  };

  // Keep the singleton pool's JDBC access in sync with the effective access
  // mode (the pool reads this at lazy init). The env ceiling may lower it.
  const requested = resolveAccess(toolConfig.security);
  const effective = setExecuteSqlAccessPolicy(requested);
  if (effective !== requested) {
    toolConfig.security = { ...toolConfig.security, access: effective };
    logger.warning(
      {
        ...context,
        requested,
        effective,
        ceiling: getExecuteSqlAccessCeiling(),
      },
      `execute_sql access lowered from ${requested} to ${effective}: ${EXECUTE_SQL_ACCESS_ENV} is set in the environment and acts as a ceiling`,
    );
  }

  logOperationSuccess(context, "Execute SQL tool configuration updated", {
    enabled: toolConfig.enabled,
    access: effective,
    maxQueryLength: toolConfig.security?.maxQueryLength,
  });

  return effective;
}

/**
 * Get the current configuration for the execute SQL tool
 * @returns Current tool configuration
 */
export function getExecuteSqlConfig(): ExecuteSqlToolConfig {
  return toolConfig;
}

/**
 * Check if the execute SQL tool is enabled
 * @returns True if the tool is enabled
 */
export function isExecuteSqlEnabled(): boolean {
  return toolConfig.enabled;
}

// =============================================================================
// Schemas
// =============================================================================

/**
 * Input schema for executing SQL queries
 */
const ExecuteSqlInputSchema = z.object({
  sql: z
    .string()
    .min(1, "SQL query cannot be empty.")
    .max(10000, "SQL query exceeds maximum length of 10000 characters.")
    .describe("The SQL query to execute on the IBM i database."),
});

/**
 * Output schema for SQL execution results
 */
const ExecuteSqlResponseSchema = z.object({
  success: z.boolean().describe("Whether the query executed successfully."),
  data: z
    .array(z.record(z.unknown()))
    .optional()
    .describe("Array of result rows if query was successful."),
  rowCount: z
    .number()
    .optional()
    .describe("Number of rows returned by the query."),
  executionTime: z
    .number()
    .optional()
    .describe("Query execution time in milliseconds."),
  truncated: z
    .boolean()
    .optional()
    .describe(
      "True when the result set hit the IBMI_PAGINATION_MAX_ROWS safety cap and was clipped. The returned rows are a prefix of the full result — raise the cap or narrow the query to see more.",
    ),
  metadata: z
    .object({
      columns: z
        .array(
          z.object({
            name: z.string().describe("Column name"),
            type: z.string().describe("Column data type"),
          }),
        )
        .optional()
        .describe("Column metadata for the result set."),
    })
    .optional()
    .describe("Additional metadata about the query results."),
  error: z
    .object({
      code: z.string().describe("Error code"),
      message: z.string().describe("Error message"),
      details: z.record(z.unknown()).optional().describe("Error details"),
    })
    .optional()
    .describe("Error information if the query failed."),
});

type ExecuteSqlInput = z.infer<typeof ExecuteSqlInputSchema>;
type ExecuteSqlResponse = z.infer<typeof ExecuteSqlResponseSchema>;

// =============================================================================
// Security Validation
// =============================================================================

/**
 * Validates SQL query against security restrictions
 * Delegates to centralized SqlSecurityValidator
 * @param sql - SQL query to validate
 * @param appContext - Request context for logging
 * @returns Layer-1 classification used to decide whether wire PARSE_STATEMENT is needed
 * @throws McpError if query violates security restrictions
 */
function validateSqlSecurity(
  sql: string,
  appContext: RequestContext,
): SqlValidationClassification {
  const config = getExecuteSqlConfig();

  const securityConfig = {
    access: resolveAccess(config.security),
    maxQueryLength: config.security?.maxQueryLength ?? 10000,
  };

  // execute_sql needs classification even in write mode to decide whether the
  // wire PARSE_STATEMENT round trip can be skipped.
  return SqlSecurityValidator.validateQuery(sql, securityConfig, appContext, {
    classify: true,
  });
}

/**
 * PARSE_STATEMENT `SQL_STATEMENT_TYPE` values permitted per access mode.
 * `undefined` (write) means every type is permitted.
 */
const PARSE_STATEMENT_ALLOWED_TYPES: Record<
  ExecuteSqlAccess,
  ReadonlySet<string> | undefined
> = {
  read: new Set(["QUERY"]),
  "read-call": new Set(["QUERY", "CALL"]),
  write: undefined,
};

/**
 * Validate SQL query using IBM i PARSE_STATEMENT
 * Verifies every statement type is permitted at the access mode
 * Uses IBM i's native SQL parser for authoritative statement type detection
 *
 * Invoked only when the in-process parser could not classify the statement.
 *
 * @param sql - SQL query to validate (should be pre-sanitized without trailing semicolons)
 * @param access - Effective access mode
 * @param appContext - Request context for logging
 * @throws {McpError} If validation fails (syntax error, statement type not permitted, or execution failure)
 *
 * @see https://www.ibm.com/docs/en/i/7.5?topic=services-parse-statement-table-function
 */
async function validateWithParseStatement(
  sql: string,
  access: ExecuteSqlAccess,
  appContext: RequestContext,
): Promise<void> {
  // Build PARSE_STATEMENT query with named parameters
  const parseQuery = `
    SELECT DISTINCT SQL_STATEMENT_TYPE
    FROM TABLE(QSYS2.PARSE_STATEMENT(
      SQL_STATEMENT => ?,
      NAMING => '*SQL',
      DECIMAL_POINT => '*PERIOD',
      SQL_STRING_DELIMITER => '*APOSTSQL'
    )) AS P
  `.trim();

  try {
    // Execute PARSE_STATEMENT via connection pool
    const result = await IBMiConnectionPool.executeQuery(
      parseQuery,
      [sql],
      appContext,
    );

    // Empty result = syntax error (PARSE_STATEMENT returns no rows on parse failure)
    if (!result.data || result.data.length === 0) {
      throw new McpError(
        JsonRpcErrorCode.ValidationError,
        "SQL syntax error: Query could not be parsed by IBM i",
        {
          query: sql.substring(0, 100) + (sql.length > 100 ? "..." : ""),
          validationMethod: "parse_statement",
        },
      );
    }

    // Every distinct statement type must be permitted at this access mode
    // A missing type is "UNKNOWN" so it can never satisfy a read allow-set.
    const statementTypes = (
      result.data as { SQL_STATEMENT_TYPE?: string }[]
    ).map((row) => (row.SQL_STATEMENT_TYPE || "UNKNOWN").toUpperCase());
    const allowedTypes = PARSE_STATEMENT_ALLOWED_TYPES[access];
    const disallowed = allowedTypes
      ? statementTypes.filter((t) => !allowedTypes.has(t))
      : [];

    if (disallowed.length > 0) {
      throw new McpError(
        JsonRpcErrorCode.ValidationError,
        `Statement type '${disallowed.join("', '")}' not permitted in ${access} access mode`,
        {
          query: sql.substring(0, 100) + (sql.length > 100 ? "..." : ""),
          sqlStatementTypes: statementTypes,
          access,
          validationMethod: "parse_statement",
        },
      );
    }

    logger.debug(
      {
        ...appContext,
        sqlStatementTypes: statementTypes,
        access,
      },
      "PARSE_STATEMENT validation passed",
    );
  } catch (error) {
    // Re-throw McpError as-is
    if (error instanceof McpError) {
      throw error;
    }

    // Fail closed on unexpected errors
    throw new McpError(
      JsonRpcErrorCode.ValidationError,
      "SQL validation failed: Unable to execute PARSE_STATEMENT",
      {
        query: sql.substring(0, 100) + (sql.length > 100 ? "..." : ""),
        validationMethod: "parse_statement",
        originalError: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

// =============================================================================
// Business Logic
// =============================================================================

/**
 * Core logic for executing SQL queries
 * Validates security restrictions and executes the query
 * (Not exported: consumers use `executeSqlTool.logic`, as the CLI does.)
 */
async function executeSqlLogic(
  params: ExecuteSqlInput,
  appContext: RequestContext,
  _sdkContext: SdkContext,
): Promise<ExecuteSqlResponse> {
  // Sanitize SQL: Remove trailing semicolons (statement terminators)
  // IBM i SQL execution and PARSE_STATEMENT expect pure SQL without terminators
  const sanitizedSql = params.sql.trim().replace(/;+\s*$/, "");

  logger.debug(
    {
      ...appContext,
      toolInput: params,
      sanitized: sanitizedSql !== params.sql,
    },
    "Processing execute SQL logic.",
  );

  const startTime = Date.now();

  try {
    // Layer 1: in-process AST/regex + vscode-db2i classification
    const classification = validateSqlSecurity(sanitizedSql, appContext);

    // Layer 2: wire PARSE_STATEMENT — only when Layer 1 could not classify
    // (regex fallback / uncertain). The JDBC access derived from the access
    // mode on the singleton pool is the fail-closed backstop for the skip
    // path (read / read-call → "read call" blocks writes at Db2).
    const access = resolveAccess(getExecuteSqlConfig().security);
    if (!classification.classified) {
      logger.debug(
        {
          ...appContext,
          access,
          validatedBy: classification.validatedBy,
        },
        "Running PARSE_STATEMENT validation (in-process parser could not classify)",
      );
      await validateWithParseStatement(sanitizedSql, access, appContext);
    } else {
      logger.debug(
        {
          ...appContext,
          access,
          validatedBy: classification.validatedBy,
          statementTypes: classification.statementTypes,
        },
        "Skipping PARSE_STATEMENT; in-process parser classified statement",
      );
    }

    // Execute the query with sanitized SQL. Fetch size and the overall
    // row cap are controlled by IBMI_PAGINATION_* env vars at the
    // service layer, so execute_sql inherits the same ceiling as any
    // YAML tool that paginates.
    const result = await IBMiConnectionPool.executeQueryWithPagination(
      sanitizedSql,
      [],
      appContext,
    );

    const executionTime = Date.now() - startTime;

    if (!result.success) {
      // Return error response that matches schema
      return {
        success: false,
        executionTime,
        error: {
          code: String(JsonRpcErrorCode.DatabaseError),
          message: "SQL query execution failed",
          details: {
            sql: sanitizedSql,
            sqlReturnCode: result.sql_rc,
          },
        },
      };
    }

    // Type assertion for result data - we know this is an array of records from the database
    const typedData = result.data as Record<string, unknown>[] | undefined;

    const response: ExecuteSqlResponse = {
      success: true,
      data: typedData,
      rowCount: typedData?.length ?? 0,
      executionTime,
      truncated: result.truncated,
      metadata:
        typedData && typedData.length > 0 && typedData[0]
          ? {
              columns: Object.keys(typedData[0]).map((key) => ({
                name: key,
                type: typeof typedData[0]![key],
              })),
            }
          : undefined,
    };

    logger.debug(
      {
        ...appContext,
        rowCount: response.rowCount,
        executionTime,
        hasData: !!response.data,
      },
      "SQL query executed successfully.",
    );

    return response;
  } catch (error) {
    const executionTime = Date.now() - startTime;

    logger.error(
      {
        ...appContext,
        error: error instanceof Error ? error.message : String(error),
        sql: sanitizedSql,
        executionTime,
      },
      "SQL query execution failed.",
    );

    // Return error response that matches schema instead of throwing
    if (error instanceof McpError) {
      return {
        success: false,
        executionTime,
        error: {
          code: String(error.code),
          message: error.message,
          details: error.details,
        },
      };
    }

    // Handle unexpected errors
    return {
      success: false,
      executionTime,
      error: {
        code: String(JsonRpcErrorCode.DatabaseError),
        message: `SQL query execution failed: ${error instanceof Error ? error.message : String(error)}`,
        details: {
          sql: sanitizedSql,
          originalError: error instanceof Error ? error.name : "Unknown",
        },
      },
    };
  }
}

// =============================================================================
// Custom Response Formatter
// =============================================================================

const executeSqlResponseFormatter = (
  result: ExecuteSqlResponse,
): ContentBlock[] => {
  if (!result.success) {
    // Format error response
    const errorMessage = result.error?.message || "SQL query execution failed";
    const errorDetails = result.error?.details
      ? `\n\nDetails:\n${JSON.stringify(result.error.details, null, 2)}`
      : "";

    return [
      {
        type: "text",
        text: `Error: ${errorMessage}${errorDetails}`,
      },
    ];
  }

  // Format the result as a table-like JSON representation
  const resultJson = JSON.stringify(result.data, null, 2);

  // Surface pagination truncation so callers (including LLMs consuming the
  // text block) know the result is a prefix of the full set — otherwise
  // downstream analysis operates on silently-clipped data.
  const truncationNotice = result.truncated
    ? `\n\n⚠️  Result truncated at ${result.rowCount} rows (IBMI_PAGINATION_MAX_ROWS cap). Raise the cap or narrow the query to see more.`
    : "";

  return [
    {
      type: "text",
      text: `SQL query executed successfully.\n\nRows returned: ${result.rowCount}\nExecution time: ${result.executionTime}ms${truncationNotice}\n\nResults:\n${resultJson}`,
    },
  ];
};

// =============================================================================
// Tool Definition
// =============================================================================

export const executeSqlTool = defineTool({
  name: TOOL_NAME,
  title: "Execute SQL",
  description: toolConfig.description || TOOL_DESCRIPTION,
  inputSchema: ExecuteSqlInputSchema,
  outputSchema: ExecuteSqlResponseSchema,
  logic: executeSqlLogic,
  responseFormatter: executeSqlResponseFormatter,
  annotations: {
    // Only `read` is read-only; CALL can mutate, so read-call is not.
    readOnlyHint: !accessAtLeast(
      resolveAccess(toolConfig.security),
      "read-call",
    ),
    destructiveHint: accessAtLeast(
      resolveAccess(toolConfig.security),
      "read-call",
    ),
    openWorldHint: accessAtLeast(
      resolveAccess(toolConfig.security),
      "read-call",
    ),
  },
  enabled: () =>
    toolConfig.enabled ||
    config.ibmi_enableExecuteSql ||
    config.ibmi_enableDefaultTools, // Check both toolConfig and live config for CLI override support
});

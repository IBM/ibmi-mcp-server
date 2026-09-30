/**
 * Execute SQL Tool
 *
 * Executes SQL on the IBM i database behind the execute_sql guardrails
 * (read | read-call | write). The guardrails constrain the SQL text; the
 * connection's IBM i user profile is the security boundary.
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
import {
  enforceExecuteSqlGuardrails,
  stripStatementTerminator,
} from "../utils/security/executeSqlGuardrail.js";
import {
  logOperationStart,
  logOperationSuccess,
} from "../../utils/internal/logging-helpers.js";
import { IBMiConnectionPool } from "../services/connectionPool.js";
import {
  accessAtLeast,
  accessFromLegacyReadOnly,
  EXECUTE_SQL_ACCESS_ENV,
  getExecuteSqlAccessCeiling,
  getExecuteSqlAccessPolicy,
  setExecuteSqlAccessPolicy,
  type ExecuteSqlAccess,
} from "../services/executeSqlAccess.js";
import { defineTool } from "../../mcp-server/tools/utils/tool-factory.js";
import type { SdkContext } from "../../mcp-server/tools/utils/types.js";
import { config } from "../../config/index.js";

// =============================================================================
// Constants & Configuration
// =============================================================================

const TOOL_NAME = "execute_sql";

/** LLM-facing description per guardrail mode. */
const TOOL_DESCRIPTIONS: Record<ExecuteSqlAccess, () => string> = {
  read: () => {
    const functions = config.ibmi_executeSqlForbiddenFunctions;
    const forbidden = functions.length
      ? ` and the functions ${functions.join(", ")}`
      : "";
    return `Executes a read-only query (SELECT, WITH or VALUES) on the IBM i database and returns the results. Not allowed: INSERT/UPDATE/DELETE/MERGE (including FINAL TABLE (INSERT ...)), CALL, DDL, sequence references (NEXT VALUE FOR, PREVIOUS VALUE FOR)${forbidden}. Validate your query with validate_query first.`;
  },
  "read-call": () =>
    "Executes a query (SELECT, WITH or VALUES) or a CALL to a stored procedure on the IBM i database and returns the results. Functions and procedures may have side effects. Not allowed: INSERT/UPDATE/DELETE/MERGE (including FINAL TABLE (INSERT ...)), DDL, SET, COMMIT/ROLLBACK and compound statements. Validate your query with validate_query first.",
  write: () =>
    "Executes any single SQL statement on the IBM i database (queries, CALL, INSERT/UPDATE/DELETE/MERGE, DDL) and returns the results. What it can change is limited only by the connection user profile's authority.",
};

/**
 * Configuration for the execute SQL tool
 */
export interface ExecuteSqlToolConfig {
  enabled: boolean;
  description?: string;
  security?: {
    /**
     * Guardrail mode: `read`, `read-call` or `write`. Lowered to
     * IBMI_EXECUTE_SQL_ACCESS when that is set (a ceiling).
     */
    access?: ExecuteSqlAccess;
    /** @deprecated Use `access`. `true` → `read`, `false` → `write`. */
    readOnly?: boolean;
    /** Keyword patterns added to IBMI_EXECUTE_SQL_FORBIDDEN_KEYWORDS. */
    forbiddenKeywords?: string[];
    maxQueryLength?: number;
  };
}

/**
 * Default tool configuration. The guardrail mode lives in the access policy
 * (services/executeSqlAccess.ts), seeded from IBMI_EXECUTE_SQL_ACCESS.
 *
 * Enabled when:
 * - IBMI_ENABLE_EXECUTE_SQL=true (explicit override), OR
 * - IBMI_ENABLE_DEFAULT_TOOLS=true (part of default text-to-SQL toolset)
 */
let toolConfig: ExecuteSqlToolConfig = {
  enabled: config.ibmi_enableExecuteSql || config.ibmi_enableDefaultTools,
  security: {
    maxQueryLength: 10000,
  },
};

/**
 * Configure the execute SQL tool
 * @param config - Configuration options
 * @returns The effective guardrail mode after applying the env ceiling.
 *   Compare it with the requested mode to detect a downgrade.
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

  // The mode is held by the access policy, not the tool config
  const { access, readOnly, ...security } = config.security ?? {};
  toolConfig = {
    ...toolConfig,
    ...config,
    security: {
      ...toolConfig.security,
      ...security,
    },
  };

  const requested =
    access ?? accessFromLegacyReadOnly(readOnly) ?? getExecuteSqlAccessPolicy();
  const effective = setExecuteSqlAccessPolicy(requested);
  if (effective !== requested) {
    logger.warning(
      {
        ...context,
        requested,
        effective,
        ceiling: getExecuteSqlAccessCeiling(),
      },
      `execute_sql guardrail mode lowered from ${requested} to ${effective}: ${EXECUTE_SQL_ACCESS_ENV} is set and acts as a ceiling`,
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
// Business Logic
// =============================================================================

/**
 * Core logic for executing SQL queries.
 * Guardrail rejections throw (the handler returns them with isError);
 * execution failures are returned in the response.
 */
async function executeSqlLogic(
  params: ExecuteSqlInput,
  appContext: RequestContext,
  _sdkContext: SdkContext,
): Promise<ExecuteSqlResponse> {
  // IBM i SQL execution and PARSE_STATEMENT expect no statement terminator
  const sanitizedSql = stripStatementTerminator(params.sql);

  logger.debug(
    {
      ...appContext,
      toolInput: params,
      sanitized: sanitizedSql !== params.sql,
    },
    "Processing execute SQL logic.",
  );

  await enforceExecuteSqlGuardrails(
    sanitizedSql,
    {
      access: getExecuteSqlAccessPolicy(),
      parseStatement: (query, bindings, rowsToFetch) =>
        IBMiConnectionPool.executeQuery(
          query,
          bindings,
          appContext,
          rowsToFetch,
        ),
      forbiddenKeywords: toolConfig.security?.forbiddenKeywords,
      maxQueryLength: toolConfig.security?.maxQueryLength,
    },
    appContext,
  );

  const startTime = Date.now();

  try {
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
  // Getters: registration reads them after configuration has been applied
  get description() {
    return (
      toolConfig.description || TOOL_DESCRIPTIONS[getExecuteSqlAccessPolicy()]()
    );
  },
  inputSchema: ExecuteSqlInputSchema,
  outputSchema: ExecuteSqlResponseSchema,
  logic: executeSqlLogic,
  responseFormatter: executeSqlResponseFormatter,
  // Only `read` is read-only; functions and procedures can change state
  get annotations() {
    const mayChange = accessAtLeast(getExecuteSqlAccessPolicy(), "read-call");
    return {
      readOnlyHint: !mayChange,
      destructiveHint: mayChange,
      openWorldHint: mayChange,
    };
  },
  enabled: () =>
    toolConfig.enabled ||
    config.ibmi_enableExecuteSql ||
    config.ibmi_enableDefaultTools, // Check both toolConfig and live config for CLI override support
});

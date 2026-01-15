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
import {
  logOperationStart,
  logOperationSuccess,
} from "../../utils/internal/logging-helpers.js";
import { IBMiConnectionPool } from "../services/connectionPool.js";
import { defineTool } from "../../mcp-server/tools/utils/tool-factory.js";
import type { SdkContext } from "../../mcp-server/tools/utils/types.js";

// =============================================================================
// Constants & Configuration
// =============================================================================

const TOOL_NAME = "execute_sql";
const TOOL_DESCRIPTION =
  "Executes a SELECT query on the IBM i database and returns the results. Use this tool to retrieve data from database tables and views.";

/**
 * SQL keywords that are restricted in read-only mode
 */
const RESTRICTED_KEYWORDS = [
  "DROP",
  "DELETE",
  "TRUNCATE",
  "INSERT",
  "UPDATE",
  "ALTER",
  "CREATE",
  "GRANT",
  "REVOKE",
] as const;

/**
 * Configuration for the execute SQL tool
 */
export interface ExecuteSqlToolConfig {
  enabled: boolean;
  description?: string;
  security?: {
    readOnly?: boolean;
    maxQueryLength?: number;
  };
}

/**
 * Default tool configuration
 * Tool is disabled by default for security reasons
 */
let toolConfig: ExecuteSqlToolConfig = {
  enabled: true,
  security: {
    readOnly: true,
    maxQueryLength: 10000,
  },
};

/**
 * Configure the execute SQL tool
 * @param config - Configuration options
 */
export function configureExecuteSqlTool(
  config: Partial<ExecuteSqlToolConfig>,
): void {
  const context =
    getRequestContext() ??
    requestContextService.createRequestContext({
      operation: "ConfigureExecuteSqlTool",
    });
  logOperationStart(context, "Configuring Execute SQL tool", {
    config,
    toolName: TOOL_NAME,
  });

  // Merge with existing config
  toolConfig = {
    ...toolConfig,
    ...config,
    security: {
      ...toolConfig.security,
      ...config.security,
    },
  };

  logOperationSuccess(context, "Execute SQL tool configuration updated", {
    enabled: toolConfig.enabled,
    readOnly: toolConfig.security?.readOnly,
    maxQueryLength: toolConfig.security?.maxQueryLength,
  });
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
 * @param sql - SQL query to validate
 * @param appContext - Request context for logging
 * @throws McpError if query violates security restrictions
 */
function validateSqlSecurity(sql: string, appContext: RequestContext): void {
  const config = getExecuteSqlConfig();

  // Check query length
  const maxLength = config.security?.maxQueryLength ?? 10000;
  if (sql.length > maxLength) {
    throw new McpError(
      JsonRpcErrorCode.InvalidParams,
      `SQL query exceeds maximum length of ${maxLength} characters`,
      {
        queryLength: sql.length,
        maxLength,
      },
    );
  }

  // Check for restricted keywords in read-only mode
  if (config.security?.readOnly ?? true) {
    const upperSql = sql.toUpperCase();
    for (const keyword of RESTRICTED_KEYWORDS) {
      // Use word boundaries to avoid false positives
      const pattern = new RegExp(`\\b${keyword}\\b`, "i");
      if (pattern.test(upperSql)) {
        logger.warning(
          {
            ...appContext,
            keyword,
            sqlPreview: sql.substring(0, 100),
          },
          `Blocked SQL query containing restricted keyword: ${keyword}`,
        );
        throw new McpError(
          JsonRpcErrorCode.InvalidParams,
          `SQL query contains restricted keyword '${keyword}'. Only SELECT queries are allowed in read-only mode.`,
          {
            keyword,
            readOnlyMode: true,
            restrictedKeywords: RESTRICTED_KEYWORDS,
          },
        );
      }
    }
  }
}

// =============================================================================
// Business Logic
// =============================================================================

/**
 * Core logic for executing SQL queries
 * Validates security restrictions and executes the query
 */
async function executeSqlLogic(
  params: ExecuteSqlInput,
  appContext: RequestContext,
  _sdkContext: SdkContext,
): Promise<ExecuteSqlResponse> {
  logger.debug(
    { ...appContext, toolInput: params },
    "Processing execute SQL logic.",
  );

  const startTime = Date.now();

  try {
    // Validate security restrictions
    validateSqlSecurity(params.sql, appContext);

    // Execute the query
    const result = await IBMiConnectionPool.executeQueryWithPagination(
      params.sql,
      [],
      appContext,
      1000, // Fetch 1000 rows at a time
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
            sql: params.sql,
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
        sql: params.sql,
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
          sql: params.sql,
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

  return [
    {
      type: "text",
      text: `SQL query executed successfully.\n\nRows returned: ${result.rowCount}\nExecution time: ${result.executionTime}ms\n\nResults:\n${resultJson}`,
    },
  ];
};

// =============================================================================
// Tool Definition
// =============================================================================

export default defineTool({
  name: TOOL_NAME,
  title: "Execute SQL",
  description: toolConfig.description || TOOL_DESCRIPTION,
  inputSchema: ExecuteSqlInputSchema,
  outputSchema: ExecuteSqlResponseSchema,
  logic: executeSqlLogic,
  responseFormatter: executeSqlResponseFormatter,
  annotations: {
    readOnlyHint: toolConfig.security?.readOnly ?? true, // Default to true for safety
    destructiveHint: !(toolConfig.security?.readOnly ?? true), // Destructive if not read-only
    openWorldHint: !(toolConfig.security?.readOnly ?? true), // Open world if not read-only
  },
  enabled: () => toolConfig.enabled, // Use function to dynamically check enabled state
});

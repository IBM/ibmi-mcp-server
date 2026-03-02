/**
 * Validate Query Tool
 *
 * Validates SQL query syntax using IBM i's native PARSE_STATEMENT table function.
 * Returns statement type and parsing results without executing the query.
 * Promoted from YAML tool definition.
 *
 * @module validateQuery.tool
 */

import { z } from "zod";
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import { JsonRpcErrorCode, McpError } from "../../types-global/errors.js";
import type { RequestContext } from "../../utils/index.js";
import { logger } from "../../utils/internal/logger.js";
import { IBMiConnectionPool } from "../services/connectionPool.js";
import { defineTool } from "../../mcp-server/tools/utils/tool-factory.js";
import type { SdkContext } from "../../mcp-server/tools/utils/types.js";

// =============================================================================
// Schemas
// =============================================================================

const ValidateQueryInputSchema = z.object({
  sql_statement: z
    .string()
    .min(5, "SQL statement must be at least 5 characters.")
    .max(10000, "SQL statement cannot exceed 10000 characters.")
    .describe(
      "SQL statement to validate (e.g., 'SELECT * FROM QIWS.QCUSTCDT')",
    ),
});

const ValidateQueryOutputSchema = z.object({
  success: z.boolean().describe("Whether the validation executed successfully."),
  data: z
    .array(z.record(z.unknown()))
    .optional()
    .describe(
      "PARSE_STATEMENT results including statement type, tokens, and parsing details. Empty array indicates invalid SQL.",
    ),
  rowCount: z.number().optional().describe("Number of result rows returned."),
  executionTime: z
    .number()
    .optional()
    .describe("Validation execution time in milliseconds."),
  error: z
    .object({
      code: z.string().describe("Error code"),
      message: z.string().describe("Error message"),
      details: z.record(z.unknown()).optional().describe("Error details"),
    })
    .optional()
    .describe("Error information if the validation failed."),
});

type ValidateQueryInput = z.infer<typeof ValidateQueryInputSchema>;
type ValidateQueryOutput = z.infer<typeof ValidateQueryOutputSchema>;

// =============================================================================
// Business Logic
// =============================================================================

async function validateQueryLogic(
  params: ValidateQueryInput,
  appContext: RequestContext,
  _sdkContext: SdkContext,
): Promise<ValidateQueryOutput> {
  logger.debug(
    { ...appContext, toolInput: params },
    "Processing validate query logic.",
  );

  const startTime = Date.now();

  const sql = `
    SELECT *
    FROM TABLE(QSYS2.PARSE_STATEMENT(
      SQL_STATEMENT => ?,
      NAMING => '*SQL',
      DECIMAL_POINT => '*PERIOD',
      SQL_STRING_DELIMITER => '*APOSTSQL'
    )) AS P
  `.trim();

  try {
    const result = await IBMiConnectionPool.executeQuery(
      sql,
      [params.sql_statement],
      appContext,
    );

    const executionTime = Date.now() - startTime;

    const typedData = (result.data as Record<string, unknown>[]) ?? [];

    return {
      success: true,
      data: typedData,
      rowCount: typedData.length,
      executionTime,
    };
  } catch (error) {
    const executionTime = Date.now() - startTime;

    logger.error(
      {
        ...appContext,
        error: error instanceof Error ? error.message : String(error),
        sqlStatement:
          params.sql_statement.substring(0, 100) +
          (params.sql_statement.length > 100 ? "..." : ""),
        executionTime,
      },
      "Validate query failed.",
    );

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

    return {
      success: false,
      executionTime,
      error: {
        code: String(JsonRpcErrorCode.DatabaseError),
        message: `Failed to validate query: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
}

// =============================================================================
// Response Formatter
// =============================================================================

const validateQueryResponseFormatter = (
  result: ValidateQueryOutput,
): ContentBlock[] => {
  if (!result.success) {
    const errorMessage = result.error?.message || "Failed to validate query";
    const errorDetails = result.error?.details
      ? `\n\nDetails:\n${JSON.stringify(result.error.details, null, 2)}`
      : "";
    return [{ type: "text", text: `Error: ${errorMessage}${errorDetails}` }];
  }

  if (!result.data || result.data.length === 0) {
    return [
      {
        type: "text",
        text: `SQL validation result: The statement could not be parsed. This typically indicates a syntax error.\nExecution time: ${result.executionTime}ms`,
      },
    ];
  }

  const resultJson = JSON.stringify(result.data, null, 2);
  return [
    {
      type: "text",
      text: `SQL validation passed.\nExecution time: ${result.executionTime}ms\n\nParse results:\n${resultJson}`,
    },
  ];
};

// =============================================================================
// Tool Definition
// =============================================================================

export const validateQueryTool = defineTool({
  name: "validate_query",
  title: "Validate Query",
  description:
    "Validate SQL query syntax using IBM i's native SQL parser. Returns statement type and parsing results without executing the query. If no results are returned, the statement is invalid.",
  inputSchema: ValidateQueryInputSchema,
  outputSchema: ValidateQueryOutputSchema,
  logic: validateQueryLogic,
  responseFormatter: validateQueryResponseFormatter,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
});

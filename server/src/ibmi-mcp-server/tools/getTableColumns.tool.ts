/**
 * Get Table Columns Tool
 *
 * Returns column details for a table including name, type, length,
 * nullable, and description. Part of the default text-to-SQL toolset.
 *
 * @module getTableColumns.tool
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

const GetTableColumnsInputSchema = z.object({
  schema_name: z
    .string()
    .min(1, "Schema name cannot be empty.")
    .max(128, "Schema name cannot exceed 128 characters.")
    .describe(
      "Schema name containing the table (e.g., 'QIWS', 'SAMPLE', 'MYLIB')",
    ),
  table_name: z
    .string()
    .min(1, "Table name cannot be empty.")
    .max(128, "Table name cannot exceed 128 characters.")
    .describe(
      "Table name to get columns for (e.g., 'QCUSTCDT', 'EMPLOYEE')",
    ),
});

const GetTableColumnsOutputSchema = z.object({
  success: z.boolean().describe("Whether the query executed successfully."),
  data: z
    .array(z.record(z.unknown()))
    .optional()
    .describe(
      "Array of column detail records. Each record contains: COLUMN_NAME, SYSTEM_COLUMN_NAME (10-char DDS name), DATA_TYPE, LENGTH, NUMERIC_SCALE, NUMERIC_PRECISION, IS_NULLABLE (Y/N), HAS_DEFAULT (Y/N), COLUMN_DEFAULT, COLUMN_TEXT, COLUMN_HEADING (DDS heading), ORDINAL_POSITION, CCSID, HIDDEN (P=implicitly hidden, N=visible), IS_IDENTITY (YES/NO).",
    ),
  rowCount: z.number().optional().describe("Number of columns returned."),
  executionTime: z
    .number()
    .optional()
    .describe("Query execution time in milliseconds."),
  error: z
    .object({
      code: z.string().describe("Error code"),
      message: z.string().describe("Error message"),
      details: z.record(z.unknown()).optional().describe("Error details"),
    })
    .optional()
    .describe("Error information if the query failed."),
});

type GetTableColumnsInput = z.infer<typeof GetTableColumnsInputSchema>;
type GetTableColumnsOutput = z.infer<typeof GetTableColumnsOutputSchema>;

// =============================================================================
// Business Logic
// =============================================================================

async function getTableColumnsLogic(
  params: GetTableColumnsInput,
  appContext: RequestContext,
  _sdkContext: SdkContext,
): Promise<GetTableColumnsOutput> {
  logger.debug(
    { ...appContext, toolInput: params },
    "Processing get table columns logic.",
  );

  const startTime = Date.now();

  const sql = `
    SELECT COLUMN_NAME,
           SYSTEM_COLUMN_NAME,
           DATA_TYPE,
           LENGTH,
           NUMERIC_SCALE,
           NUMERIC_PRECISION,
           IS_NULLABLE,
           HAS_DEFAULT,
           COLUMN_DEFAULT,
           COLUMN_TEXT,
           COLUMN_HEADING,
           ORDINAL_POSITION,
           CCSID,
           HIDDEN,
           IS_IDENTITY
    FROM QSYS2.SYSCOLUMNS2
    WHERE TABLE_SCHEMA = UPPER(?)
      AND TABLE_NAME = UPPER(?)
    ORDER BY ORDINAL_POSITION
  `.trim();

  try {
    const result = await IBMiConnectionPool.executeQuery(
      sql,
      [params.schema_name, params.table_name],
      appContext,
    );

    const executionTime = Date.now() - startTime;

    if (!result.data) {
      return {
        success: true,
        data: [],
        rowCount: 0,
        executionTime,
      };
    }

    const typedData = result.data as GetTableColumnsOutput["data"];

    // Strip null/undefined values from each row to reduce response size
    const filteredData = typedData?.map((row) =>
      Object.fromEntries(
        Object.entries(row).filter(([, v]) => v != null),
      ),
    );

    return {
      success: true,
      data: filteredData,
      rowCount: filteredData?.length ?? 0,
      executionTime,
    };
  } catch (error) {
    const executionTime = Date.now() - startTime;

    logger.error(
      {
        ...appContext,
        error: error instanceof Error ? error.message : String(error),
        schema: params.schema_name,
        table: params.table_name,
        executionTime,
      },
      "Get table columns query failed.",
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
        message: `Failed to get table columns: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
}

// =============================================================================
// Response Formatter
// =============================================================================

const getTableColumnsResponseFormatter = (
  result: GetTableColumnsOutput,
): ContentBlock[] => {
  if (!result.success) {
    const errorMessage =
      result.error?.message || "Failed to get table columns";
    const errorDetails = result.error?.details
      ? `\n\nDetails:\n${JSON.stringify(result.error.details, null, 2)}`
      : "";
    return [{ type: "text", text: `Error: ${errorMessage}${errorDetails}` }];
  }

  const resultJson = JSON.stringify(result.data, null, 2);
  return [
    {
      type: "text",
      text: `Found ${result.rowCount} columns.\nExecution time: ${result.executionTime}ms\n\nColumns:\n${resultJson}`,
    },
  ];
};

// =============================================================================
// Tool Definition
// =============================================================================

export const getTableColumnsTool = defineTool({
  name: "get_table_columns",
  title: "Get Table Columns",
  description:
    "Get column details for a table including name, data type, length, nullable, default value, and description. Use this to understand table structure before writing queries.",
  inputSchema: GetTableColumnsInputSchema,
  outputSchema: GetTableColumnsOutputSchema,
  logic: getTableColumnsLogic,
  responseFormatter: getTableColumnsResponseFormatter,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
});

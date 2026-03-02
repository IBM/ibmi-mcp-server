/**
 * List Tables in Schema Tool
 *
 * Lists tables, views, and physical files in a specific schema with metadata
 * including row counts. Promoted from YAML tool definition.
 *
 * @module listTablesInSchema.tool
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

const ListTablesInputSchema = z.object({
  schema_name: z
    .string()
    .min(1, "Schema name cannot be empty.")
    .max(128, "Schema name cannot exceed 128 characters.")
    .describe(
      "Schema name to list tables from (e.g., 'QIWS', 'SAMPLE', 'MYLIB')",
    ),
  table_filter: z
    .string()
    .max(128, "Table filter cannot exceed 128 characters.")
    .default("*ALL")
    .describe(
      "Filter tables by name pattern (e.g., 'CUST%', 'ORD%'). Use '*ALL' for all tables.",
    ),
});

const ListTablesOutputSchema = z.object({
  success: z.boolean().describe("Whether the query executed successfully."),
  data: z
    .array(
      z.object({
        TABLE_SCHEMA: z.string().describe("Schema containing the table"),
        TABLE_NAME: z.string().describe("Table name"),
        TABLE_TYPE: z
          .string()
          .describe("Table type: T=Table, V=View, P=Physical file"),
        TABLE_TEXT: z.string().nullable().describe("Table description"),
        NUMBER_ROWS: z.number().describe("Number of rows in the table"),
        COLUMN_COUNT: z.number().nullable().describe("Number of columns"),
      }),
    )
    .optional()
    .describe("Array of table records."),
  rowCount: z.number().optional().describe("Number of tables returned."),
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

type ListTablesInput = z.infer<typeof ListTablesInputSchema>;
type ListTablesOutput = z.infer<typeof ListTablesOutputSchema>;

// =============================================================================
// Business Logic
// =============================================================================

async function listTablesLogic(
  params: ListTablesInput,
  appContext: RequestContext,
  _sdkContext: SdkContext,
): Promise<ListTablesOutput> {
  logger.debug(
    { ...appContext, toolInput: params },
    "Processing list tables in schema logic.",
  );

  const startTime = Date.now();

  const sql = `
    SELECT T.TABLE_SCHEMA,
           T.TABLE_NAME,
           T.TABLE_TYPE,
           T.TABLE_TEXT,
           COALESCE(S.NUMBER_ROWS, 0) AS NUMBER_ROWS,
           T.COLUMN_COUNT
    FROM QSYS2.SYSTABLES T
    LEFT JOIN QSYS2.SYSTABLESTAT S
      ON T.TABLE_SCHEMA = S.TABLE_SCHEMA
      AND T.TABLE_NAME = S.TABLE_NAME
    WHERE T.TABLE_SCHEMA = UPPER(?)
      AND T.TABLE_TYPE IN ('T', 'V', 'P')
      AND (? = '*ALL' OR T.TABLE_NAME LIKE UPPER(?))
    ORDER BY T.TABLE_TYPE, T.TABLE_NAME
    FETCH FIRST 200 ROWS ONLY
  `.trim();

  try {
    const result = await IBMiConnectionPool.executeQuery(
      sql,
      [params.schema_name, params.table_filter, params.table_filter],
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

    const typedData = result.data as ListTablesOutput["data"];

    return {
      success: true,
      data: typedData,
      rowCount: typedData?.length ?? 0,
      executionTime,
    };
  } catch (error) {
    const executionTime = Date.now() - startTime;

    logger.error(
      {
        ...appContext,
        error: error instanceof Error ? error.message : String(error),
        schema: params.schema_name,
        executionTime,
      },
      "List tables query failed.",
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
        message: `Failed to list tables: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
}

// =============================================================================
// Response Formatter
// =============================================================================

const listTablesResponseFormatter = (
  result: ListTablesOutput,
): ContentBlock[] => {
  if (!result.success) {
    const errorMessage =
      result.error?.message || "Failed to list tables in schema";
    const errorDetails = result.error?.details
      ? `\n\nDetails:\n${JSON.stringify(result.error.details, null, 2)}`
      : "";
    return [{ type: "text", text: `Error: ${errorMessage}${errorDetails}` }];
  }

  const resultJson = JSON.stringify(result.data, null, 2);
  return [
    {
      type: "text",
      text: `Found ${result.rowCount} tables.\nExecution time: ${result.executionTime}ms\n\nTables:\n${resultJson}`,
    },
  ];
};

// =============================================================================
// Tool Definition
// =============================================================================

export const listTablesInSchemaTool = defineTool({
  name: "list_tables_in_schema",
  title: "List Tables in Schema",
  description:
    "List tables, views, and physical files in a specific schema with metadata including row counts. Essential for understanding schema structure.",
  inputSchema: ListTablesInputSchema,
  outputSchema: ListTablesOutputSchema,
  logic: listTablesLogic,
  responseFormatter: listTablesResponseFormatter,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
});

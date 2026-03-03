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
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .default(50)
    .describe(
      "Maximum number of rows to return per page (1-500, default 50).",
    ),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("Number of rows to skip for pagination (default 0)."),
});

const ListTablesOutputSchema = z.object({
  success: z.boolean().describe("Whether the query executed successfully."),
  data: z
    .array(z.record(z.unknown()))
    .optional()
    .describe(
      "Array of table records. Each record contains: TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE (T=Table, V=View, P=Physical file), TABLE_TEXT, NUMBER_ROWS, COLUMN_COUNT.",
    ),
  rowCount: z.number().optional().describe("Number of tables returned."),
  hasMore: z
    .boolean()
    .optional()
    .describe("Whether more results exist beyond this page."),
  limit: z.number().optional().describe("Page size used for this request."),
  offset: z.number().optional().describe("Offset used for this request."),
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
    OFFSET ? ROWS FETCH FIRST ? ROWS ONLY
  `.trim();

  // Fetch limit+1 to detect if more rows exist beyond this page
  const fetchLimit = params.limit + 1;

  try {
    const result = await IBMiConnectionPool.executeQuery(
      sql,
      [params.schema_name, params.table_filter, params.table_filter, params.offset, fetchLimit],
      appContext,
    );

    const executionTime = Date.now() - startTime;

    if (!result.data) {
      return {
        success: true,
        data: [],
        rowCount: 0,
        hasMore: false,
        limit: params.limit,
        offset: params.offset,
        executionTime,
      };
    }

    const typedData = result.data as ListTablesOutput["data"];

    // Detect if more rows exist beyond this page
    const hasMore = (typedData?.length ?? 0) > params.limit;
    if (hasMore && typedData) {
      typedData.pop(); // Remove the extra detection row
    }

    return {
      success: true,
      data: typedData,
      rowCount: typedData?.length ?? 0,
      hasMore,
      limit: params.limit,
      offset: params.offset,
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

  let paginationInfo = "";
  if (result.hasMore !== undefined) {
    paginationInfo = ` (offset ${result.offset}, limit ${result.limit}, hasMore: ${result.hasMore})`;
  }

  const resultJson = JSON.stringify(result.data, null, 2);
  return [
    {
      type: "text",
      text: `Found ${result.rowCount} tables${paginationInfo}.\nExecution time: ${result.executionTime}ms\n\nTables:\n${resultJson}`,
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
    "List tables, views, and physical files in a specific schema with metadata including row counts. Use after list_schemas to find tables before querying column details.",
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

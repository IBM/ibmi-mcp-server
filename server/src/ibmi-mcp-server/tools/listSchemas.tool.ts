/**
 * List Schemas Tool
 *
 * Lists available schemas/libraries on the IBM i system.
 * Part of the default text-to-SQL toolset.
 *
 * @module listSchemas.tool
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

const ListSchemasInputSchema = z.object({
  filter: z
    .string()
    .max(128, "Filter pattern cannot exceed 128 characters.")
    .optional()
    .describe(
      "Optional schema name pattern to filter results (e.g., 'MY%', 'LIB%'). Uses SQL LIKE syntax.",
    ),
  include_system: z
    .boolean()
    .default(false)
    .describe("Include system schemas (Q* and SYS* prefixed). Default: false."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .default(50)
    .describe("Maximum number of rows to return per page (1-500, default 50)."),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("Number of rows to skip for pagination (default 0)."),
});

const ListSchemasOutputSchema = z.object({
  success: z.boolean().describe("Whether the query executed successfully."),
  data: z
    .array(z.record(z.unknown()))
    .optional()
    .describe(
      "Array of schema records. Each record contains: SCHEMA_NAME, SCHEMA_TEXT, SYSTEM_SCHEMA_NAME, SCHEMA_SIZE.",
    ),
  rowCount: z.number().optional().describe("Number of schemas returned."),
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

type ListSchemasInput = z.infer<typeof ListSchemasInputSchema>;
type ListSchemasOutput = z.infer<typeof ListSchemasOutputSchema>;

// =============================================================================
// Business Logic
// =============================================================================

async function listSchemasLogic(
  params: ListSchemasInput,
  appContext: RequestContext,
  _sdkContext: SdkContext,
): Promise<ListSchemasOutput> {
  logger.debug(
    { ...appContext, toolInput: params },
    "Processing list schemas logic.",
  );

  const startTime = Date.now();

  // Build WHERE conditions dynamically
  const conditions: string[] = [];
  const bindParams: (string | number)[] = [];

  if (!params.include_system) {
    conditions.push(
      "SCHEMA_NAME NOT LIKE 'Q%' AND SCHEMA_NAME NOT LIKE 'SYS%'",
    );
  }

  if (params.filter) {
    conditions.push("SCHEMA_NAME LIKE UPPER(?)");
    bindParams.push(params.filter);
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const sql = `
    SELECT SCHEMA_NAME,
           SCHEMA_TEXT,
           SYSTEM_SCHEMA_NAME,
           SCHEMA_SIZE
    FROM QSYS2.SYSSCHEMAS
    ${whereClause}
    ORDER BY SCHEMA_NAME
    OFFSET ? ROWS FETCH FIRST ? ROWS ONLY
  `.trim();

  // Fetch limit+1 to detect if more rows exist beyond this page
  const fetchLimit = params.limit + 1;
  bindParams.push(params.offset, fetchLimit);

  try {
    const result = await IBMiConnectionPool.executeQuery(
      sql,
      bindParams,
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

    const typedData = result.data as ListSchemasOutput["data"];

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
        executionTime,
      },
      "List schemas query failed.",
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
        message: `Failed to list schemas: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
}

// =============================================================================
// Response Formatter
// =============================================================================

const listSchemasResponseFormatter = (
  result: ListSchemasOutput,
): ContentBlock[] => {
  if (!result.success) {
    const errorMessage = result.error?.message || "Failed to list schemas";
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
      text: `Found ${result.rowCount} schemas${paginationInfo}.\nExecution time: ${result.executionTime}ms\n\nSchemas:\n${resultJson}`,
    },
  ];
};

// =============================================================================
// Tool Definition
// =============================================================================

export const listSchemasTool = defineTool({
  name: "list_schemas",
  title: "List Schemas",
  description:
    "List available schemas/libraries on the IBM i system. Use this as the first step in schema discovery to find which schemas contain relevant tables.",
  inputSchema: ListSchemasInputSchema,
  outputSchema: ListSchemasOutputSchema,
  logic: listSchemasLogic,
  responseFormatter: listSchemasResponseFormatter,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
});

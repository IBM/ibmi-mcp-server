/**
 * Get Related Objects Tool
 *
 * Discovers all objects that depend on a specified database file using
 * the SYSTOOLS.RELATED_OBJECTS table function. Returns views, indexes,
 * triggers, foreign keys, logical files, and other dependent objects.
 * Part of the default text-to-SQL toolset.
 *
 * @module getRelatedObjects.tool
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
// Constants
// =============================================================================

const VALID_OBJECT_TYPES = [
  "ALIAS",
  "FOREIGN KEY",
  "FUNCTION",
  "HISTORY TABLE",
  "INDEX",
  "KEYED LOGICAL FILE",
  "LOGICAL FILE",
  "MASK",
  "MATERIALIZED QUERY TABLE",
  "PERMISSION",
  "PROCEDURE",
  "TEXT INDEX",
  "TRIGGER",
  "VARIABLE",
  "VIEW",
  "XML SCHEMA",
] as const;

// =============================================================================
// Schemas
// =============================================================================

const GetRelatedObjectsInputSchema = z.object({
  library_name: z
    .string()
    .min(1, "Library name cannot be empty.")
    .max(10, "Library name cannot exceed 10 characters.")
    .describe("Library containing the database file (e.g., 'APPLIB', 'MYLIB')"),
  file_name: z
    .string()
    .min(1, "File name cannot be empty.")
    .max(10, "File name cannot exceed 10 characters.")
    .describe(
      "System name of the database file to find dependents for (e.g., 'ORDERS', 'CUSTOMER')",
    ),
  object_type_filter: z
    .enum(VALID_OBJECT_TYPES)
    .optional()
    .describe(
      "Optional: filter results to a specific dependent object type (e.g., 'INDEX', 'VIEW', 'TRIGGER'). Omit to return all types.",
    ),
});

const GetRelatedObjectsOutputSchema = z.object({
  success: z.boolean().describe("Whether the query executed successfully."),
  data: z
    .array(z.record(z.unknown()))
    .optional()
    .describe(
      "Array of dependent object records. Each record contains: SOURCE_SCHEMA_NAME, SOURCE_SQL_NAME (referenced object), SQL_OBJECT_TYPE (dependent type), SCHEMA_NAME, SQL_NAME (dependent object), LIBRARY_NAME, SYSTEM_NAME, OBJECT_OWNER, LONG_COMMENT, OBJECT_TEXT, LAST_ALTERED.",
    ),
  rowCount: z
    .number()
    .optional()
    .describe("Number of dependent objects returned."),
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

type GetRelatedObjectsInput = z.infer<typeof GetRelatedObjectsInputSchema>;
type GetRelatedObjectsOutput = z.infer<typeof GetRelatedObjectsOutputSchema>;

// =============================================================================
// Business Logic
// =============================================================================

async function getRelatedObjectsLogic(
  params: GetRelatedObjectsInput,
  appContext: RequestContext,
  _sdkContext: SdkContext,
): Promise<GetRelatedObjectsOutput> {
  logger.debug(
    { ...appContext, toolInput: params },
    "Processing get related objects logic.",
  );

  const startTime = Date.now();

  const bindParams: (string | number)[] = [
    params.library_name,
    params.file_name,
  ];

  const whereClause = params.object_type_filter
    ? "\n    WHERE SQL_OBJECT_TYPE = ?"
    : "";

  if (params.object_type_filter) {
    bindParams.push(params.object_type_filter);
  }

  const sql = `
    SELECT *
    FROM TABLE(SYSTOOLS.RELATED_OBJECTS(
      LIBRARY_NAME => ?,
      FILE_NAME => ?
    ))${whereClause}
    ORDER BY SQL_OBJECT_TYPE, SQL_NAME
  `.trim();

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
        executionTime,
      };
    }

    const typedData = result.data as GetRelatedObjectsOutput["data"];

    // Strip null/undefined values from each row to reduce response size
    const filteredData = typedData?.map((row) =>
      Object.fromEntries(Object.entries(row).filter(([, v]) => v != null)),
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
        library: params.library_name,
        file: params.file_name,
        executionTime,
      },
      "Get related objects query failed.",
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
        message: `Failed to get related objects: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
}

// =============================================================================
// Response Formatter
// =============================================================================

const getRelatedObjectsResponseFormatter = (
  result: GetRelatedObjectsOutput,
): ContentBlock[] => {
  if (!result.success) {
    const errorMessage =
      result.error?.message || "Failed to get related objects";
    const errorDetails = result.error?.details
      ? `\n\nDetails:\n${JSON.stringify(result.error.details, null, 2)}`
      : "";
    return [{ type: "text", text: `Error: ${errorMessage}${errorDetails}` }];
  }

  if (!result.data || result.data.length === 0) {
    return [
      {
        type: "text",
        text: `No dependent objects found.\nExecution time: ${result.executionTime}ms\n\nNote: Returns no results if the input is an SQL alias, program-described file, or does not exist.`,
      },
    ];
  }

  const resultJson = JSON.stringify(result.data, null, 2);
  return [
    {
      type: "text",
      text: `Found ${result.rowCount} dependent object(s).\nExecution time: ${result.executionTime}ms\n\nRelated objects:\n${resultJson}`,
    },
  ];
};

// =============================================================================
// Tool Definition
// =============================================================================

export const getRelatedObjectsTool = defineTool({
  name: "get_related_objects",
  title: "Get Related Objects",
  description:
    "Get all objects that depend on a database file — views, indexes, triggers, foreign keys, logical files, and more. Use for impact analysis before schema changes or to understand a table's dependency graph.",
  inputSchema: GetRelatedObjectsInputSchema,
  outputSchema: GetRelatedObjectsOutputSchema,
  logic: getRelatedObjectsLogic,
  responseFormatter: getRelatedObjectsResponseFormatter,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
});

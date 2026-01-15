/**
 * Generate SQL DDL Tool
 *
 * Generates SQL DDL statements for IBM i database objects using the QSYS2.GENERATE_SQL procedure.
 * Migrated from 3-file pattern to factory pattern.
 *
 * @module generateSql.tool
 * @feature 001-tool-factory
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
// Constants & Types
// =============================================================================

/**
 * Supported IBM i database object types for DDL generation.
 */
const OBJECT_TYPES = [
  "ALIAS",
  "CONSTRAINT",
  "FUNCTION",
  "INDEX",
  "MASK",
  "PERMISSION",
  "PROCEDURE",
  "SCHEMA",
  "SEQUENCE",
  "TABLE",
  "TRIGGER",
  "TYPE",
  "VARIABLE",
  "VIEW",
  "XSR",
] as const;

// =============================================================================
// Schemas
// =============================================================================

/**
 * Input schema for generating SQL DDL.
 */
const GenerateSqlInputSchema = z.object({
  object_name: z
    .string()
    .min(1, "Object name cannot be empty.")
    .max(128, "Object name cannot exceed 128 characters.")
    .describe("The name of the IBM i database object to generate DDL for."),
  object_library: z
    .string()
    .min(1, "Library name cannot be empty.")
    .max(128, "Library name cannot exceed 128 characters.")
    .default("QSYS2")
    .describe(
      "The library where the database object is located. Defaults to QSYS2.",
    ),
  object_type: z
    .enum(OBJECT_TYPES)
    .default("TABLE")
    .describe(
      "The type of database object to generate DDL for. Valid types include TABLE, VIEW, INDEX, PROCEDURE, FUNCTION, etc.",
    ),
});

/**
 * Output schema for generated SQL DDL.
 */
const GenerateSqlOutputSchema = z.object({
  success: z.boolean().describe("Whether the DDL generation was successful."),
  sql: z
    .string()
    .optional()
    .describe(
      "The generated DDL SQL statements for the specified database object.",
    ),
  object_name: z
    .string()
    .describe("The name of the object the DDL was generated for."),
  object_library: z
    .string()
    .describe("The library of the object the DDL was generated for."),
  object_type: z
    .string()
    .describe("The type of the object the DDL was generated for."),
  executionTime: z
    .number()
    .optional()
    .describe("DDL generation execution time in milliseconds."),
  error: z
    .object({
      code: z.string().describe("Error code"),
      message: z.string().describe("Error message"),
      details: z.record(z.unknown()).optional().describe("Error details"),
    })
    .optional()
    .describe("Error information if the DDL generation failed."),
});

type GenerateSqlInput = z.infer<typeof GenerateSqlInputSchema>;
type GenerateSqlOutput = z.infer<typeof GenerateSqlOutputSchema>;

// =============================================================================
// Business Logic
// =============================================================================

/**
 * Core logic for generating SQL DDL.
 * Calls the QSYS2.GENERATE_SQL procedure to generate DDL for IBM i database objects.
 */
async function generateSqlLogic(
  params: GenerateSqlInput,
  appContext: RequestContext,
  _sdkContext: SdkContext,
): Promise<GenerateSqlOutput> {
  logger.debug(
    { ...appContext, toolInput: params },
    "Processing generate SQL DDL logic.",
  );

  const sql = `CALL QSYS2.GENERATE_SQL(
    DATABASE_OBJECT_NAME => ?,
    DATABASE_OBJECT_LIBRARY_NAME => ?,
    DATABASE_OBJECT_TYPE => ?,
    CREATE_OR_REPLACE_OPTION => '1',
    PRIVILEGES_OPTION => '0',
    STATEMENT_FORMATTING_OPTION => '0',
    SOURCE_STREAM_FILE_END_OF_LINE => 'LF',
    SOURCE_STREAM_FILE_CCSID => 1208
  )`;

  const startTime = Date.now();

  try {
    // Execute the GENERATE_SQL procedure using pagination to get all results
    const result = await IBMiConnectionPool.executeQueryWithPagination(
      sql,
      [params.object_name, params.object_library, params.object_type],
      appContext,
      500, // Fetch 500 rows at a time
    );

    const executionTime = Date.now() - startTime;

    if (!result.success) {
      // Return error response that matches schema
      return {
        success: false,
        object_name: params.object_name,
        object_library: params.object_library,
        object_type: params.object_type,
        executionTime,
        error: {
          code: String(JsonRpcErrorCode.DatabaseError),
          message: "SQL DDL generation failed",
          details: {
            sqlReturnCode: result.sql_rc,
          },
        },
      };
    }

    // Process the result data to extract the generated DDL
    let generatedSql = "";

    if (result.data && Array.isArray(result.data)) {
      logger.debug(
        {
          ...appContext,
          totalRows: result.data.length,
          firstRowKeys: result.data[0] ? Object.keys(result.data[0]) : [],
        },
        "Processing GENERATE_SQL result data.",
      );

      // Build the result string from the SRCDTA column
      const resultStrings: string[] = [];
      for (const res of result.data) {
        if (res && typeof res === "object" && "SRCDTA" in res) {
          const srcData = (res as Record<string, unknown>).SRCDTA;
          if (srcData && typeof srcData === "string") {
            resultStrings.push(srcData);
          }
        }
      }
      generatedSql = resultStrings.join("\n");

      logger.debug(
        {
          ...appContext,
          processedRows: resultStrings.length,
          totalDdlLength: generatedSql.length,
          avgRowLength:
            resultStrings.length > 0
              ? Math.round(generatedSql.length / resultStrings.length)
              : 0,
        },
        "DDL extraction completed.",
      );
    }

    if (!generatedSql || generatedSql.trim().length === 0) {
      // Return error response that matches schema
      return {
        success: false,
        object_name: params.object_name,
        object_library: params.object_library,
        object_type: params.object_type,
        executionTime,
        error: {
          code: String(JsonRpcErrorCode.DatabaseError),
          message: "No SQL DDL generated for the specified object",
          details: {
            resultRowCount: result.data?.length || 0,
          },
        },
      };
    }

    const response: GenerateSqlOutput = {
      success: true,
      sql: generatedSql.trim(),
      object_name: params.object_name,
      object_library: params.object_library,
      object_type: params.object_type,
      executionTime,
    };

    logger.debug(
      {
        ...appContext,
        objectName: params.object_name,
        objectLibrary: params.object_library,
        objectType: params.object_type,
        sqlLength: response.sql?.length || 0,
        executionTime,
        rowCount: result.data?.length || 0,
      },
      "SQL DDL generated successfully.",
    );

    return response;
  } catch (error) {
    const executionTime = Date.now() - startTime;

    logger.error(
      {
        ...appContext,
        error: error instanceof Error ? error.message : String(error),
        objectName: params.object_name,
        objectLibrary: params.object_library,
        objectType: params.object_type,
        executionTime,
      },
      "SQL DDL generation failed.",
    );

    // Return error response that matches schema instead of throwing
    if (error instanceof McpError) {
      return {
        success: false,
        object_name: params.object_name,
        object_library: params.object_library,
        object_type: params.object_type,
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
      object_name: params.object_name,
      object_library: params.object_library,
      object_type: params.object_type,
      executionTime,
      error: {
        code: String(JsonRpcErrorCode.DatabaseError),
        message: `SQL DDL generation failed: ${error instanceof Error ? error.message : String(error)}`,
        details: {
          originalError: error instanceof Error ? error.name : "Unknown",
        },
      },
    };
  }
}

// =============================================================================
// Custom Response Formatter
// =============================================================================

const generateSqlResponseFormatter = (
  result: GenerateSqlOutput,
): ContentBlock[] => {
  if (!result.success) {
    // Format error response
    const errorMessage = result.error?.message || "SQL DDL generation failed";
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

  // Format success response
  return [
    {
      type: "text",
      text: `Successfully generated SQL DDL for ${result.object_type} '${result.object_name}' in library '${result.object_library}':\n\n${result.sql}`,
    },
  ];
};

// =============================================================================
// Tool Definition
// =============================================================================

export default defineTool({
  name: "describe_sql_object",
  title: "Generate SQL DDL",
  description:
    "Describes IBM i database objects by generating their SQL DDL statements. Useful for understanding object structure and recreating objects.",
  inputSchema: GenerateSqlInputSchema,
  outputSchema: GenerateSqlOutputSchema,
  logic: generateSqlLogic,
  responseFormatter: generateSqlResponseFormatter,
  annotations: {
    readOnlyHint: true, // Generates DDL which is descriptive, not modifying
    destructiveHint: false,
    openWorldHint: false,
  },
});

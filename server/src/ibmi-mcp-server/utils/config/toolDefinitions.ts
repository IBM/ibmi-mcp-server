/**
 * @fileoverview Defines the standard structure for a declarative tool definition.
 * This interface ensures that all tools provide the necessary metadata (name, schemas)
 * and logic in a consistent, self-contained format, aligned with MCP specifications.
 * @module src/mcp-server/tools/utils/toolDefinition
 */
import {
  CallToolResult,
  type ContentBlock,
} from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodObject, type ZodRawShape } from "zod";

import type { RequestContext } from "@/utils/index.js";
import {
  ErrorHandler,
  getRequestContext,
  measureToolExecution,
  requestContextService,
  withRequestContext,
} from "@/utils/internal/index.js";
import { JsonRpcErrorCode, McpError } from "@/types-global/errors.js";

// Import shared schemas from centralized location
import {
  StandardSqlToolOutputSchema,
  ToolAnnotations,
  StandardSqlToolOutput,
} from "@/ibmi-mcp-server/schemas/index.js";

// Import formatting utilities
import {
  markdown,
  tableFormatter,
  buildColumnAlignmentMap,
  formatColumnHeader,
  type TableStyle,
} from "@/utils/formatting/index.js";

/**
 * Represents the complete, self-contained definition of an MCP tool.
 */
export interface ToolDefinition<
  TInputSchema extends ZodObject<ZodRawShape>,
  TOutputSchema extends ZodObject<ZodRawShape>,
> {
  /**
   * The programmatic, unique name for the tool (e.g., 'echo_message').
   */
  name: string;
  /**
   * An optional, human-readable title for the tool. This is preferred for display in UIs.
   * If not provided, the `name` or `annotations.title` may be used as a fallback.
   */
  title?: string;
  /**
   * A clear, concise description of what the tool does.
   * This is sent to the LLM to help it decide when to use the tool.
   */
  description: string;
  /**
   * The Zod schema for validating the tool's input parameters.
   */
  inputSchema: TInputSchema;
  /**
   * The Zod schema for validating the tool's successful output structure.
   */
  outputSchema: TOutputSchema;
  /**
   * Optional metadata providing hints about the tool's behavior.
   */
  annotations?: ToolAnnotations;
  /**
   * The core business logic function for the tool.
   * It receives validated input and returns a structured output or throws an McpError.
   * @param input The validated tool input.
   * @param context The request context for logging and tracing.
   * @returns A promise that resolves with the structured output.
   */
  logic: (
    input: z.infer<TInputSchema>,
    context: RequestContext,
  ) => Promise<z.infer<TOutputSchema>>;
  /**
   * An optional function to format the successful output into an array of ContentBlocks
   * for the `CallToolResult`. If not provided, a default JSON stringifier is used.
   * @param result The successful output from the logic function.
   * @returns An array of ContentBlocks to be sent to the client.
   */
  responseFormatter?: (result: z.infer<TOutputSchema>) => ContentBlock[];
}

// Re-export standardized SQL tool output schema from centralized schemas
export const standardSqlToolOutputSchema = StandardSqlToolOutputSchema;

/**
 * Configuration options for SQL response formatting.
 */
export interface SqlFormatterConfig {
  /**
   * Table formatting style (default: 'markdown').
   */
  tableFormat?: TableStyle;

  /**
   * Maximum number of rows to display (default: 100).
   */
  maxDisplayRows?: number;
}

/**
 * Formats SQL tool output into a professionally formatted markdown response.
 * Uses MarkdownBuilder for structure and TableFormatter for type-aware table rendering.
 * Provides column type indicators, NULL tracking, and performance metrics.
 *
 * @param result - The SQL tool execution result
 * @param config - Optional formatting configuration
 * @returns Array of content blocks for MCP response
 *
 * @example
 * ```typescript
 * const result = await executeSqlTool(params);
 * const formatted = sqlResponseFormatter(result, {
 *   tableFormat: 'grid',
 *   maxDisplayRows: 50
 * });
 * ```
 */
export const sqlResponseFormatter = (
  result: StandardSqlToolOutput,
  config?: SqlFormatterConfig,
): ContentBlock[] => {
  const tableFormat = config?.tableFormat || "markdown";
  const maxDisplayRows = config?.maxDisplayRows || 100;

  // Handle error cases
  if (!result.success || !result.data) {
    const errorMessage = result.error || "Unknown error occurred";
    const { metadata } = result;

    const errorBuilder = markdown()
      .alert("caution", "❌ SQL Query Failed")
      .blankLine();

    if (metadata?.toolName) {
      errorBuilder.keyValue("Tool", metadata.toolName);
    }

    errorBuilder.keyValue("Error", errorMessage);

    if (result.errorCode) {
      errorBuilder.keyValue("Error Code", String(result.errorCode));
    }

    if (metadata?.sqlStatement) {
      const truncatedSql =
        metadata.sqlStatement.length > 200
          ? metadata.sqlStatement.substring(0, 197) + "..."
          : metadata.sqlStatement;
      errorBuilder
        .blankLine()
        .h3("SQL Statement")
        .codeBlock(truncatedSql, "sql");
    }

    const errorMarkdown = errorBuilder.build();

    return [{ type: "text", text: errorMarkdown }];
  }

  const { data, metadata } = result;
  const rowCount = data.length;

  // Start building the markdown response
  const mdBuilder = markdown();

  // Tool header
  if (metadata?.toolName) {
    mdBuilder.h2(metadata.toolName);
  }

  // Success indicator
  mdBuilder
    .alert("tip", "✅ Query completed successfully")
    .blankLine()
    .paragraph(
      `Found **${rowCount} row${rowCount !== 1 ? "s" : ""}** from the database query`,
    );

  // SQL Statement section
  if (metadata?.sqlStatement) {
    const truncatedSql =
      metadata.sqlStatement.length > 500
        ? metadata.sqlStatement.substring(0, 497) + "..."
        : metadata.sqlStatement;
    mdBuilder.h3("SQL Statement").codeBlock(truncatedSql, "sql");
  }

  // Parameters section
  if (metadata?.parameters && Object.keys(metadata.parameters).length > 0) {
    mdBuilder.h3("Parameters");
    const paramList = Object.entries(metadata.parameters).map(
      ([key, value]) => {
        const displayValue =
          value === null || value === undefined
            ? "NULL"
            : typeof value === "string" && value.length > 100
              ? `${String(value).substring(0, 97)}...`
              : String(value);
        return `\`${key}\`: ${displayValue}`;
      },
    );
    mdBuilder.list(paramList);
  }

  // Handle empty results
  if (rowCount === 0) {
    mdBuilder
      .paragraph("No rows returned from the query.")
      .h3("Execution Summary")
      .keyValue(
        "Execution time",
        metadata?.executionTime ? `${metadata.executionTime}ms` : "N/A",
      )
      .keyValue("Parameters used", String(metadata?.parameterCount || 0));

    return [{ type: "text", text: mdBuilder.build() }];
  }

  // Extract column information
  const columns = metadata?.columns || [];
  const firstRow = data[0] || {};
  const allColumns =
    columns.length > 0
      ? columns
      : Object.keys(firstRow).map((key) => ({
          name: key,
          type: undefined,
          label: key,
        }));

  // Prepare data for table formatter
  const displayRows = data.slice(0, maxDisplayRows);
  const columnCount = allColumns.length;

  // Format headers with type indicators
  const headers = allColumns.map((col) =>
    formatColumnHeader(col.label || col.name, col.type),
  );

  // Build column alignment map based on types
  const alignment = buildColumnAlignmentMap(allColumns);

  // Convert data rows to string arrays
  const rows = displayRows.map((row) =>
    allColumns.map((col) => {
      const value = row[col.name];
      if (value === null || value === undefined) return null;
      return String(value);
    }),
  );

  // Format table with metadata tracking
  const tableResult = tableFormatter.formatRawWithMetadata(headers, rows, {
    style: tableFormat,
    alignment,
    nullReplacement: "-",
    maxWidth: 50,
    truncate: true,
  });

  // Add truncation notice if applicable
  if (displayRows.length < rowCount) {
    mdBuilder.alert(
      "note",
      `Showing ${displayRows.length} of ${rowCount} rows. ${rowCount - displayRows.length} rows omitted.`,
    );
  }

  // Results section
  mdBuilder.h3("Results").raw(tableResult.table);

  // NULL value summary (only if there are NULLs)
  const nullCounts = tableResult.metadata.nullCounts;
  const totalNulls = Object.values(nullCounts).reduce(
    (sum, count) => sum + count,
    0,
  );

  // Summary section
  const summaryItems: string[] = [
    `**Total rows**: ${rowCount}`,
    `**Columns**: ${columnCount}`,
  ];

  if (metadata?.executionTime) {
    summaryItems.push(`**Execution time**: ${metadata.executionTime}ms`);
  }

  if (totalNulls > 0) {
    const nullDetails = Object.entries(nullCounts)
      .filter(([, count]) => count > 0)
      .map(([col, count]) => {
        // Convert column index to name for display
        const colIndex = parseInt(col);
        const colName = isNaN(colIndex)
          ? col
          : allColumns[colIndex]?.name || col;
        return `${colName} (${count})`;
      })
      .join(", ");
    summaryItems.push(`**NULL values**: ${totalNulls} total - ${nullDetails}`);
  }

  if (metadata?.affectedRows !== undefined) {
    summaryItems.push(`**Affected rows**: ${metadata.affectedRows}`);
  }

  if (metadata?.parameterCount) {
    summaryItems.push(`**Parameters processed**: ${metadata.parameterCount}`);
  }

  mdBuilder.h3("Summary").list(summaryItems);

  return [{ type: "text", text: mdBuilder.build() }];
};

/**
 * Formats successful SQL tool output into a text block that highlights
 * row counts and execution timing for quick operator feedback.
 */
// Default formatter for successful responses (fallback)
export const defaultResponseFormatter = (result: unknown): ContentBlock[] => [
  { type: "text", text: JSON.stringify(result, null, 2) },
];

/**
 * Creates an MCP-compatible handler from a declarative tool definition.
 * Handles input validation, performance measurement, standardized error
 * formatting, and context propagation.
 */
export function createHandlerFromDefinition<
  TInputSchema extends ZodObject<ZodRawShape>,
  TOutputSchema extends ZodObject<ZodRawShape>,
>(definition: ToolDefinition<TInputSchema, TOutputSchema>) {
  return async (
    rawParams: unknown,
    mcpContext: Record<string, unknown>,
  ): Promise<CallToolResult> => {
    const handlerContext = requestContextService.createRequestContext({
      parentContext: mcpContext,
      operation: `tool:${definition.name}`,
      toolName: definition.name,
    });

    return withRequestContext(handlerContext, async () => {
      try {
        const validatedInput = definition.inputSchema.parse(
          rawParams ?? {},
        ) as z.infer<TInputSchema>;

        const result = await measureToolExecution(
          definition.name,
          () => definition.logic(validatedInput, handlerContext),
          validatedInput,
        );

        const output = definition.outputSchema.parse(result);
        const contentBlocks = definition.responseFormatter
          ? definition.responseFormatter(output)
          : defaultResponseFormatter(output);

        return {
          content: contentBlocks,
          structuredContent: output,
        } satisfies CallToolResult;
      } catch (error) {
        const capturedContext =
          getRequestContext() ?? handlerContext ?? undefined;
        const handledError = ErrorHandler.handleError(error, {
          operation: `tool:${definition.name}`,
          context: capturedContext,
          input: rawParams,
          errorCode: error instanceof McpError ? error.code : undefined,
        });

        const mcpError =
          handledError instanceof McpError
            ? handledError
            : new McpError(
                JsonRpcErrorCode.InternalError,
                handledError instanceof Error
                  ? handledError.message
                  : String(handledError),
              );

        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error executing '${definition.name}': ${mcpError.message}`,
            },
          ],
          structuredContent: {
            success: false,
            data: [],
            error: mcpError.message,
            errorCode: mcpError.code,
            errorDetails: mcpError.details,
          },
        } satisfies CallToolResult;
      }
    });
  };
}

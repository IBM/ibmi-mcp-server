/**
 * @fileoverview Tool runtime schema definitions
 * Zod schemas for tool execution, responses, and runtime configurations
 *
 * @module src/ibmi-mcp-server/schemas/tools
 */

import { z } from "zod";
import { ColumnDefinitionSchema } from "./common.js";

/**
 * Standardized output schema for SQL-based MCP tools.
 * Ensures a consistent shape across all generated tool definitions.
 */
export const StandardSqlToolOutputSchema = z
  .object({
    success: z.boolean().describe("Whether the SQL execution succeeded"),

    data: z.array(z.record(z.any())).describe("Rows returned by the SQL query"),

    error: z.string().optional().describe("Error message when execution fails"),

    errorCode: z
      .union([z.string(), z.number()])
      .optional()
      .describe("Machine-readable error code when execution fails"),

    errorDetails: z
      .unknown()
      .optional()
      .describe("Any additional diagnostic information about failures"),

    metadata: z
      .object({
        executionTime: z
          .number()
          .optional()
          .describe("Execution duration in milliseconds"),

        rowCount: z.number().optional().describe("Row count returned"),

        affectedRows: z
          .number()
          .optional()
          .describe("Number of rows affected for write operations"),

        columns: z
          .array(ColumnDefinitionSchema)
          .optional()
          .describe("Column metadata for the result set"),

        parameterMode: z
          .string()
          .optional()
          .describe("Parameter binding mode used during execution"),

        parameterCount: z
          .number()
          .optional()
          .describe("Number of parameters bound to the query"),

        processedParameters: z
          .array(z.string())
          .optional()
          .describe("Ordered list of parameter names processed during binding"),

        toolName: z
          .string()
          .optional()
          .describe("Name of the tool that executed this query"),

        sqlStatement: z
          .string()
          .optional()
          .describe("The SQL statement that was executed"),

        parameters: z
          .record(z.unknown())
          .optional()
          .describe("Parameters passed to the query"),
      })
      .optional()
      .describe("Execution metadata including performance and parameters"),
  })
  .strict()
  .describe("Standard SQL execution payload");

/**
 * SQL tool execution result schema aligned with standard tool responses
 */
export const SqlToolExecutionResultSchema = z
  .object({
    data: z.array(z.unknown()).describe("Query result data"),

    rowCount: z.number().describe("Number of rows returned"),

    affectedRows: z
      .number()
      .optional()
      .describe("Number of rows affected (for non-SELECT operations)"),

    columns: z
      .array(ColumnDefinitionSchema)
      .optional()
      .describe("Column metadata information"),

    executionTime: z.number().describe("Execution time in milliseconds"),

    parameterMetadata: z
      .object({
        mode: z.string().describe("Parameter binding mode"),
        parameterCount: z.number().describe("Number of parameters processed"),
        processedParameters: z
          .array(z.string())
          .describe("List of processed parameter names"),
      })
      .optional()
      .describe("Parameter processing metadata"),
  })
  .describe("SQL tool execution result structure");

/**
 * Tool processing result schema for configuration building
 */
export const ToolProcessingResultSchema = z
  .object({
    success: z.boolean().describe("Whether tool processing succeeded"),

    toolConfigs: z
      .array(z.unknown())
      .optional()
      .describe("Generated tool configurations (if successful)"),

    errors: z
      .array(z.string())
      .optional()
      .describe("Processing errors (if unsuccessful)"),

    stats: z
      .object({
        toolCount: z.number().describe("Number of tools processed"),
        sourceCount: z.number().describe("Number of sources referenced"),
        toolsetCount: z.number().describe("Number of toolsets created"),
        totalParameterCount: z
          .number()
          .describe("Total parameters across all tools"),
      })
      .optional()
      .describe("Processing statistics"),
  })
  .describe("Result of tool processing operation");

/**
 * Parsing result schema with validation information
 */
export const ParsingResultSchema = z
  .object({
    success: z.boolean().describe("Whether parsing was successful"),

    config: z
      .unknown()
      .optional()
      .describe("Parsed configuration (if successful)"),

    errors: z
      .array(z.string())
      .optional()
      .describe("Validation errors (if unsuccessful)"),

    processedTools: z
      .array(z.unknown())
      .optional()
      .describe("Processed tools ready for registration"),

    stats: z
      .object({
        sourceCount: z.number().describe("Number of sources in configuration"),
        toolCount: z.number().describe("Number of tools in configuration"),
        enabledToolCount: z
          .number()
          .optional()
          .describe("Number of enabled tools"),
        disabledToolCount: z
          .number()
          .optional()
          .describe("Number of disabled tools"),
        toolsetCount: z
          .number()
          .describe("Number of toolsets in configuration"),
        totalParameterCount: z
          .number()
          .describe("Total parameters across all tools"),
      })
      .optional()
      .describe("Statistics about the parsed configuration"),
  })
  .describe("Result of YAML configuration parsing");

// Inferred types for export
export type StandardSqlToolOutput = z.infer<typeof StandardSqlToolOutputSchema>;
export type SqlToolExecutionResult = z.infer<
  typeof SqlToolExecutionResultSchema
>;
export type ToolProcessingResult = z.infer<typeof ToolProcessingResultSchema>;
export type ParsingResult = z.infer<typeof ParsingResultSchema>;

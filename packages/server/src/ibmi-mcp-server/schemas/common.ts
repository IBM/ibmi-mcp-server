/**
 * @fileoverview Common schema definitions and utilities
 * Shared Zod schemas used across multiple modules in the IBM i MCP server
 *
 * @module src/ibmi-mcp-server/schemas/common
 */

import { z } from "zod";

/**
 * Response format options for SQL tools
 */
export const ResponseFormatSchema = z.enum(["json", "markdown"], {
  description: "Response format for SQL tool output",
});

/**
 * Common metadata schema for extensible objects
 */
export const MetadataSchema = z
  .record(z.unknown())
  .describe("Extensible metadata object for storing additional information");

/**
 * Tool annotation hints schema for MCP client behavior
 */
export const ToolAnnotationsSchema = z
  .object({
    /**
     * An optional human-readable name for the tool, optimized for UI display.
     */
    title: z
      .string()
      .optional()
      .describe("Human-readable tool title for UI display"),
    /**
     * A hint indicating that the tool does not modify any state.
     */
    readOnlyHint: z
      .boolean()
      .optional()
      .describe("Indicates the tool performs read-only operations"),
    /**
     * A hint indicating that the tool may interact with external systems.
     */
    openWorldHint: z
      .boolean()
      .optional()
      .describe(
        "Indicates the tool interacts with external, unpredictable systems",
      ),
    /**
     * Indicates that the tool has no side effects when called multiple times.
     */
    idempotentHint: z
      .boolean()
      .optional()
      .describe(
        "Indicates the tool produces consistent results for identical inputs",
      ),
    /**
     * Indicates that the tool may produce destructive side effects.
     */
    destructiveHint: z
      .boolean()
      .optional()
      .describe(
        "Indicates the tool may perform destructive or irreversible operations",
      ),
    /**
     * Domain classification for filtering and organization.
     */
    domain: z
      .string()
      .optional()
      .describe("Domain classification for client-side filtering"),
    /**
     * Category classification for filtering and organization.
     */
    category: z
      .string()
      .optional()
      .describe("Category classification for client-side filtering"),
    /**
     * Toolsets that the tool belongs to.
     */
    toolsets: z
      .array(z.string())
      .optional()
      .describe("Toolset memberships for client-side grouping"),
    /**
     * Additional custom metadata.
     */
    customMetadata: MetadataSchema.optional().describe(
      "Additional custom metadata for the tool",
    ),
  })
  .catchall(z.unknown())
  .describe("Tool annotations providing hints about tool behavior");

/**
 * Column definition schema for database result sets
 */
export const ColumnDefinitionSchema = z
  .object({
    name: z.string().describe("Column name as returned by the database"),
    type: z.string().optional().describe("Database reported data type"),
    label: z.string().optional().describe("Human-friendly label if provided"),
  })
  .describe("Database column metadata");

/**
 * Base parameter constraint schemas for reuse
 */
export const ParameterConstraintsSchema = z
  .object({
    min: z.number().optional().describe("Minimum value for numeric types"),
    max: z.number().optional().describe("Maximum value for numeric types"),
    minLength: z
      .number()
      .optional()
      .describe("Minimum length for string/array types"),
    maxLength: z
      .number()
      .optional()
      .describe("Maximum length for string/array types"),
    pattern: z
      .string()
      .optional()
      .describe("Regex pattern for string validation"),
  })
  .describe("Parameter validation constraints");

// Inferred types for export
export type ResponseFormat = z.infer<typeof ResponseFormatSchema>;
export type Metadata = z.infer<typeof MetadataSchema>;
export type ToolAnnotations = z.infer<typeof ToolAnnotationsSchema>;
export type ColumnDefinition = z.infer<typeof ColumnDefinitionSchema>;
export type ParameterConstraints = z.infer<typeof ParameterConstraintsSchema>;

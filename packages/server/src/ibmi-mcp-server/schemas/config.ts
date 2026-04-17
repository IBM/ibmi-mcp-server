/**
 * @fileoverview Configuration schema definitions
 * Zod schemas for validating YAML configurations, database sources, and tool definitions
 *
 * @module src/ibmi-mcp-server/schemas/config
 */

import { z } from "zod";
import {
  ResponseFormatSchema,
  MetadataSchema,
  ToolAnnotationsSchema,
} from "./common.js";

/**
 * SQL tool parameter schema for secure parameter binding
 * Supports enhanced parameter types with validation for :param and ? placeholders
 */
export const SqlToolParameterSchema = z
  .object({
    name: z
      .string()
      .min(1, "Parameter name cannot be empty")
      .describe("Parameter name used in SQL statement"),
    type: z
      .enum(["string", "boolean", "integer", "float", "array"])
      .describe("Parameter data type for validation"),
    description: z
      .string()
      .optional()
      .describe("Human-readable parameter description"),
    default: z
      .union([
        z.string(),
        z.number(),
        z.boolean(),
        z.array(z.unknown()),
        z.null(),
      ])
      .optional()
      .describe("Default value when parameter is not provided"),
    required: z
      .boolean()
      .optional()
      .describe("Whether parameter is required (overrides default)"),
    itemType: z
      .enum(["string", "boolean", "integer", "float"])
      .optional()
      .describe("Array item type (only for array parameters)"),
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
    enum: z
      .array(z.union([z.string(), z.number(), z.boolean()]))
      .optional()
      .describe("Valid values (enum validation)"),
    pattern: z
      .string()
      .optional()
      .describe("Custom validation pattern (regex for strings)"),
  })
  .describe("SQL tool parameter definition with validation constraints");

/**
 * Database source configuration schema
 * Supports IBM i DB2 connections with optional SSL configuration
 */
export const SourceConfigSchema = z
  .object({
    host: z
      .string()
      .min(1, "Host cannot be empty")
      .describe("Database host address"),
    user: z
      .string()
      .min(1, "User cannot be empty")
      .describe("Database user name"),
    password: z
      .string()
      .min(1, "Password cannot be empty")
      .describe("Database password"),
    port: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Database port (default: 8471 for IBM i)"),
    "ignore-unauthorized": z
      .boolean()
      .optional()
      .describe("Whether to ignore unauthorized SSL certificates"),
  })
  .describe("Database connection configuration");

/**
 * SQL tool security configuration schema
 */
export const SqlToolSecurityConfigSchema = z
  .object({
    readOnly: z
      .boolean()
      .optional()
      .describe(
        "Whether to restrict to read-only operations (default: true for safety)",
      ),
    maxQueryLength: z
      .number()
      .optional()
      .describe("Maximum SQL query length in characters (default: 10000)"),
    forbiddenKeywords: z
      .array(z.string())
      .optional()
      .describe("Additional forbidden SQL keywords beyond the default list"),
  })
  .describe("Security configuration for SQL tool execution");

/**
 * SQL tool configuration schema
 * Defines a single executable SQL tool with metadata
 */
export const SqlToolConfigSchema = z
  .object({
    enabled: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        "Whether this tool is enabled and should be registered (default: true)",
      ),
    source: z
      .string()
      .min(1, "Source reference cannot be empty")
      .describe("Source name to connect to (references source key)"),
    description: z
      .string()
      .min(1, "Tool description cannot be empty")
      .describe("Clear, concise description of what the tool does"),
    statement: z
      .string()
      .min(1, "SQL statement cannot be empty")
      .optional()
      .describe("SQL statement with parameter placeholders (:param or ?)"),
    parameters: z
      .array(SqlToolParameterSchema)
      .optional()
      .describe("Parameter definitions for secure binding"),
    domain: z.string().optional().describe("Optional domain categorization"),
    category: z.string().optional().describe("Optional category within domain"),
    metadata: MetadataSchema.optional().describe(
      "Optional tool-specific metadata",
    ),
    responseFormat: ResponseFormatSchema.optional().describe(
      "Response format (default: json)",
    ),
    annotations: ToolAnnotationsSchema.optional().describe(
      "Optional annotations for MCP clients",
    ),
    security: SqlToolSecurityConfigSchema.optional().describe(
      "Security configuration for tool execution",
    ),
    tableFormat: z
      .enum(["markdown", "ascii", "grid", "compact"])
      .optional()
      .default("markdown")
      .describe(
        "Table formatting style for SQL results (default: markdown). Options: markdown (GitHub-style), ascii (plain text), grid (Unicode boxes), compact (minimal spacing)",
      ),
    maxDisplayRows: z
      .number()
      .int()
      .min(1, "maxDisplayRows must be at least 1")
      .max(1000, "maxDisplayRows cannot exceed 1000")
      .optional()
      .default(100)
      .describe(
        "Maximum number of rows to display in result tables (default: 100). Rows beyond this limit will show a truncation message",
      ),

    // Legacy deprecated fields (for backward compatibility)
    readOnlyHint: z
      .boolean()
      .optional()
      .describe("@deprecated Use annotations.readOnlyHint instead"),
    destructiveHint: z
      .boolean()
      .optional()
      .describe("@deprecated Use annotations.destructiveHint instead"),
    idempotentHint: z
      .boolean()
      .optional()
      .describe("@deprecated Use annotations.idempotentHint instead"),
    openWorldHint: z
      .boolean()
      .optional()
      .describe("@deprecated Use annotations.openWorldHint instead"),
  })
  .describe("Individual SQL tool definition in YAML configuration");

/**
 * SQL toolset configuration schema
 * Groups of related tools for organization
 */
export const SqlToolsetConfigSchema = z
  .object({
    title: z.string().optional().describe("Human-readable toolset title"),
    description: z.string().optional().describe("Toolset description"),
    tools: z
      .array(z.string().min(1, "Tool name cannot be empty"))
      .min(1, "Toolset must contain at least one tool")
      .describe("List of tool names in this toolset"),
    metadata: MetadataSchema.optional().describe("Optional toolset metadata"),
  })
  .describe("Toolset definition for grouping related tools");

/**
 * TypeScript tool configuration schema
 * Defines how TypeScript-based tools are assigned to toolsets
 */
export const TypeScriptToolConfigSchema = z
  .object({
    domain: z
      .string()
      .describe("Tool domain (e.g., 'sysadmin', 'performance')"),
    category: z
      .string()
      .describe("Tool category (e.g., 'sql-generation', 'analysis')"),
    description: z.string().optional().describe("Tool description"),
    toolsets: z
      .array(z.string())
      .optional()
      .describe("List of specific toolsets this tool belongs to"),
    global: z
      .boolean()
      .optional()
      .describe("Whether this tool should be added to ALL toolsets"),
  })
  .describe("TypeScript tool configuration for toolset assignment");

/**
 * Complete SQL tools configuration schema
 * Root YAML configuration structure containing all sources, tools, and toolsets
 */
export const SqlToolsConfigSchema = z
  .object({
    sources: z
      .record(
        z.string().min(1, "Source name cannot be empty"),
        SourceConfigSchema,
      )
      .optional()
      .describe("Database sources configuration"),

    tools: z
      .record(
        z.string().min(1, "Tool name cannot be empty"),
        SqlToolConfigSchema,
      )
      .optional()
      .describe("Tool definitions (SQL tools with predefined statements)"),

    toolsets: z
      .record(
        z.string().min(1, "Toolset name cannot be empty"),
        SqlToolsetConfigSchema,
      )
      .optional()
      .describe("Toolset definitions"),

    typescript_tools: z
      .record(
        z.string().min(1, "TypeScript tool name cannot be empty"),
        TypeScriptToolConfigSchema,
      )
      .optional()
      .describe("TypeScript tool configurations"),

    metadata: MetadataSchema.optional().describe("Optional global metadata"),
  })
  .refine(
    (data) => {
      // Ensure at least one section exists
      return (
        data.sources || data.tools || data.toolsets || data.typescript_tools
      );
    },
    {
      message:
        "YAML file must contain at least one section: sources, tools, toolsets, or typescript_tools",
    },
  )
  .describe("Root YAML configuration structure");

// Inferred types for export
export type SqlToolParameter = z.infer<typeof SqlToolParameterSchema>;
export type SourceConfig = z.infer<typeof SourceConfigSchema>;
export type SqlToolSecurityConfig = z.infer<typeof SqlToolSecurityConfigSchema>;
export type SqlToolConfig = z.infer<typeof SqlToolConfigSchema>;
export type SqlToolsetConfig = z.infer<typeof SqlToolsetConfigSchema>;
export type TypeScriptToolConfig = z.infer<typeof TypeScriptToolConfigSchema>;
export type SqlToolsConfig = z.infer<typeof SqlToolsConfigSchema>;

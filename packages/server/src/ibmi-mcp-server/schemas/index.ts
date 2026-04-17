/**
 * @fileoverview Central schema registry
 * Single export point for all Zod schemas and inferred types used throughout the IBM i MCP server
 *
 * @module src/ibmi-mcp-server/schemas
 */

// Re-export all common schemas and types
export * from "./common.js";

// Re-export all configuration schemas and types
export * from "./config.js";

// Re-export all tool runtime schemas and types
export * from "./tools.js";

// Convenience re-exports for frequently used schemas
export {
  // Configuration schemas
  SqlToolsConfigSchema,
  SqlToolConfigSchema,
  SqlToolParameterSchema,
  SourceConfigSchema,

  // Inferred types
  type SqlToolsConfig,
  type SqlToolConfig,
  type SqlToolParameter,
  type SourceConfig,
  type SqlToolSecurityConfig,
  type SqlToolsetConfig,
  type TypeScriptToolConfig,
} from "./config.js";

export {
  // Runtime schemas
  StandardSqlToolOutputSchema,
  SqlToolExecutionResultSchema,

  // Inferred types
  type StandardSqlToolOutput,
  type SqlToolExecutionResult,
  type ToolProcessingResult,
  type ParsingResult,
} from "./tools.js";

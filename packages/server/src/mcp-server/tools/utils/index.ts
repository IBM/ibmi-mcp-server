/**
 * Tool utilities barrel file
 * Exports tool-related utilities and types
 */

// Export types
export type {
  ToolDefinition,
  ToolAnnotations,
  ToolLogicFn,
  SdkContext,
} from "./types.js";

// Export factory functions
export * from "./tool-factory.js";

// Soft-failure → McpError helpers (issue #205)
export * from "./toolSuccess.js";

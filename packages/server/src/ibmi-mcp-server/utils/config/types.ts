/**
 * @fileoverview Schema-derived type definitions
 * All types are inferred from Zod schemas to ensure consistency between validation and TypeScript types
 *
 * @module src/ibmi-mcp-server/utils/config/types
 */

import { z } from "zod";
import type { ToolDefinition } from "./toolDefinitions.js";
import { standardSqlToolOutputSchema } from "./toolDefinitions.js";
import type {
  SourceConfig,
  SqlToolConfig,
  SqlToolsConfig,
} from "@/ibmi-mcp-server/schemas/config.js";

/**
 * Configuration source specification
 */
export interface ConfigSource {
  /** Source type identifier */
  type: "file" | "directory" | "glob";
  /** Path or pattern */
  path: string;
  /** Optional base directory for relative paths */
  baseDir?: string;
  /** Whether this source is required */
  required?: boolean;
}

/**
 * Configuration build result
 */
export interface ConfigBuildResult {
  /** Whether build was successful */
  success: boolean;
  /** Merged configuration */
  config?: SqlToolsConfig;
  /** Build errors */
  errors?: string[];
  /** Build warnings */
  warnings?: string[];
  /** Build statistics */
  stats?: {
    sourcesLoaded: number;
    sourcesMerged: number;
    toolsTotal: number;
    toolsetsTotal: number;
    sourcesTotal: number;
  };
  /** Resolved file paths that contributed to this build */
  resolvedFilePaths?: string[];
}

/**
 * Processed tool information after YAML parsing
 * Includes resolved source and generated metadata
 */
export interface ProcessedSQLTool {
  /** Tool name */
  name: string;
  /** Tool configuration from YAML */
  config: SqlToolConfig;
  /** Resolved source configuration */
  source: SourceConfig;
  /** Toolsets this tool belongs to */
  toolsets: string[];
  /** Generated tool metadata compatible with existing system */
  metadata: {
    name: string;
    description: string;
    domain?: string;
    category?: string;
    toolsets: string[];
  };
}

/**
 * Cached tool configuration that contains all pre-processed data needed for fast registration
 */
export type SqlToolDefinition = ToolDefinition<
  z.ZodObject<Record<string, z.ZodTypeAny>>,
  typeof standardSqlToolOutputSchema
>;

export type CachedToolConfig = SqlToolDefinition;

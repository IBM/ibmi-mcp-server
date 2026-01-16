/**
 * @fileoverview Configuration resolver that combines base config with CLI arguments
 * Implements configuration precedence: CLI arguments > environment variables > defaults
 *
 * @module src/config/resolver
 */

import { config } from "./index.js";
import type { CliArguments } from "../ibmi-mcp-server/utils/cli/argumentParser.js";

// Extract the config type from the existing config object
type BaseConfig = typeof config;

// Create a resolved configuration type that includes the CLI-overridable fields
export interface ResolvedConfig extends Omit<
  BaseConfig,
  "mcpTransportType" | "selectedToolsets"
> {
  toolsYamlPath: string | undefined;
  mcpTransportType: "stdio" | "http";
  selectedToolsets?: string[];
}

/**
 * Resolves the final configuration by combining base config with CLI arguments
 * CLI arguments take precedence over environment variables and defaults
 *
 * @param cliArgs - Parsed CLI arguments
 * @returns Resolved configuration with CLI precedence applied
 */
export function resolveConfiguration(cliArgs: CliArguments): ResolvedConfig {
  // Start with base config as foundation
  const resolvedConfig: ResolvedConfig = {
    ...config,
    // Apply CLI argument precedence for specific fields
    toolsYamlPath:
      cliArgs.tools || process.env.TOOLS_YAML_PATH || config.toolsYamlPath,
    mcpTransportType:
      cliArgs.transport ||
      (config.mcpTransportType as "stdio" | "http") ||
      "stdio",
    selectedToolsets: cliArgs.toolsets,
  };

  return resolvedConfig;
}

/**
 * Applies CLI overrides directly to the global config object.
 * Mutates `config` so downstream modules that import it
 * immediately see the overridden values.
 *
 * Only overrides values that are explicitly provided via CLI.
 */
export function applyCliOverrides(cliArgs: CliArguments): void {
  if (cliArgs.tools) {
    config.toolsYamlPath = cliArgs.tools;
    // Optionally keep env in sync for any code reading from process.env later
    try {
      process.env.TOOLS_YAML_PATH = cliArgs.tools;
    } catch {
      // ignore env mutation failures in restricted environments
    }
  }

  if (cliArgs.transport) {
    config.mcpTransportType = cliArgs.transport;
    try {
      process.env.MCP_TRANSPORT_TYPE = cliArgs.transport;
    } catch {
      // ignore env mutation failures in restricted environments
    }
  }

  if (cliArgs.toolsets && cliArgs.toolsets.length > 0) {
    // Store selected toolsets in config for access by other modules
    config.selectedToolsets = cliArgs.toolsets;
  }
}

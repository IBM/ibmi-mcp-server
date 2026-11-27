/**
 * @fileoverview Configuration resolver that combines base config with CLI arguments
 * Implements configuration precedence: CLI arguments > environment variables > defaults
 *
 * @module src/config/resolver
 */

import { config } from "./index.js";
import type { CliArguments } from "../ibmi-mcp-server/utils/cli/argumentParser.js";

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

  if (cliArgs.builtinTools) {
    config.ibmi_enableDefaultTools = true;
  }

  if (cliArgs.executeSql) {
    config.ibmi_enableExecuteSql = true;
  }
}

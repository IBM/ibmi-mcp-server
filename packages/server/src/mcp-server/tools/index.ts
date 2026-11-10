/**
 * Tool Registration Entry Point
 *
 * Registers all factory pattern tools with the MCP server.
 * Each tool is registered directly using registerToolFromDefinition.
 *
 * @module tools
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { getAllToolDefinitions } from "@/ibmi-mcp-server/tools/index.js";
import { registerToolFromDefinition } from "./utils/tool-factory.js";
import { config } from "@/config/index.js";

/**
 * Registers all factory pattern tools with the MCP server.
 * Tools are defined by getAllToolDefinitions().
 */
export async function registerAllTools(server: McpServer): Promise<void> {
  // Evaluate tool definitions at registration time (not module load time)
  // so that CLI overrides like --builtin-tools are reflected.
  for (const toolDef of getAllToolDefinitions()) {
    if (
      toolDef.name === "execute_sql" &&
      !config.ibmi_enableExecuteSql &&
      !config.ibmi_enableDefaultTools
    ) {
      // execute_sql is off unless IBMI_ENABLE_EXECUTE_SQL or IBMI_ENABLE_DEFAULT_TOOLS is set
      continue;
    }
    await registerToolFromDefinition(server, toolDef);
  }
}

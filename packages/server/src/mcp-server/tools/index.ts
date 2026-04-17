/**
 * Tool Registration Entry Point
 *
 * Registers all factory pattern tools with the MCP server.
 * Each tool is registered directly using registerToolFromDefinition.
 *
 * @module tools
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getAllToolDefinitions } from "@/ibmi-mcp-server/tools/index.js";
import { registerToolFromDefinition } from "./utils/tool-factory.js";
import { logger, requestContextService } from "../../utils/index.js";
import {
  logOperationStart,
  logOperationSuccess,
} from "../../utils/internal/logging-helpers.js";
import { config } from "@/config/index.js";

/**
 * Registers all factory pattern tools with the MCP server.
 * Tools are defined by getAllToolDefinitions().
 */
export async function registerAllTools(server: McpServer): Promise<void> {
  const context = requestContextService.createRequestContext({
    operation: "RegisterAllTools",
  });

  // Evaluate tool definitions at registration time (not module load time)
  // so that CLI overrides like --builtin-tools are reflected.
  const toolDefinitions = getAllToolDefinitions();

  logOperationStart(
    context,
    `Registering ${toolDefinitions.length} factory pattern tools`,
  );

  for (const toolDef of toolDefinitions) {
    if (
      toolDef.name === "execute_sql" &&
      !config.ibmi_enableExecuteSql &&
      !config.ibmi_enableDefaultTools
    ) {
      // Skip execute_sql tool if disabled via both IBMI_ENABLE_EXECUTE_SQL and IBMI_ENABLE_DEFAULT_TOOLS
      logger.debug(
        context,
        "Skipping registration of execute_sql tool (IBMI_ENABLE_EXECUTE_SQL=false, IBMI_ENABLE_DEFAULT_TOOLS=false)",
      );
      continue;
    }
    await registerToolFromDefinition(server, toolDef);
  }

  logOperationSuccess(
    context,
    `Successfully registered ${toolDefinitions.length} factory pattern tools`,
  );
}

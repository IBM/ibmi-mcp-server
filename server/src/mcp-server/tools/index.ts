/**
 * Tool Registration Entry Point
 *
 * Registers all factory pattern tools with the MCP server.
 * Each tool is registered directly using registerToolFromDefinition.
 *
 * @module tools
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { allToolDefinitions } from "@/ibmi-mcp-server/tools/index.js";
import { registerToolFromDefinition } from "./utils/tool-factory.js";
import { logger, requestContextService } from "../../utils/index.js";
import {
  logOperationStart,
  logOperationSuccess,
} from "../../utils/internal/logging-helpers.js";
import { config } from "@/config/index.js";

/**
 * Registers all factory pattern tools with the MCP server.
 * Tools are defined in the allToolDefinitions array.
 */
export async function registerAllTools(server: McpServer): Promise<void> {
  const context = requestContextService.createRequestContext({
    operation: "RegisterAllTools",
  });

  logOperationStart(
    context,
    `Registering ${allToolDefinitions.length} factory pattern tools`,
  );

  for (const toolDef of allToolDefinitions) {
    if (toolDef.name === "execute_sql" && !config.ibmi_enableExecuteSql) {
      // Skip execute_sql tool if disabled via IBMI_ENABLE_EXECUTE_SQL
      logger.debug(
        context,
        "Skipping registration of execute_sql tool (IBMI_ENABLE_EXECUTE_SQL=false)",
      );
      continue;
    }
    await registerToolFromDefinition(server, toolDef);
  }

  logOperationSuccess(
    context,
    `Successfully registered ${allToolDefinitions.length} factory pattern tools`,
  );
}

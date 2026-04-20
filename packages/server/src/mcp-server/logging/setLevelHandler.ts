/**
 * @fileoverview Implements the MCP logging/setLevel request handler.
 * This module enables MCP clients (like Claude Desktop, Inspector) to dynamically
 * control the server's logging verbosity at runtime, per the MCP specification.
 *
 * MCP Specification Reference:
 * - Logging: https://modelcontextprotocol.io/specification/2025-03-26/server/utilities/logging
 *
 * @module src/mcp-server/logging/setLevelHandler
 * @see {@link https://github.com/modelcontextprotocol/inspector/issues/610} for context on this requirement
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SetLevelRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { logger } from "@/utils/internal/logger.js";
import type { McpLogLevel } from "@/utils/internal/logger.js";
import { requestContextService } from "@/utils/index.js";

/**
 * Registers the `logging/setLevel` request handler with the MCP server.
 *
 * This handler allows MCP clients to dynamically adjust the server's minimum
 * log level. When a client sends a `logging/setLevel` request, the server will:
 * 1. Validate the requested level (via Zod schema)
 * 2. Update the internal logger's minimum level
 * 3. Return an empty result to acknowledge the change
 *
 * Per the MCP specification, the server must respond with an empty result
 * object upon successful configuration.
 *
 * Supported log levels (per RFC 5424 syslog severity):
 * - debug, info, notice, warning, error, critical, alert, emergency
 *
 * @param server - The McpServer instance to attach the handler to
 *
 * @example
 * ```typescript
 * const server = new McpServer({ name: "my-server", version: "1.0.0" });
 * registerLoggingSetLevelHandler(server);
 * await server.connect(transport);
 * ```
 */
export function registerLoggingSetLevelHandler(server: McpServer): void {
  const context = requestContextService.createRequestContext({
    operation: "registerLoggingSetLevelHandler",
  });

  logger.debug(context, "Registering logging/setLevel request handler");

  server.server.setRequestHandler(SetLevelRequestSchema, async (request) => {
    const { level } = request.params;

    const handlerContext = requestContextService.createRequestContext({
      operation: "logging/setLevel",
      previousLevel: logger.pino.level,
      requestedLevel: level,
    });

    try {
      // Map MCP log level to our internal logger
      // The logger.setLevel method handles validation and mapping to Pino levels
      logger.setLevel(level as McpLogLevel);

      logger.info(
        {
          ...handlerContext,
          previousLevel: handlerContext.previousLevel,
          newLevel: level,
        },
        `Log level changed via MCP request`,
      );

      // Per MCP spec: "The server responds with an empty result,
      // confirming the logging level has been set."
      return {
        _meta: {},
      };
    } catch (error) {
      // Log the error but still return a valid response
      // The schema validation should catch invalid levels before we get here
      logger.error(
        {
          ...handlerContext,
          error: error instanceof Error ? error.message : String(error),
          requestedLevel: level,
        },
        "Failed to set log level",
      );

      // Still return success - the logger will log the validation error
      // This prevents clients from seeing failures for our internal issues
      return {
        _meta: {},
      };
    }
  });

  logger.debug(context, "logging/setLevel handler registered successfully");
}

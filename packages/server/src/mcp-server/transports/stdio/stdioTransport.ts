/**
 * @fileoverview Starts the stdio MCP transport.
 *
 * The SDK's `serveStdio` reads JSON-RPC messages from stdin and writes them
 * to stdout. The opening message selects the protocol era (2026-07-28 or a
 * 2025-era `initialize` handshake) and one server instance from the factory
 * is pinned for the life of the connection.
 *
 * stdout carries protocol bytes only; logging goes to files and stderr.
 * There is no authentication on stdio: the host application that launches
 * the process controls access to it.
 *
 * @module src/mcp-server/transports/stdioTransport
 */

import type { McpServerFactory } from "@modelcontextprotocol/server";
import {
  serveStdio,
  type StdioServerHandle,
} from "@modelcontextprotocol/server/stdio";
import { logger, RequestContext } from "../../../utils/index.js";
import { MCP_SPEC_VERSION } from "../../constants.js";

/**
 * Serves MCP over `process.stdin` / `process.stdout`.
 *
 * @param createServerInstance - Factory the SDK calls once per connection.
 * @param parentContext - The logging and tracing context from the calling function.
 * @returns The handle that closes the connection.
 */
export function startStdioTransport(
  createServerInstance: McpServerFactory,
  parentContext: RequestContext,
): StdioServerHandle {
  const context = {
    ...parentContext,
    operation: "startStdioTransport",
    transportType: "Stdio",
  };

  const handle = serveStdio(createServerInstance, {
    onerror: (error) =>
      logger.warning(
        { ...context, err: error },
        "Stdio transport reported an error.",
      ),
  });

  logger.info(context, "MCP Server listening via stdio transport.");
  if (process.stdout.isTTY) {
    console.log(
      `\n🚀 MCP Server running in STDIO mode.\n   (MCP Spec: ${MCP_SPEC_VERSION} Stdio Transport)\n`,
    );
  }
  return handle;
}

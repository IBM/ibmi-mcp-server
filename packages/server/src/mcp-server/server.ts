/**
 * @fileoverview Builds MCP server instances and starts the configured transport.
 *
 * The server is stateless: `createMcpServerInstance` is a factory the SDK calls
 * once per HTTP request (`createMcpHandler`) or once per stdio connection
 * (`serveStdio`). Both entries serve protocol revision 2026-07-28 and
 * 2025-era clients from the same factory.
 *
 * @module src/mcp-server/server
 */

import { McpServer } from "@modelcontextprotocol/server";
import { config } from "@/config/index.js";
import { requestContextService } from "@/utils/index.js";
import {
  logOperationStart,
  logOperationSuccess,
} from "@/utils/internal/logging-helpers.js";
import { registerAllTools } from "@/mcp-server/tools/index.js";
import {
  assertAuthModeSupported,
  createBuiltinMapepireClient,
} from "@/mcp-server/transports/auth/index.js";
import { assertHttpSecurityPosture } from "@/mcp-server/transports/http/hostValidation.js";
import { startHttpTransport } from "@/mcp-server/transports/http/index.js";
import { startStdioTransport } from "@/mcp-server/transports/stdio/index.js";
import {
  loadSQLTools,
  onSQLToolsReloaded,
  registerSQLTools,
} from "@/ibmi-mcp-server/index.js";
import {
  registerPerToolsetResources,
  registerToolsetsResource,
} from "@/ibmi-mcp-server/resources/toolsetsResource/index.js";

/** A started transport. */
export interface RunningServer {
  /** Stops accepting requests and closes the transport. */
  close(): Promise<void>;
}

/**
 * Registers everything that comes from the YAML tool files: the SQL tools and
 * one resource per toolset. The resources go last because the toolsets only
 * exist once the tools are loaded.
 */
function registerYamlSurface(server: McpServer): Array<{ remove(): void }> {
  return [...registerSQLTools(server), ...registerPerToolsetResources(server)];
}

/**
 * Creates and configures a new `McpServer` instance.
 *
 * Runs on every HTTP request, so it must stay cheap: YAML tools come from the
 * cache filled by `loadSQLTools`, and nothing here reads files or opens
 * connections.
 *
 * @param followReloads - For an instance that outlives a request (a stdio
 *   connection): swap its YAML tools and toolset resources when the YAML
 *   files are reloaded. The SDK then sends the list-changed notifications.
 * @param listChanged - Whether the client can be told about a reload. False
 *   for a 2025-era HTTP request: it has no stream a notification could
 *   arrive on.
 */
export async function createMcpServerInstance(
  followReloads = false,
  listChanged = true,
): Promise<McpServer> {
  const server = new McpServer(
    { name: config.mcpServerName, version: config.mcpServerVersion },
    {
      capabilities: {
        resources: { listChanged },
        tools: { listChanged },
      },
      // A reload swaps many tools at once; tell the client once.
      debouncedNotificationMethods: [
        "notifications/tools/list_changed",
        "notifications/resources/list_changed",
      ],
    },
  );

  let yamlSurface = registerYamlSurface(server);
  await registerAllTools(server);
  registerToolsetsResource(server);

  if (followReloads) {
    server.server.onclose = onSQLToolsReloaded(() => {
      yamlSurface.forEach((registered) => registered.remove());
      yamlSurface = registerYamlSurface(server);
    });
  }

  return server;
}

/**
 * Loads the tools and starts the configured transport.
 *
 * @throws If the YAML tools cannot be loaded or the transport cannot start.
 */
export async function initializeAndStartServer(): Promise<RunningServer> {
  const transportType = config.mcpTransportType;
  const context = requestContextService.createRequestContext({
    operation: "initializeAndStartServer",
    transport: transportType,
  });
  logOperationStart(context, `Starting transport: ${transportType}`);

  assertAuthModeSupported();

  if (transportType === "http") {
    // Refuse the dangerous posture (unauthenticated + non-loopback + IBM i
    // credentials) before any tool loading happens. Runs after
    // applyCliOverrides, so CLI-provided transport/tools flags are visible.
    assertHttpSecurityPosture(context);
  }

  // Users sign on with their IBM i profile (MCP_AUTH_MODE=oauth without
  // OAUTH_ISSUER_URL): refuse what that mode cannot run with, stdio
  // included, before anything is loaded.
  const signOnClient = config.oauth.builtin
    ? createBuiltinMapepireClient()
    : undefined;

  await loadSQLTools();
  // Build one instance now, so that a registration error (two tools with the
  // same name, say) stops startup instead of failing every request.
  await (await createMcpServerInstance()).close();

  let running: RunningServer;
  if (transportType === "http") {
    const { handler, close } = await startHttpTransport(
      ({ era }) => createMcpServerInstance(false, era === "modern"),
      context,
      signOnClient,
    );
    // Requests after a reload already see the new tools (the factory reads
    // the cache); this tells clients holding a subscriptions/listen stream.
    onSQLToolsReloaded(({ resourcesChanged }) => {
      handler.notify.toolsChanged();
      if (resourcesChanged) {
        handler.notify.resourcesChanged();
      }
    });
    running = { close };
  } else {
    running = startStdioTransport(() => createMcpServerInstance(true), context);
  }

  logOperationSuccess(context, "MCP server started.");
  return running;
}

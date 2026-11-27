/**
 * Tests how the HTTP transport binds its port: on the configured port or not
 * at all.
 *
 * @module tests/mcp-server/transports/http/httpTransportListen.test
 */

import { createServer, type AddressInfo, type Server } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { config } from "../../../../src/config/index.js";
import { startHttpTransport } from "../../../../src/mcp-server/transports/http/index.js";
import { JsonRpcErrorCode } from "../../../../src/types-global/errors.js";
import { requestContextService } from "../../../../src/utils/index.js";

const savedConfig = {
  mcpHttpHost: config.mcpHttpHost,
  mcpHttpPort: config.mcpHttpPort,
  mcpAuthMode: config.mcpAuthMode,
  ibmiHttpAuthEnabled: config.ibmiHttpAuth.enabled,
};

const start = () =>
  startHttpTransport(
    () => new McpServer({ name: "listen-test", version: "0.0.0" }),
    requestContextService.createRequestContext({
      operation: "httpTransportListenTest",
    }),
  );

/** Takes a free loopback port and holds it. */
function occupyPort(): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

const close = (server: Server) =>
  new Promise<void>((resolve) => server.close(() => resolve()));

let occupied: Server;
let port: number;

beforeEach(async () => {
  occupied = await occupyPort();
  port = (occupied.address() as AddressInfo).port;
  config.mcpHttpHost = "127.0.0.1";
  config.mcpHttpPort = port;
  config.mcpAuthMode = "none";
  config.ibmiHttpAuth.enabled = false;
});

afterEach(async () => {
  if (occupied.listening) {
    await close(occupied);
  }
  config.mcpHttpHost = savedConfig.mcpHttpHost;
  config.mcpHttpPort = savedConfig.mcpHttpPort;
  config.mcpAuthMode = savedConfig.mcpAuthMode;
  config.ibmiHttpAuth.enabled = savedConfig.ibmiHttpAuthEnabled;
});

describe("startHttpTransport", () => {
  it("fails with a clear error when the configured port is in use", async () => {
    await expect(start()).rejects.toMatchObject({
      code: JsonRpcErrorCode.ConfigurationError,
      message: `Port ${port} on 127.0.0.1 is already in use. Stop the process using it, or set MCP_HTTP_PORT to a free port.`,
    });
  });

  it("listens on the configured port when it is free", async () => {
    await close(occupied);

    const transport = await start();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(res.status).toBe(200);
    } finally {
      await transport.close();
    }
  });
});

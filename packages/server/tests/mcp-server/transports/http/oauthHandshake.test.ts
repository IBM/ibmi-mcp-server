/**
 * @fileoverview HTTP-level coverage for OAuth discovery and bearer challenges.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockVerify } = vi.hoisted(() => ({ mockVerify: vi.fn() }));

vi.mock("../../../../src/config/index.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../src/config/index.js")>();
  return {
    ...actual,
    config: {
      ...actual.config,
      environment: "test",
      mcpAuthMode: "oauth",
      mcpHttpEndpointPath: "/mcp",
      // The public resource host must pass DNS-rebinding host validation.
      mcpAllowedHosts: ["mcp.example.com"],
      oauthIssuerUrl: "https://login.microsoftonline.com/tenant-id/v2.0",
      oauthResourceUrl: "https://mcp.example.com/mcp",
      oauthScopesSupported: ["https://mcp.example.com/mcp/ibmi.read"],
      rateLimit: { ...actual.config.rateLimit, enabled: false },
    },
  };
});

vi.mock("../../../../src/mcp-server/transports/auth/authFactory.js", () => ({
  createAuthStrategy: () => ({ verify: mockVerify }),
}));

import type { RequestContext } from "../../../../src/utils/index.js";
import type { TransportManager } from "../../../../src/mcp-server/transports/core/transportTypes.js";
import { createHttpApp } from "../../../../src/mcp-server/transports/http/httpTransport.js";

const challenge =
  'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp", scope="https://mcp.example.com/mcp/ibmi.read"';

function createApp() {
  const transportManager: TransportManager = {
    handleRequest: vi.fn(),
    shutdown: vi.fn(),
  };
  const createServer = async (): Promise<McpServer> => {
    throw new Error(
      "The server factory must not be called during authentication",
    );
  };

  return createHttpApp(transportManager, createServer, {
    operation: "oauthHandshakeTest",
  } as RequestContext);
}

describe("OAuth HTTP handshake", () => {
  beforeEach(() => {
    mockVerify.mockReset();
  });

  it("serves protected resource metadata without authentication", async () => {
    const app = createApp();

    const response = await app.request(
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
      { headers: { host: "mcp.example.com" } },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      resource: "https://mcp.example.com/mcp",
      authorization_servers: [
        "https://login.microsoftonline.com/tenant-id/v2.0",
      ],
      bearer_methods_supported: ["header"],
      scopes_supported: ["https://mcp.example.com/mcp/ibmi.read"],
    });
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it("returns discovery and scope information on a 401", async () => {
    const response = await createApp().request("https://mcp.example.com/mcp", {
      method: "POST",
      headers: { host: "mcp.example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe(challenge);
  });
});

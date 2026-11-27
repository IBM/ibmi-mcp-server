/**
 * End-to-end test of the HTTP transport.
 *
 * Drives the real Hono app from createHttpApp in-process: the SDK client's
 * Streamable HTTP transport is given a fetch that calls app.request, so every
 * request passes through the same middleware chain and the same SDK handler
 * (createMcpHandler) as in production. Each client-level case runs once per
 * protocol era: the 2025 `initialize` handshake and pinned 2026-07-28.
 *
 * @module tests/mcp-server/transports/http/httpEndToEnd.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  Client,
  StreamableHTTPClientTransport,
  type ClientOptions,
} from "@modelcontextprotocol/client";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { config } from "../../../../src/config/index.js";
import {
  authContext,
  createHttpAuth,
  type HttpAuth,
} from "../../../../src/mcp-server/transports/auth/index.js";
import { createHttpApp } from "../../../../src/mcp-server/transports/http/httpTransport.js";
import { JsonRpcErrorCode } from "../../../../src/types-global/errors.js";
import { requestContextService } from "../../../../src/utils/index.js";
import {
  ISSUER,
  RESOURCE,
  startFakeAuthorizationServer,
} from "../auth/fakeAuthorizationServer.js";

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: string | number | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

const HOST = "localhost:3010";

const ERAS: Array<[string, ClientOptions["versionNegotiation"]]> = [
  ["2025 initialize handshake", { mode: "legacy" }],
  ["pinned 2026-07-28", { mode: { pin: "2026-07-28" } }],
];

const savedConfig = {
  mcpAllowedHosts: config.mcpAllowedHosts,
  mcpAllowedOrigins: config.mcpAllowedOrigins,
  mcpHttpHost: config.mcpHttpHost,
  mcpAuthMode: config.mcpAuthMode,
  mcpResourceUrl: config.mcpResourceUrl,
  oauthIssuerUrl: config.oauthIssuerUrl,
  rateLimitEnabled: config.rateLimit.enabled,
  ibmiHttpAuthEnabled: config.ibmiHttpAuth.enabled,
};

let serversBuilt = 0;

function createTestServer(): McpServer {
  serversBuilt += 1;
  const server = new McpServer(
    { name: "http-e2e-test", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );
  server.registerTool(
    "echo",
    {
      description: "Echoes the message back.",
      inputSchema: z.object({ message: z.string() }),
    },
    async ({ message }) => ({ content: [{ type: "text", text: message }] }),
  );
  server.registerTool(
    "whoami",
    { description: "Reports the caller's identity from both sources." },
    async (ctx) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            fromSdkContext: ctx.http?.authInfo?.clientId ?? null,
            fromAuthContext: authContext.getStore()?.authInfo.clientId ?? null,
          }),
        },
      ],
    }),
  );
  return server;
}

const context = () =>
  requestContextService.createRequestContext({ operation: "httpEndToEndTest" });

/** Builds the app under test exactly as startHttpTransport wires it. */
function buildApp(auth: HttpAuth | null = null) {
  return createHttpApp(createMcpHandler(createTestServer), context(), auth);
}

type TestApp = ReturnType<typeof buildApp>;

/**
 * Switches to MCP_AUTH_MODE=oauth against a fake authorization server and
 * rebuilds the app. Returns a valid access token.
 */
async function useOAuth(): Promise<string> {
  const authServer = await startFakeAuthorizationServer();
  config.mcpAuthMode = "oauth";
  config.mcpResourceUrl = RESOURCE;
  config.oauthIssuerUrl = ISSUER;
  app = buildApp(await createHttpAuth(context()));
  return authServer.token({ client_id: "e2e-client" });
}

/**
 * Connects a real SDK client whose HTTP requests are served by the app.
 * `bearerToken` is supplied through a static token provider.
 */
async function connect(
  app: TestApp,
  versionNegotiation: ClientOptions["versionNegotiation"],
  bearerToken?: string,
): Promise<Client> {
  const client = new Client(
    { name: "http-e2e-test-client", version: "0.0.0" },
    { versionNegotiation },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://${HOST}/mcp`), {
      authProvider: bearerToken
        ? { token: async () => bearerToken }
        : undefined,
      fetch: async (url, init) => {
        const headers = new Headers(init?.headers);
        headers.set("host", HOST);
        return app.request(url, { ...init, headers });
      },
    }),
  );
  return client;
}

/** POSTs a raw body to the MCP endpoint. No Authorization header is sent. */
function post(
  app: TestApp,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return app.request("/mcp", {
    method: "POST",
    headers: {
      host: HOST,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

let app: TestApp;

beforeEach(() => {
  config.mcpAllowedHosts = undefined;
  config.mcpAllowedOrigins = undefined;
  config.mcpHttpHost = "127.0.0.1";
  config.mcpAuthMode = "none";
  config.rateLimit.enabled = false;
  config.ibmiHttpAuth.enabled = false;
  serversBuilt = 0;
  app = buildApp();
});

afterEach(() => {
  vi.unstubAllGlobals();
  config.mcpAllowedHosts = savedConfig.mcpAllowedHosts;
  config.mcpAllowedOrigins = savedConfig.mcpAllowedOrigins;
  config.mcpHttpHost = savedConfig.mcpHttpHost;
  config.mcpAuthMode = savedConfig.mcpAuthMode;
  config.mcpResourceUrl = savedConfig.mcpResourceUrl;
  config.oauthIssuerUrl = savedConfig.oauthIssuerUrl;
  config.rateLimit.enabled = savedConfig.rateLimitEnabled;
  config.ibmiHttpAuth.enabled = savedConfig.ibmiHttpAuthEnabled;
});

describe.each(ERAS)("HTTP transport end-to-end (%s)", (_era, negotiation) => {
  let client: Client;

  afterEach(async () => {
    await client?.close();
  });

  it("negotiates the expected protocol era", async () => {
    client = await connect(app, negotiation);
    expect(client.getProtocolEra()).toBe(
      negotiation?.mode === "legacy" ? "legacy" : "modern",
    );
  });

  it("tools/list returns the registered tools", async () => {
    client = await connect(app, negotiation);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["echo", "whoami"]);
  });

  it("tools/call runs the tool and returns its content", async () => {
    client = await connect(app, negotiation);
    const result = await client.callTool({
      name: "echo",
      arguments: { message: "hello" },
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: "text", text: "hello" }]);
  });

  it("tools/call for an unknown tool is a JSON-RPC invalid-params error", async () => {
    client = await connect(app, negotiation);
    await expect(
      client.callTool({ name: "no_such_tool", arguments: {} }),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.InvalidParams });
  });

  it("builds a fresh server per request and mints no session", async () => {
    client = await connect(app, negotiation);
    const before = serversBuilt;
    await client.listTools();
    await client.listTools();
    expect(serversBuilt).toBe(before + 2);
  });

  it("with MCP_AUTH_MODE=none handlers see no identity", async () => {
    client = await connect(app, negotiation);
    const result = await client.callTool({ name: "whoami" });
    expect(result.content).toEqual([
      {
        type: "text",
        text: JSON.stringify({ fromSdkContext: null, fromAuthContext: null }),
      },
    ]);
  });

  it("with MCP_AUTH_MODE=oauth a client with a valid bearer token lists tools and handlers see its identity in ctx.http.authInfo and authContext", async () => {
    const token = await useOAuth();

    client = await connect(app, negotiation, token);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["echo", "whoami"]);
    const result = await client.callTool({ name: "whoami" });
    expect(result.content).toEqual([
      {
        type: "text",
        text: JSON.stringify({
          fromSdkContext: "e2e-client",
          fromAuthContext: "e2e-client",
        }),
      },
    ]);
  });
});

describe("HTTP transport end-to-end (raw requests)", () => {
  it("with MCP_AUTH_MODE=oauth a request without a token is rejected with 401 and a Bearer challenge before MCP dispatch", async () => {
    await useOAuth();

    const res = await post(app, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(
      'resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"',
    );
    expect(serversBuilt).toBe(0);
  });

  it("a malformed JSON body is rejected with a 4xx and a JSON-RPC parse error", async () => {
    const res = await post(app, "{not json");
    expect(res.status).toBe(400);
    const message = (await res.json()) as JsonRpcMessage;
    expect(message.jsonrpc).toBe("2.0");
    expect(message.error?.code).toBe(JsonRpcErrorCode.ParseError);
  });

  it("a non-JSON content type is rejected with 415", async () => {
    const res = await post(
      app,
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { "content-type": "text/plain" },
    );
    expect(res.status).toBe(415);
  });

  it("a JSON-RPC notification is accepted with 202 and an empty body", async () => {
    const res = await post(app, {
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 999, reason: "test" },
    });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  it.each(["GET", "DELETE"])(
    "%s on the MCP endpoint is 405: there are no sessions and no standalone stream",
    async (method) => {
      const res = await app.request("/mcp", {
        method,
        headers: { host: HOST, accept: "text/event-stream" },
      });
      expect(res.status).toBe(405);
    },
  );

  it("never returns an Mcp-Session-Id header", async () => {
    const res = await post(app, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "raw", version: "0.0.0" },
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeNull();
  });

  it("leaves the query string, which may carry a token, out of the access log", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await app.request("/mcp?access_token=secret-token", {
      method: "POST",
      headers: { host: HOST, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });

    const logged = JSON.stringify(log.mock.calls);
    log.mockRestore();
    expect(logged).toContain("POST /mcp");
    expect(logged).not.toContain("secret-token");
  });

  it("/healthz responds", async () => {
    const res = await app.request("/healthz", { headers: { host: HOST } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
  });

  it("a disallowed Host header is rejected with 403 before MCP dispatch", async () => {
    const res = await post(
      app,
      { jsonrpc: "2.0", id: 4, method: "tools/list" },
      { host: "evil.example.com" },
    );
    expect(res.status).toBe(403);
    expect(serversBuilt).toBe(0);
  });

  it("a CORS preflight allows the 2026-07-28 request-metadata headers", async () => {
    config.mcpAllowedOrigins = ["https://app.example.com"];
    app = buildApp();

    const res = await app.request("/mcp", {
      method: "OPTIONS",
      headers: {
        host: HOST,
        origin: "https://app.example.com",
        "access-control-request-method": "POST",
        "access-control-request-headers":
          "content-type, mcp-protocol-version, mcp-method, mcp-name",
      },
    });
    const allowed = (res.headers.get("access-control-allow-headers") ?? "")
      .toLowerCase()
      .split(",")
      .map((header) => header.trim());
    expect(allowed).toEqual(
      expect.arrayContaining([
        "content-type",
        "authorization",
        "mcp-protocol-version",
        "mcp-method",
        "mcp-name",
      ]),
    );
    expect(allowed).not.toContain("mcp-session-id");
  });
});

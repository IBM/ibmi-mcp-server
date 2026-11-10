/**
 * Tests that the deprecated IBM i token authentication (MCP_AUTH_MODE=ibmi)
 * still works as before, and that its endpoints announce the deprecation.
 *
 * Drives the real Hono app with real TokenManager sessions; the MCP handler
 * is a stub that reports the identity it was given.
 *
 * @module tests/mcp-server/transports/auth/ibmiTokenAuth.test
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
// Must load first: TokenManager imports logger from this barrel, which is
// circular with utils/internal.
import { requestContextService } from "../../../../src/utils/index.js";
import { config } from "../../../../src/config/index.js";
import { TokenManager } from "../../../../src/ibmi-mcp-server/auth/tokenManager.js";
import {
  authContext,
  createHttpAuth,
} from "../../../../src/mcp-server/transports/auth/index.js";
import { createHttpApp } from "../../../../src/mcp-server/transports/http/httpTransport.js";
import { JsonRpcErrorCode } from "../../../../src/types-global/errors.js";

const HOST = "localhost:3010";

const savedConfig = {
  mcpAllowedHosts: config.mcpAllowedHosts,
  mcpAllowedOrigins: config.mcpAllowedOrigins,
  mcpHttpHost: config.mcpHttpHost,
  mcpAuthMode: config.mcpAuthMode,
  rateLimitEnabled: config.rateLimit.enabled,
  ibmiHttpAuthEnabled: config.ibmiHttpAuth.enabled,
};

async function buildApp() {
  const context = requestContextService.createRequestContext({
    operation: "ibmiTokenAuthTest",
  });
  // Reports the identity the transport passed in and the one in authContext.
  const handleRequest = vi.fn(
    async (_request: Request, options?: { authInfo?: unknown }) =>
      Response.json({
        passed: options?.authInfo,
        authContext: authContext.getStore()?.authInfo,
      }),
  );
  const app = createHttpApp(
    { fetch: handleRequest },
    context,
    await createHttpAuth(context),
  );
  return { app, handleRequest };
}

function mcpPost(
  app: Awaited<ReturnType<typeof buildApp>>["app"],
  token?: string,
) {
  return app.request("/mcp", {
    method: "POST",
    headers: {
      host: HOST,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
}

beforeEach(() => {
  config.mcpAllowedHosts = undefined;
  config.mcpAllowedOrigins = undefined;
  config.mcpHttpHost = "127.0.0.1";
  config.mcpAuthMode = "ibmi";
  config.rateLimit.enabled = false;
  config.ibmiHttpAuth.enabled = true;
});

afterEach(() => {
  config.mcpAllowedHosts = savedConfig.mcpAllowedHosts;
  config.mcpAllowedOrigins = savedConfig.mcpAllowedOrigins;
  config.mcpHttpHost = savedConfig.mcpHttpHost;
  config.mcpAuthMode = savedConfig.mcpAuthMode;
  config.rateLimit.enabled = savedConfig.rateLimitEnabled;
  config.ibmiHttpAuth.enabled = savedConfig.ibmiHttpAuthEnabled;
});

afterAll(() => {
  TokenManager.getInstance().shutdown();
});

describe("MCP_AUTH_MODE=ibmi (deprecated)", () => {
  it("accepts a token issued by TokenManager and routes the request as that user", async () => {
    const token = TokenManager.getInstance().generateToken({
      host: "ibmi.example.com",
      user: "TESTUSER",
      password: "secret",
    });
    const { app } = await buildApp();
    const res = await mcpPost(app, token);

    expect(res.status).toBe(200);
    const identity = {
      token,
      clientId: "TESTUSER",
      scopes: ["ibmi:access"],
      extra: { subject: "TESTUSER" },
      ibmiToken: token,
      ibmiHost: "ibmi.example.com",
    };
    expect(await res.json()).toEqual({
      passed: identity,
      authContext: identity,
    });
  });

  it.each<[string, string | undefined]>([
    ["no token", undefined],
    ["an unknown token", "not-a-token-this-server-issued"],
  ])(
    "answers 401 with a JSON-RPC Unauthorized error for %s",
    async (_name, token) => {
      const { app, handleRequest } = await buildApp();
      const res = await mcpPost(app, token);

      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: number } };
      expect(body.error.code).toBe(JsonRpcErrorCode.Unauthorized);
      expect(handleRequest).not.toHaveBeenCalled();
    },
  );

  it("marks every /api/v1/auth response with a Deprecation header", async () => {
    const { app } = await buildApp();

    // Refused before the handler: plain HTTP is not allowed.
    const overHttp = await app.request("/api/v1/auth", {
      method: "POST",
      headers: { host: HOST, "content-type": "application/json" },
      body: "{}",
    });
    expect(overHttp.status).toBe(400);
    expect(overHttp.headers.get("deprecation")).toBe("true");

    // Answered by the handler: the envelope is incomplete.
    const overHttps = await app.request("/api/v1/auth", {
      method: "POST",
      headers: {
        host: HOST,
        "content-type": "application/json",
        "x-forwarded-proto": "https",
      },
      body: "{}",
    });
    expect(overHttps.status).toBe(400);
    expect(overHttps.headers.get("deprecation")).toBe("true");

    const publicKey = await app.request("/api/v1/auth/public-key", {
      headers: { host: HOST },
    });
    expect(publicKey.headers.get("deprecation")).toBe("true");

    const health = await app.request("/healthz", { headers: { host: HOST } });
    expect(health.headers.get("deprecation")).toBeNull();
  });
});

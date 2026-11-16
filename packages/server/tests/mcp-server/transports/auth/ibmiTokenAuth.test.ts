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
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
// Must load first: TokenManager imports logger from this barrel, which is
// circular with utils/internal.
import {
  rateLimiter,
  requestContextService,
} from "../../../../src/utils/index.js";
import { config } from "../../../../src/config/index.js";
import { TokenManager } from "../../../../src/ibmi-mcp-server/auth/tokenManager.js";
import {
  authContext,
  createHttpAuth,
} from "../../../../src/mcp-server/transports/auth/index.js";
import { createHttpApp } from "../../../../src/mcp-server/transports/http/httpTransport.js";
import { JsonRpcErrorCode } from "../../../../src/types-global/errors.js";
import {
  createTestKeyPair,
  type TestKeyPair,
} from "../../../ibmi-mcp-server/auth/testKeyPair.js";

const HOST = "localhost:3010";

const savedConfig = {
  mcpAllowedHosts: config.mcpAllowedHosts,
  mcpAllowedOrigins: config.mcpAllowedOrigins,
  mcpHttpHost: config.mcpHttpHost,
  mcpAuthMode: config.mcpAuthMode,
  mcpTrustedProxies: config.mcpTrustedProxies,
  rateLimitEnabled: config.rateLimit.enabled,
  rateLimitSkipInDevelopment: config.rateLimit.skipInDevelopment,
  ibmiHttpAuth: { ...config.ibmiHttpAuth },
};
const savedLimiterConfig = rateLimiter.getConfig();
let keyPair: TestKeyPair;

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

beforeAll(() => {
  keyPair = createTestKeyPair();
});

beforeEach(() => {
  config.mcpAllowedHosts = undefined;
  config.mcpAllowedOrigins = undefined;
  config.mcpHttpHost = "127.0.0.1";
  config.mcpAuthMode = "ibmi";
  config.mcpTrustedProxies = [];
  config.rateLimit.enabled = false;
  config.rateLimit.skipInDevelopment = false;
  Object.assign(config.ibmiHttpAuth, {
    enabled: true,
    ...keyPair.settings,
    allowedHosts: ["ibmi.example.com"],
  });
});

afterEach(() => {
  config.mcpAllowedHosts = savedConfig.mcpAllowedHosts;
  config.mcpAllowedOrigins = savedConfig.mcpAllowedOrigins;
  config.mcpHttpHost = savedConfig.mcpHttpHost;
  config.mcpAuthMode = savedConfig.mcpAuthMode;
  config.mcpTrustedProxies = savedConfig.mcpTrustedProxies;
  config.rateLimit.enabled = savedConfig.rateLimitEnabled;
  config.rateLimit.skipInDevelopment = savedConfig.rateLimitSkipInDevelopment;
  Object.assign(config.ibmiHttpAuth, savedConfig.ibmiHttpAuth);
  rateLimiter.reset();
  rateLimiter.configure(savedLimiterConfig);
});

afterAll(() => {
  TokenManager.getInstance().shutdown();
  keyPair.remove();
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

  it("counts refused requests against the client address without locking out a valid token from it", async () => {
    config.rateLimit.enabled = true;
    rateLimiter.configure({
      windowMs: 60_000,
      maxRequests: 1,
      skipInDevelopment: false,
    });
    const token = TokenManager.getInstance().generateToken({
      host: "ibmi.example.com",
      user: "TESTUSER",
      password: "secret",
    });
    const { app } = await buildApp();

    const refused = () => mcpPost(app, "not-a-token-this-server-issued");

    expect((await refused()).status).toBe(401);
    // The address has used up its budget: further refused requests get 429.
    expect((await refused()).status).toBe(429);
    // A valid token from the same address is still served.
    expect((await mcpPost(app, token)).status).toBe(200);
  });

  it("marks every /api/v1/auth response with a Deprecation header", async () => {
    config.mcpTrustedProxies = ["10.9.9.9/32"];
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
    const overHttps = await app.request(
      "/api/v1/auth",
      {
        method: "POST",
        headers: {
          host: HOST,
          "content-type": "application/json",
          "x-forwarded-proto": "https",
        },
        body: "{}",
      },
      { incoming: { socket: { remoteAddress: "10.9.9.9" } } },
    );
    expect(overHttps.status).toBe(400);
    expect(
      ((await overHttps.json()) as { error: { message: string } }).error
        .message,
    ).toBe("Encrypted payload is missing required field: keyId");
    expect(overHttps.headers.get("deprecation")).toBe("true");

    const publicKey = await app.request("/api/v1/auth/public-key", {
      headers: { host: HOST },
    });
    expect(publicKey.headers.get("deprecation")).toBe("true");

    const health = await app.request("/healthz", { headers: { host: HOST } });
    expect(health.headers.get("deprecation")).toBeNull();
  });
});

describe("POST /api/v1/auth in front of the sign-on", () => {
  /** An incomplete envelope: what answers it shows how far the request got. */
  function signOn(
    app: Awaited<ReturnType<typeof buildApp>>["app"],
    headers: Record<string, string> = {},
    socketAddress = "10.9.9.9",
  ) {
    return app.request(
      "/api/v1/auth",
      {
        method: "POST",
        headers: { host: HOST, "content-type": "application/json", ...headers },
        body: "{}",
      },
      { incoming: { socket: { remoteAddress: socketAddress } } },
    );
  }
  const message = async (res: Response) =>
    ((await res.json()) as { error: { message: string } }).error.message;

  it("does not take a caller's word that the request arrived over HTTPS", async () => {
    const { app } = await buildApp();

    const res = await signOn(app, { "x-forwarded-proto": "https" });

    expect(res.status).toBe(400);
    expect(await message(res)).toBe(
      "HTTPS/TLS is required for authentication endpoints",
    );
  });

  it("does not take the scheme of an absolute-form request target for it either", async () => {
    const { app } = await buildApp();

    // What `POST https://host/api/v1/auth HTTP/1.1` on a plain socket becomes
    const res = await app.request(
      `https://${HOST}/api/v1/auth`,
      {
        method: "POST",
        headers: { host: HOST, "content-type": "application/json" },
        body: "{}",
      },
      { incoming: { socket: { remoteAddress: "10.9.9.9" } } },
    );

    expect(res.status).toBe(400);
    expect(await message(res)).toBe(
      "HTTPS/TLS is required for authentication endpoints",
    );
  });

  it("takes the word of a proxy listed in MCP_TRUSTED_PROXIES for it", async () => {
    config.mcpTrustedProxies = ["10.9.9.9/32"];
    const { app } = await buildApp();

    const res = await signOn(app, { "x-forwarded-proto": "https" });

    // Past the TLS check: refused by the handler for the incomplete envelope.
    expect(await message(res)).toBe(
      "Encrypted payload is missing required field: keyId",
    );
  });

  it("allows 10 sign-on attempts per minute from one address", async () => {
    config.rateLimit.enabled = true;
    const { app } = await buildApp();

    for (let attempt = 1; attempt <= 10; attempt++) {
      expect((await signOn(app)).status).toBe(400);
    }
    const limited = await signOn(app);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("deprecation")).toBe("true");
    // A forwarded address does not buy a new budget...
    expect((await signOn(app, { "x-forwarded-for": "10.7.7.7" })).status).toBe(
      429,
    );
    // ...and other addresses have their own.
    expect((await signOn(app, {}, "10.8.8.8")).status).toBe(400);
  });
});

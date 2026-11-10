/**
 * Tests for MCP_AUTH_MODE=oauth: the server as an OAuth 2.1 resource server.
 *
 * Drives the real Hono app (createHttpApp + createHttpAuth) around a real
 * SDK handler. Tokens are signed with a key pair generated per test and the
 * authorization server's metadata and JWKS are served by a stubbed global
 * fetch.
 *
 * @module tests/mcp-server/transports/auth/oauth.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { generateKeyPair, SignJWT } from "jose";
import { config } from "../../../../src/config/index.js";
import {
  authContext,
  createHttpAuth,
} from "../../../../src/mcp-server/transports/auth/index.js";
import { createHttpApp } from "../../../../src/mcp-server/transports/http/httpTransport.js";
import { JsonRpcErrorCode } from "../../../../src/types-global/errors.js";
import {
  logger,
  rateLimiter,
  requestContextService,
} from "../../../../src/utils/index.js";
import {
  ISSUER,
  RESOURCE,
  startFakeAuthorizationServer,
  type FakeAuthorizationServer,
} from "./fakeAuthorizationServer.js";

const HOST = "localhost:3010";
const METADATA_URL =
  "https://mcp.example.com/.well-known/oauth-protected-resource/mcp";

const savedConfig = {
  mcpAllowedHosts: config.mcpAllowedHosts,
  mcpAllowedOrigins: config.mcpAllowedOrigins,
  mcpHttpHost: config.mcpHttpHost,
  mcpAuthMode: config.mcpAuthMode,
  mcpTrustProxy: config.mcpTrustProxy,
  mcpResourceUrl: config.mcpResourceUrl,
  oauthIssuerUrl: config.oauthIssuerUrl,
  oauthJwksUri: config.oauthJwksUri,
  oauthAudience: config.oauthAudience,
  oauthRequiredScopes: config.oauthRequiredScopes,
  rateLimitEnabled: config.rateLimit.enabled,
  ibmiHttpAuthEnabled: config.ibmiHttpAuth.enabled,
};
const savedLimiterConfig = rateLimiter.getConfig();

const context = () =>
  requestContextService.createRequestContext({ operation: "oauthTest" });

let serversBuilt = 0;

/** A server whose one tool reports the identity its handler sees. */
function createTestServer(): McpServer {
  serversBuilt += 1;
  const server = new McpServer(
    { name: "oauth-test", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );
  server.registerTool(
    "whoami",
    { description: "Reports the caller's identity." },
    async (ctx) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            sdk: ctx.http?.authInfo,
            authContext: authContext.getStore()?.authInfo,
          }),
        },
      ],
    }),
  );
  return server;
}

/** Builds the app the way startHttpTransport does. */
async function buildApp() {
  return createHttpApp(
    createMcpHandler(createTestServer),
    context(),
    await createHttpAuth(context()),
  );
}

type TestApp = Awaited<ReturnType<typeof buildApp>>;

function post(
  app: TestApp,
  body: unknown,
  token?: string,
  headers: Record<string, string> = {},
  path = "/mcp",
) {
  return app.request(path, {
    method: "POST",
    headers: {
      host: HOST,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const listTools = (app: TestApp, token?: string) =>
  post(app, { jsonrpc: "2.0", id: 1, method: "tools/list" }, token);

/** Connects a real SDK client that sends `token` as its bearer token. */
async function connect(app: TestApp, token: string): Promise<Client> {
  const client = new Client({ name: "oauth-test-client", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://${HOST}/mcp`), {
      authProvider: { token: async () => token },
      fetch: async (url, init) => {
        const headers = new Headers(init?.headers);
        headers.set("host", HOST);
        return app.request(url, { ...init, headers });
      },
    }),
  );
  return client;
}

/** Calls the whoami tool and returns the identity its handler saw. */
async function whoami(app: TestApp, token: string) {
  const client = await connect(app, token);
  const result = await client.callTool({ name: "whoami" });
  await client.close();
  const [content] = result.content as Array<{ text: string }>;
  return JSON.parse(content!.text) as {
    sdk: Record<string, unknown>;
    authContext: Record<string, unknown>;
  };
}

let authServer: FakeAuthorizationServer;

beforeEach(async () => {
  config.mcpAllowedHosts = undefined;
  config.mcpAllowedOrigins = undefined;
  config.mcpHttpHost = "127.0.0.1";
  config.rateLimit.enabled = false;
  config.ibmiHttpAuth.enabled = false;
  config.mcpAuthMode = "oauth";
  config.mcpTrustProxy = false;
  config.mcpResourceUrl = RESOURCE;
  config.oauthIssuerUrl = ISSUER;
  config.oauthJwksUri = undefined;
  config.oauthAudience = undefined;
  config.oauthRequiredScopes = undefined;
  serversBuilt = 0;
  authServer = await startFakeAuthorizationServer();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  config.mcpAllowedHosts = savedConfig.mcpAllowedHosts;
  config.mcpAllowedOrigins = savedConfig.mcpAllowedOrigins;
  config.mcpHttpHost = savedConfig.mcpHttpHost;
  config.mcpAuthMode = savedConfig.mcpAuthMode;
  config.mcpTrustProxy = savedConfig.mcpTrustProxy;
  config.mcpResourceUrl = savedConfig.mcpResourceUrl;
  config.oauthIssuerUrl = savedConfig.oauthIssuerUrl;
  config.oauthJwksUri = savedConfig.oauthJwksUri;
  config.oauthAudience = savedConfig.oauthAudience;
  config.oauthRequiredScopes = savedConfig.oauthRequiredScopes;
  config.rateLimit.enabled = savedConfig.rateLimitEnabled;
  config.ibmiHttpAuth.enabled = savedConfig.ibmiHttpAuthEnabled;
  rateLimiter.reset();
  rateLimiter.configure(savedLimiterConfig);
});

describe("OAuth: requests that are refused", () => {
  it("answers 401 with a Bearer challenge naming the metadata URL when no token is sent", async () => {
    const app = await buildApp();
    const res = await listTools(app);

    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      `Bearer error="invalid_token", error_description="Missing Authorization header", resource_metadata="${METADATA_URL}"`,
    );
    expect(await res.json()).toEqual({
      error: "invalid_token",
      error_description: "Missing Authorization header",
    });
    expect(serversBuilt).toBe(0);
  });

  it("adds the required scopes to the 401 challenge", async () => {
    config.oauthRequiredScopes = ["mcp:tools", "mcp:admin"];
    const app = await buildApp();
    const res = await listTools(app);

    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(
      `scope="mcp:tools mcp:admin", resource_metadata="${METADATA_URL}"`,
    );
  });

  it.each<[string, () => Promise<string>]>([
    ["a malformed token", async () => "not-a-jwt"],
    [
      "a token from another issuer",
      () => authServer.token({ iss: "https://evil.example.com" }),
    ],
    [
      "a token signed with another key",
      async () =>
        authServer.token({}, (await generateKeyPair("RS256")).privateKey),
    ],
    [
      "a token for another audience",
      () => authServer.token({ aud: "https://other.example.com/mcp" }),
    ],
    ["a token without an audience", () => authServer.token({ aud: undefined })],
    [
      "an expired token",
      () => authServer.token({ exp: Math.floor(Date.now() / 1000) - 60 }),
    ],
    ["a token without an expiry", () => authServer.token({ exp: undefined })],
    [
      "a token that is not valid yet",
      () => authServer.token({ nbf: Math.floor(Date.now() / 1000) + 600 }),
    ],
    [
      "an HS256 token",
      () =>
        new SignJWT({
          iss: ISSUER,
          aud: RESOURCE,
          client_id: "test-client",
        })
          .setProtectedHeader({ alg: "HS256", kid: "test-key" })
          .setExpirationTime("5m")
          .sign(new TextEncoder().encode("a-shared-secret-of-32-characters")),
    ],
    [
      'an unsigned "alg":"none" token',
      async () => {
        const encode = (value: unknown) =>
          Buffer.from(JSON.stringify(value)).toString("base64url");
        return `${encode({ alg: "none", typ: "JWT" })}.${encode({
          iss: ISSUER,
          aud: RESOURCE,
          client_id: "test-client",
          exp: Math.floor(Date.now() / 1000) + 300,
        })}.`;
      },
    ],
    [
      "a token that identifies no client",
      () => authServer.token({ client_id: undefined, sub: undefined }),
    ],
  ])("answers 401 for %s, without saying why", async (_name, mint) => {
    const app = await buildApp();
    const res = await listTools(app, await mint());

    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      `Bearer error="invalid_token", error_description="Invalid access token", resource_metadata="${METADATA_URL}"`,
    );
    expect(serversBuilt).toBe(0);
  });

  it("does not accept a token in the query string", async () => {
    const app = await buildApp();
    const token = await authServer.token();
    const res = await post(
      app,
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      undefined,
      {},
      `/mcp?access_token=${token}`,
    );
    expect(res.status).toBe(401);
  });

  it("answers 401, not 500, when the JWKS cannot be fetched", async () => {
    config.oauthJwksUri = `${ISSUER}/missing-jwks`;
    const app = await buildApp();
    const res = await listTools(app, await authServer.token());
    expect(res.status).toBe(401);
  });

  it("answers 403 insufficient_scope when the token lacks a required scope", async () => {
    config.oauthRequiredScopes = ["mcp:tools", "mcp:admin"];
    const app = await buildApp();
    const res = await listTools(app, await authServer.token());

    expect(res.status).toBe(403);
    expect(res.headers.get("www-authenticate")).toBe(
      `Bearer error="insufficient_scope", error_description="Insufficient scope", scope="mcp:tools mcp:admin", resource_metadata="${METADATA_URL}"`,
    );
    expect(serversBuilt).toBe(0);
  });

  it("logs a fingerprint of a rejected token, never the token", async () => {
    const warning = vi.spyOn(logger, "warning");
    const app = await buildApp();
    const token = await authServer.token({ aud: "https://other.example.com" });
    await listTools(app, token);

    const logged = JSON.stringify(warning.mock.calls);
    expect(logged).toContain("tokenFingerprint");
    expect(logged).toContain("ERR_JWT_CLAIM_VALIDATION_FAILED");
    expect(logged).not.toContain(token);
    expect(logged).not.toContain(token.split(".")[2]);
  });

  it("lets a browser client read the challenge: CORS exposes WWW-Authenticate", async () => {
    config.mcpAllowedOrigins = ["https://app.example.com"];
    const app = await buildApp();
    const res = await post(
      app,
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      undefined,
      { origin: "https://app.example.com" },
    );

    expect(res.status).toBe(401);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://app.example.com",
    );
    expect(res.headers.get("access-control-expose-headers")).toBe(
      "WWW-Authenticate",
    );
  });
});

describe("OAuth: requests that are accepted", () => {
  it("serves tools/list for a valid token", async () => {
    config.oauthRequiredScopes = ["mcp:tools"];
    const app = await buildApp();
    expect((await listTools(app, await authServer.token())).status).toBe(200);

    const client = await connect(app, await authServer.token());
    const { tools } = await client.listTools();
    await client.close();
    expect(tools.map((tool) => tool.name)).toEqual(["whoami"]);
  });

  it("gives the tool handler the identity, in ctx.http.authInfo and in authContext", async () => {
    const app = await buildApp();
    const token = await authServer.token({ scope: "mcp:tools db:read" });
    const exp = JSON.parse(
      Buffer.from(token.split(".")[1]!, "base64url").toString(),
    ).exp as number;

    const seen = await whoami(app, token);
    const expected = {
      token,
      clientId: "test-client",
      scopes: ["mcp:tools", "db:read"],
      expiresAt: exp,
      resource: RESOURCE,
      resourceMetadataUrl: METADATA_URL,
      extra: { subject: "user-1" },
    };
    expect(seen.sdk).toEqual(expected);
    expect(seen.authContext).toEqual(expected);
  });

  it.each<[string, Record<string, unknown>, string]>([
    [
      "azp when there is no client_id",
      { client_id: undefined, azp: "azp-client" },
      "azp-client",
    ],
    ["sub when there is neither", { client_id: undefined }, "user-1"],
  ])("takes the client id from %s", async (_name, claims, clientId) => {
    const app = await buildApp();
    const seen = await whoami(app, await authServer.token(claims));
    expect(seen.sdk.clientId).toBe(clientId);
  });

  it("reads scopes from an scp array", async () => {
    const app = await buildApp();
    const seen = await whoami(
      app,
      await authServer.token({ scope: undefined, scp: ["mcp:tools", "x"] }),
    );
    expect(seen.sdk.scopes).toEqual(["mcp:tools", "x"]);
  });

  it("rate-limits each user separately, not all users of one client application", async () => {
    config.rateLimit.enabled = true;
    rateLimiter.reset();
    rateLimiter.configure({
      windowMs: 60_000,
      maxRequests: 1,
      skipInDevelopment: false,
    });
    const app = await buildApp();
    // Every user arrives from the same address, through the same client.
    const asUser = async (sub: string) => {
      const res = await app.request(
        "/mcp",
        {
          method: "POST",
          headers: {
            host: HOST,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${await authServer.token({ sub })}`,
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        },
        { incoming: { socket: { remoteAddress: "10.1.1.1" } } },
      );
      return res.status;
    };

    expect(await asUser("user-1")).toBe(200);
    expect(await asUser("user-2")).toBe(200);
    expect(await asUser("user-1")).toBe(429);
  });

  it("counts refused requests against the client address without locking out a valid token from it", async () => {
    config.rateLimit.enabled = true;
    rateLimiter.reset();
    rateLimiter.configure({
      windowMs: 60_000,
      maxRequests: 2,
      skipInDevelopment: false,
    });
    const app = await buildApp();
    const from = async (address: string, token?: string) => {
      const res = await app.request(
        "/mcp",
        {
          method: "POST",
          headers: {
            host: HOST,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        },
        { incoming: { socket: { remoteAddress: address } } },
      );
      return res.status;
    };
    const valid = await authServer.token({ sub: "user-1" });

    expect(await from("10.1.1.1", "not-a-token")).toBe(401);
    expect(await from("10.1.1.1")).toBe(401);
    // The address has used up its budget: further refused requests get 429.
    expect(await from("10.1.1.1", "not-a-token")).toBe(429);
    expect(await from("10.1.1.1")).toBe(429);
    // A user behind the same address (proxy, NAT) is not locked out by them.
    expect(await from("10.1.1.1", valid)).toBe(200);
    // Other addresses still get the real answer.
    expect(await from("10.2.2.2", "not-a-token")).toBe(401);
  });

  it("accepts a token whose audience list includes this server", async () => {
    const app = await buildApp();
    const token = await authServer.token({
      aud: ["https://other.example.com", `${RESOURCE}/`],
    });
    expect((await listTools(app, token)).status).toBe(200);
  });

  it("accepts an audience that spells the resource URL with an uppercase scheme and host", async () => {
    const app = await buildApp();
    const token = await authServer.token({
      aud: RESOURCE.replace(
        "https://mcp.example.com",
        "HTTPS://MCP.EXAMPLE.COM",
      ),
    });
    expect((await listTools(app, token)).status).toBe(200);
  });

  it("reports the token's own audience entry as the resource it was issued for", async () => {
    const app = await buildApp();
    const seen = await whoami(
      app,
      await authServer.token({
        aud: ["https://other.example.com", `${RESOURCE}/`],
      }),
    );
    expect(seen.sdk.resource).toBe(`${RESOURCE}/`);
  });

  it("treats an empty OAUTH_AUDIENCE as unset: the audience must still be this server", async () => {
    config.oauthAudience = "";
    const app = await buildApp();

    expect(
      (
        await listTools(
          app,
          await authServer.token({ aud: "https://other.example.com/mcp" }),
        )
      ).status,
    ).toBe(401);
    expect((await listTools(app, await authServer.token())).status).toBe(200);
  });

  it("expects OAUTH_AUDIENCE instead of the resource URL when it is set", async () => {
    config.oauthAudience = "api://ibmi-mcp";
    const app = await buildApp();

    expect(
      (await listTools(app, await authServer.token({ aud: "api://ibmi-mcp" })))
        .status,
    ).toBe(200);
    expect((await listTools(app, await authServer.token())).status).toBe(401);
  });
});

describe("OAuth: Protected Resource Metadata (RFC 9728)", () => {
  it.each([
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
  ])("serves the document at %s without a token", async (path) => {
    config.oauthRequiredScopes = ["mcp:tools"];
    const app = await buildApp();
    const res = await app.request(path, { headers: { host: HOST } });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({
      resource: RESOURCE,
      authorization_servers: [ISSUER],
      scopes_supported: ["mcp:tools"],
      bearer_methods_supported: ["header"],
    });
  });

  it("omits scopes_supported when no scopes are required", async () => {
    const app = await buildApp();
    const res = await app.request("/.well-known/oauth-protected-resource", {
      headers: { host: HOST },
    });
    expect(await res.json()).toEqual({
      resource: RESOURCE,
      authorization_servers: [ISSUER],
      bearer_methods_supported: ["header"],
    });
  });

  it("serves it under the path of the public resource URL when a proxy rewrites the path", async () => {
    config.mcpResourceUrl = "https://mcp.example.com/ibmi/mcp";
    const app = await buildApp();
    const res = await app.request(
      "/.well-known/oauth-protected-resource/ibmi/mcp",
      { headers: { host: HOST } },
    );
    expect(res.status).toBe(200);
    expect((await listTools(app)).headers.get("www-authenticate")).toContain(
      'resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/ibmi/mcp"',
    );
  });

  it("is not served when authentication is not oauth", async () => {
    config.mcpAuthMode = "none";
    const app = await buildApp();
    const res = await app.request("/.well-known/oauth-protected-resource", {
      headers: { host: HOST },
    });
    expect(res.status).toBe(404);
  });

  it("stays behind Host validation", async () => {
    const app = await buildApp();
    const res = await app.request("/.well-known/oauth-protected-resource", {
      headers: { host: "evil.example.com" },
    });
    expect(res.status).toBe(403);
  });

  it("stays behind rate limiting", async () => {
    config.rateLimit.enabled = true;
    rateLimiter.reset();
    rateLimiter.configure({
      windowMs: 60_000,
      maxRequests: 1,
      skipInDevelopment: false,
    });
    const app = await buildApp();
    const get = () =>
      app.request(
        "/.well-known/oauth-protected-resource/mcp",
        { headers: { host: HOST } },
        { incoming: { socket: { remoteAddress: "10.1.1.1" } } },
      );

    expect((await get()).status).toBe(200);
    const limited = await get();
    expect(limited.status).toBe(429);
    const body = (await limited.json()) as { error: { code: number } };
    expect(body.error.code).toBe(JsonRpcErrorCode.RateLimited);
  });

  it("does not let an unauthenticated caller use up a user's rate limit by claiming the user's name as its address", async () => {
    // Behind a trusted proxy the claimed address is what requests are keyed on.
    config.mcpTrustProxy = true;
    config.rateLimit.enabled = true;
    rateLimiter.reset();
    rateLimiter.configure({
      windowMs: 60_000,
      maxRequests: 1,
      skipInDevelopment: false,
    });
    const app = await buildApp();

    const env = { incoming: { socket: { remoteAddress: "10.1.1.1" } } };

    const forged = await app.request(
      "/.well-known/oauth-protected-resource",
      { headers: { host: HOST, "x-forwarded-for": "user-1" } },
      env,
    );
    expect(forged.status).toBe(200);

    // user-1's own bucket is untouched.
    const asUser1 = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: {
          host: HOST,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${await authServer.token({ sub: "user-1" })}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      },
      env,
    );
    expect(asUser1.status).toBe(200);
  });

  it("answers a browser preflight for GET from an allowed origin", async () => {
    config.mcpAllowedOrigins = ["https://app.example.com"];
    const app = await buildApp();
    const res = await app.request("/.well-known/oauth-protected-resource", {
      method: "OPTIONS",
      headers: {
        host: HOST,
        origin: "https://app.example.com",
        "access-control-request-method": "GET",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://app.example.com",
    );
    expect(res.headers.get("access-control-allow-methods")).toContain("GET");
  });
});

describe("OAuth: JWKS discovery from the issuer", () => {
  it("reads jwks_uri from the RFC 8414 metadata", async () => {
    const app = await buildApp();
    expect((await listTools(app, await authServer.token())).status).toBe(200);
    expect(authServer.requests).toEqual([
      `${ISSUER}/.well-known/oauth-authorization-server`,
      `${ISSUER}/jwks`,
    ]);
  });

  it("falls back to OpenID Connect Discovery", async () => {
    vi.unstubAllGlobals();
    authServer = await startFakeAuthorizationServer({
      [`${ISSUER}/.well-known/oauth-authorization-server`]: null,
      [`${ISSUER}/.well-known/openid-configuration`]: {
        issuer: ISSUER,
        jwks_uri: `${ISSUER}/jwks`,
      },
    });
    const app = await buildApp();
    expect((await listTools(app, await authServer.token())).status).toBe(200);
  });

  it("tries the three well-known forms, in order, for an issuer with a path", async () => {
    const issuer = `${ISSUER}/realms/ibmi`;
    vi.unstubAllGlobals();
    authServer = await startFakeAuthorizationServer({
      [`${issuer}/.well-known/openid-configuration`]: {
        issuer,
        jwks_uri: `${ISSUER}/jwks`,
      },
    });
    config.oauthIssuerUrl = issuer;
    const app = await buildApp();

    expect(authServer.requests).toEqual([
      `${ISSUER}/.well-known/oauth-authorization-server/realms/ibmi`,
      `${ISSUER}/.well-known/openid-configuration/realms/ibmi`,
      `${issuer}/.well-known/openid-configuration`,
    ]);
    const token = await authServer.token({ iss: issuer });
    expect((await listTools(app, token)).status).toBe(200);
  });

  it("refuses metadata that names another issuer", async () => {
    vi.unstubAllGlobals();
    await startFakeAuthorizationServer({
      [`${ISSUER}/.well-known/oauth-authorization-server`]: {
        issuer: "https://evil.example.com",
        jwks_uri: "https://evil.example.com/jwks",
      },
    });
    await expect(buildApp()).rejects.toMatchObject({
      code: JsonRpcErrorCode.ConfigurationError,
      message: `The authorization server metadata at ${ISSUER}/.well-known/oauth-authorization-server names issuer "https://evil.example.com", which is not OAUTH_ISSUER_URL "${ISSUER}".`,
    });
  });

  it("refuses metadata without a jwks_uri", async () => {
    vi.unstubAllGlobals();
    await startFakeAuthorizationServer({
      [`${ISSUER}/.well-known/oauth-authorization-server`]: { issuer: ISSUER },
    });
    await expect(buildApp()).rejects.toThrow(
      /has no jwks_uri\. Set OAUTH_JWKS_URI\./,
    );
  });

  it("refuses a discovered jwks_uri that is not https", async () => {
    vi.unstubAllGlobals();
    await startFakeAuthorizationServer({
      [`${ISSUER}/.well-known/oauth-authorization-server`]: {
        issuer: ISSUER,
        jwks_uri: "http://auth.example.com/jwks",
      },
    });
    await expect(buildApp()).rejects.toThrow(/must use https/);
  });

  it("fails naming every URL tried when the issuer publishes no metadata", async () => {
    vi.unstubAllGlobals();
    await startFakeAuthorizationServer({
      [`${ISSUER}/.well-known/oauth-authorization-server`]: null,
    });
    await expect(buildApp()).rejects.toThrow(
      `No authorization server metadata found for OAUTH_ISSUER_URL "${ISSUER}". Tried ${ISSUER}/.well-known/oauth-authorization-server (HTTP 404), ${ISSUER}/.well-known/openid-configuration (HTTP 404). Check the issuer, or set OAUTH_JWKS_URI.`,
    );
  });

  it("skips discovery when OAUTH_JWKS_URI is set", async () => {
    config.oauthJwksUri = `${ISSUER}/jwks`;
    const app = await buildApp();
    expect(authServer.requests).toEqual([]);
    expect((await listTools(app, await authServer.token())).status).toBe(200);
  });
});

describe("OAuth: misconfiguration stops startup", () => {
  it.each<[string, () => void, string]>([
    [
      "MCP_RESOURCE_URL is missing",
      () => (config.mcpResourceUrl = undefined),
      "MCP_RESOURCE_URL is required when MCP_AUTH_MODE=oauth.",
    ],
    [
      "OAUTH_ISSUER_URL is missing",
      () => (config.oauthIssuerUrl = undefined),
      "OAUTH_ISSUER_URL is required when MCP_AUTH_MODE=oauth.",
    ],
    [
      "MCP_RESOURCE_URL is not a URL",
      () => (config.mcpResourceUrl = "mcp.example.com/mcp"),
      'MCP_RESOURCE_URL is not a valid URL: "mcp.example.com/mcp".',
    ],
    [
      "MCP_RESOURCE_URL has a fragment",
      () => (config.mcpResourceUrl = "https://mcp.example.com/mcp#x"),
      'MCP_RESOURCE_URL must not have a fragment: "https://mcp.example.com/mcp#x".',
    ],
    [
      "MCP_RESOURCE_URL is not http(s)",
      () => (config.mcpResourceUrl = "ftp://mcp.example.com/mcp"),
      'MCP_RESOURCE_URL must be an http(s) URL: "ftp://mcp.example.com/mcp".',
    ],
    [
      "OAUTH_ISSUER_URL is plain http off this host",
      () => (config.oauthIssuerUrl = "http://auth.example.com"),
      'OAUTH_ISSUER_URL must use https unless it is a loopback address: "http://auth.example.com".',
    ],
    [
      "OAUTH_JWKS_URI is plain http off this host",
      () => (config.oauthJwksUri = "http://auth.example.com/jwks"),
      'OAUTH_JWKS_URI must use https unless it is a loopback address: "http://auth.example.com/jwks".',
    ],
    [
      "OAUTH_REQUIRED_SCOPES contains offline_access",
      () => (config.oauthRequiredScopes = ["mcp:tools", "offline_access"]),
      "OAUTH_REQUIRED_SCOPES must not contain offline_access: clients request it from the authorization server to get refresh tokens; it is not a scope of this resource.",
    ],
  ])("when %s", async (_name, misconfigure, message) => {
    misconfigure();
    await expect(createHttpAuth(context())).rejects.toMatchObject({
      code: JsonRpcErrorCode.ConfigurationError,
      message,
    });
  });

  it("allows a plain-http issuer on a loopback address", async () => {
    config.oauthIssuerUrl = "http://127.0.0.1:9000";
    config.oauthJwksUri = "http://127.0.0.1:9000/jwks";
    await expect(createHttpAuth(context())).resolves.toBeTruthy();
  });

  it("says at startup that SQL runs as the service account", async () => {
    const info = vi.spyOn(logger, "info");
    await createHttpAuth(context());
    expect(JSON.stringify(info.mock.calls)).toContain(
      "all SQL runs as the configured service account",
    );
  });
});

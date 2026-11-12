/**
 * Tests how the HTTP transport runs the built-in IBM i sign-on
 * (MCP_AUTH_MODE=oauth without OAUTH_ISSUER_URL): where the authorization
 * server is mounted in the app, and the lifecycle of the grant manager, the
 * admin socket and the query router around the listening server.
 *
 * The lifecycle cases start the real transport on a loopback port with the
 * real grant manager and authorization server against the in-process fake
 * Mapepire server. Every credential is made up; no IBM i is involved.
 *
 * @module tests/mcp-server/transports/http/builtinSignOnTransport.test
 */

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { ServerResponse } from "node:http";
import { createServer, type AddressInfo, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { Hono } from "hono";
import { config } from "../../../../src/config/index.js";
import { sendAdminCommand } from "../../../../src/ibmi-mcp-server/oauth/adminSocket.js";
import type {
  AuthorizationServer,
  GrantManager,
  GrantManagerStatus,
} from "../../../../src/ibmi-mcp-server/oauth/contracts.js";
import { createGrantManager } from "../../../../src/ibmi-mcp-server/oauth/grantManager.js";
import { createMapepireClient } from "../../../../src/ibmi-mcp-server/oauth/mapepireSession.js";
import { executeQuery } from "../../../../src/ibmi-mcp-server/services/queryRouter.js";
import { SourceManager } from "../../../../src/ibmi-mcp-server/services/sourceManager.js";
import {
  authContext,
  createHttpAuth,
} from "../../../../src/mcp-server/transports/auth/index.js";
import {
  createHttpApp,
  startHttpTransport,
} from "../../../../src/mcp-server/transports/http/httpTransport.js";
import { JsonRpcErrorCode } from "../../../../src/types-global/errors.js";
import {
  rateLimiter,
  requestContextService,
} from "../../../../src/utils/index.js";
import {
  FAKE_PASSWORD,
  FAKE_PROFILE,
  startFakeMapepire,
  type FakeMapepire,
} from "../../../ibmi-mcp-server/oauth/fakeMapepire.js";

// The real grant manager, with the instance the transport creates on record.
vi.mock(
  "../../../../src/ibmi-mcp-server/oauth/grantManager.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../../src/ibmi-mcp-server/oauth/grantManager.js")
      >();
    return { createGrantManager: vi.fn(actual.createGrantManager) };
  },
);

const HOST = "localhost:3010";
const REDIRECT = "http://127.0.0.1:33418/callback";
/** A registered client: its id holds its redirect URI, so nothing is fetched. */
const CLIENT_ID =
  "self." +
  Buffer.from(JSON.stringify({ redirect_uris: [REDIRECT] })).toString(
    "base64url",
  );
const VERIFIER = "pkce-verifier-".repeat(4);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");
const SQL = "SELECT 1 FROM SYSIBM.SYSDUMMY1";

const saved = {
  config: {
    mcpHttpHost: config.mcpHttpHost,
    mcpHttpPort: config.mcpHttpPort,
    mcpAllowedHosts: config.mcpAllowedHosts,
    mcpAllowedOrigins: config.mcpAllowedOrigins,
    mcpAuthMode: config.mcpAuthMode,
    mcpResourceUrl: config.mcpResourceUrl,
    oauthIssuerUrl: config.oauthIssuerUrl,
  },
  oauth: {
    codeAddressBinding: config.oauth.codeAddressBinding,
    grantMaxHours: config.oauth.grantMaxHours,
    idleCloseMinutes: config.oauth.idleCloseMinutes,
    maxConnections: config.oauth.maxConnections,
    allowedProfiles: config.oauth.allowedProfiles,
    allowPrivilegedProfiles: config.oauth.allowPrivilegedProfiles,
    signOnMaxFailures: config.oauth.signOnMaxFailures,
    adminSocket: config.oauth.adminSocket,
  },
  mapepireHost: config.oauth.mapepire.host,
  rateLimitEnabled: config.rateLimit.enabled,
  ibmiHttpAuthEnabled: config.ibmiHttpAuth.enabled,
  limiter: rateLimiter.getConfig(),
};

const context = () =>
  requestContextService.createRequestContext({
    operation: "builtinSignOnTransportTest",
  });

/** A port nothing is listening on. */
const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });

let directory: string;

beforeAll(() => {
  // Short: a Unix socket path is limited to about 100 bytes.
  directory = mkdtempSync(join(tmpdir(), "mcp-signon-"));
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

beforeEach(async () => {
  Object.assign(config, {
    mcpHttpHost: "127.0.0.1",
    mcpHttpPort: await freePort(),
    mcpAllowedHosts: undefined,
    mcpAllowedOrigins: undefined,
    mcpAuthMode: "oauth",
    oauthIssuerUrl: undefined,
  });
  config.mcpResourceUrl = `http://127.0.0.1:${config.mcpHttpPort}/mcp`;
  Object.assign(config.oauth, {
    codeAddressBinding: "strict",
    grantMaxHours: 12,
    idleCloseMinutes: 10,
    maxConnections: 50,
    allowedProfiles: [],
    allowPrivilegedProfiles: false,
    signOnMaxFailures: 2,
    adminSocket: undefined,
  });
  config.oauth.mapepire.host = "127.0.0.1";
  config.rateLimit.enabled = false;
  config.ibmiHttpAuth.enabled = false;
  vi.mocked(createGrantManager).mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  Object.assign(config, saved.config);
  Object.assign(config.oauth, saved.oauth);
  config.oauth.mapepire.host = saved.mapepireHost;
  config.rateLimit.enabled = saved.rateLimitEnabled;
  config.ibmiHttpAuth.enabled = saved.ibmiHttpAuthEnabled;
  rateLimiter.reset();
  rateLimiter.configure(saved.limiter);
});

describe("createHttpApp with the built-in authorization server", () => {
  const paths: AuthorizationServer["paths"] = {
    metadata: "/.well-known/oauth-authorization-server/ibmi",
    authorize: "/ibmi/oauth/authorize",
    token: "/ibmi/oauth/token",
    revoke: "/ibmi/oauth/revoke",
    register: "/ibmi/oauth/register",
  };
  const status: GrantManagerStatus = {
    grants: 3,
    openConnections: 2,
    maxConnections: 50,
    blockedProfiles: 1,
  };
  let mcpRequests: number;

  /** An authorization server whose routes only say they were reached. */
  function stubAuthorizationServer(): AuthorizationServer {
    const app: AuthorizationServer["app"] = new Hono();
    app.get(paths.metadata, (c) => c.json({ reached: "metadata" }));
    app.get(paths.authorize, (c) => {
      c.header("Referrer-Policy", "same-origin");
      return c.html("sign-in page");
    });
    app.post(paths.authorize, (c) => {
      c.header("Referrer-Policy", "same-origin");
      return c.html("signed on");
    });
    app.post(paths.token, (c) => c.json({ reached: "token" }));
    app.post(paths.revoke, (c) => c.json({ reached: "revoke" }));
    app.post(paths.register, (c) => c.json({ reached: "register" }));
    return { app, paths };
  }

  async function buildApp() {
    const grants = {
      authenticate: async () => "invalid_token" as const,
      status: () => status,
    };
    return createHttpApp(
      {
        fetch: async () => {
          mcpRequests += 1;
          return new Response("served");
        },
      },
      context(),
      await createHttpAuth(context(), grants),
      { grants, authorizationServer: stubAuthorizationServer() },
    );
  }

  const routes: Array<[keyof typeof paths, string]> = [
    ["metadata", "GET"],
    ["authorize", "GET"],
    ["authorize", "POST"],
    ["token", "POST"],
    ["revoke", "POST"],
    ["register", "POST"],
  ];

  beforeEach(() => {
    config.mcpResourceUrl = "https://apps.example.com/ibmi/mcp";
    mcpRequests = 0;
  });

  it.each(routes)(
    "serves %s (%s) without a token, while the MCP endpoint asks for one",
    async (route, method) => {
      const app = await buildApp();

      const response = await app.request(paths[route], {
        method,
        headers: { host: HOST },
      });

      expect(response.status).toBe(200);
      const mcp = await app.request("/mcp", {
        method: "POST",
        headers: { host: HOST },
      });
      expect(mcp.status).toBe(401);
      expect(mcpRequests).toBe(0);
    },
  );

  it.each(["GET", "POST"])(
    "leaves the headers of the sign-in page (%s) to the page",
    async (method) => {
      const app = await buildApp();

      const response = await app.request(paths.authorize, {
        method,
        headers: { host: HOST },
      });

      // hono/secure-headers would send no-referrer, and frame and
      // cross-origin policies of its own.
      expect(response.headers.get("referrer-policy")).toBe("same-origin");
      expect(response.headers.get("x-frame-options")).toBeNull();
      expect(response.headers.get("cross-origin-opener-policy")).toBeNull();
    },
  );

  it("keeps the security headers on every other route", async () => {
    const app = await buildApp();

    for (const [path, method] of [
      [paths.token, "POST"],
      [paths.metadata, "GET"],
      ["/healthz", "GET"],
      ["/mcp", "POST"],
      // Only the sign-in page itself is exempt, not what is under it.
      [`${paths.authorize}/other`, "GET"],
    ] as const) {
      const response = await app.request(path, {
        method,
        headers: { host: HOST },
      });
      expect(response.headers.get("x-frame-options")).toBe("SAMEORIGIN");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    }
  });

  it.each(routes)(
    "counts requests to %s (%s) against the client address",
    async (route, method) => {
      config.rateLimit.enabled = true;
      rateLimiter.reset();
      rateLimiter.configure({
        windowMs: 60_000,
        maxRequests: 2,
        skipInDevelopment: false,
      });
      const app = await buildApp();
      const from = async (address: string) => {
        const response = await app.request(
          paths[route],
          { method, headers: { host: HOST } },
          { incoming: { socket: { remoteAddress: address } } },
        );
        return response.status;
      };

      expect(await from("10.1.1.1")).toBe(200);
      expect(await from("10.1.1.1")).toBe(200);
      expect(await from("10.1.1.1")).toBe(429);
      expect(await from("10.1.1.2")).toBe(200);
    },
  );

  it("validates the Host header on the authorization server's routes", async () => {
    const app = await buildApp();

    const response = await app.request(paths.token, {
      method: "POST",
      headers: { host: "evil.example.com" },
    });

    expect(response.status).toBe(403);
  });

  it("accepts the sign-in form from the server's own public origin behind MCP_ALLOWED_HOSTS=*, and from no other", async () => {
    // A proxy that rewrites Host: the Origin a browser sends with the form
    // is still the public origin, which no MCP_ALLOWED_HOSTS entry names.
    config.mcpAllowedHosts = ["*"];
    const app = await buildApp();
    const submit = (origin: string) =>
      app.request(paths.authorize, {
        method: "POST",
        headers: { host: "internal:3010", origin },
      });

    const own = await submit("https://apps.example.com");
    expect(own.status).toBe(200);
    expect(await own.text()).toBe("signed on");
    // Accepted as the page's own origin, not as a cross-origin caller.
    expect(own.headers.get("access-control-allow-origin")).toBeNull();
    for (const other of [
      "https://evil.example.com",
      "http://apps.example.com",
      "https://apps.example.com:8443",
      "null",
    ]) {
      expect((await submit(other)).status, other).toBe(403);
    }
  });

  it("applies MCP_ALLOWED_ORIGINS to the authorization server's routes", async () => {
    config.mcpAllowedOrigins = ["https://app.example.com"];
    const app = await buildApp();
    const preflight = (origin: string) =>
      app.request(paths.token, {
        method: "OPTIONS",
        headers: {
          host: HOST,
          origin,
          "access-control-request-method": "POST",
        },
      });

    const allowed = await preflight("https://app.example.com");
    expect(allowed.headers.get("access-control-allow-origin")).toBe(
      "https://app.example.com",
    );
    expect((await preflight("https://other.example.com")).status).toBe(403);
  });

  it("reports sign-on counts on /healthz, nothing else of the grants, and no service pool", async () => {
    const getInstance = vi.spyOn(SourceManager, "getInstance");
    const app = await buildApp();

    const response = await app.request("/healthz", {
      headers: { host: HOST },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      timestamp: expect.any(String),
      signOn: {
        grants: 3,
        openConnections: 2,
        maxConnections: 50,
        blockedProfiles: 1,
      },
    });
    expect(getInstance).not.toHaveBeenCalled();
  });
});

describe("startHttpTransport with the built-in IBM i sign-on", () => {
  let fake: FakeMapepire;
  let transport: { close(): Promise<void> } | undefined;
  let base: string;

  /** A server whose one tool runs a statement through the query router. */
  function createTestServer(): McpServer {
    const server = new McpServer(
      { name: "builtin-sign-on-test", version: "0.0.0" },
      { capabilities: { tools: {} } },
    );
    server.registerTool(
      "run_sql",
      { description: "Runs one statement." },
      async () => {
        const result = await executeQuery(SQL);
        return {
          content: [{ type: "text", text: JSON.stringify(result.success) }],
        };
      },
    );
    return server;
  }

  async function start() {
    transport = await startHttpTransport(
      createTestServer,
      context(),
      createMapepireClient({
        host: "127.0.0.1",
        port: fake.port,
        trust: { kind: "pin", pem: Buffer.from(fake.certPem) },
      }),
    );
  }

  /** The grant manager the transport created. */
  const grants = (): GrantManager =>
    vi.mocked(createGrantManager).mock.results[0]!.value as GrantManager;

  /** Signs TESTUSER on at the fake and exchanges the code. */
  async function signOn() {
    const address = "127.0.0.1";
    const signedOn = await grants().signOn({
      profile: Buffer.from(FAKE_PROFILE),
      password: Buffer.from(FAKE_PASSWORD),
      clientId: CLIENT_ID,
      redirectUri: REDIRECT,
      codeChallenge: CHALLENGE,
      address,
    });
    if (!signedOn.ok) throw new Error(`sign-on refused: ${signedOn.reason}`);
    const tokens = await grants().exchangeCode({
      code: Buffer.from(signedOn.code),
      codeVerifier: VERIFIER,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT,
      address,
    });
    if (!tokens.ok) throw new Error(`code exchange failed: ${tokens.error}`);
    return {
      grantId: signedOn.grantId,
      accessToken: tokens.accessToken.toString("latin1"),
    };
  }

  /** Calls the run_sql tool over HTTP with a bearer token. */
  async function runSql(accessToken: string) {
    const client = new Client({ name: "sign-on-test", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        authProvider: { token: async () => accessToken },
      }),
    );
    try {
      return await client.callTool({ name: "run_sql" });
    } finally {
      await client.close();
    }
  }

  beforeEach(async () => {
    base = `http://127.0.0.1:${config.mcpHttpPort}`;
    fake = await startFakeMapepire({
      statements: [
        {
          match: "USER_INFO_BASIC",
          reply: {
            rows: [
              {
                STATUS: "*ENABLED",
                PASSWORD_CHANGE_DATE: "2026-01-01 00:00:00.000000",
                SPECIAL_AUTHORITIES: null,
              },
            ],
          },
        },
      ],
    });
  });

  afterEach(async () => {
    fake.drop();
    await transport?.close();
    transport = undefined;
    await fake.stop();
  });

  it("starts without contacting Mapepire, and serves the authorization server, its discovery and the health counts", async () => {
    await start();

    expect(fake.httpRequests).toBe(0);
    expect(fake.upgrades).toBe(0);

    const health = await fetch(`${base}/healthz`);
    expect(await health.json()).toEqual({
      status: "ok",
      timestamp: expect.any(String),
      signOn: {
        grants: 0,
        openConnections: 0,
        maxConnections: 50,
        blockedProfiles: 0,
      },
    });

    const unauthenticated = await fetch(`${base}/mcp`, { method: "POST" });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("www-authenticate")).toContain(
      `resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
    );

    const resource = await fetch(
      `${base}/.well-known/oauth-protected-resource/mcp`,
    );
    expect(await resource.json()).toMatchObject({
      authorization_servers: [base],
    });

    const metadata = await fetch(
      `${base}/.well-known/oauth-authorization-server`,
    );
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({
      issuer: base,
      token_endpoint: `${base}/oauth/token`,
    });
  });

  it("runs a tool's SQL on the IBM i job of the caller's sign-on", async () => {
    await start();
    const { accessToken } = await signOn();

    const result = await runSql(accessToken);

    expect(result.isError).toBeFalsy();
    expect(fake.requests).toContainEqual(
      expect.objectContaining({ profile: FAKE_PROFILE, sql: SQL }),
    );
    expect(
      (await (await fetch(`${base}/healthz`)).json()) as unknown,
    ).toMatchObject({ signOn: { grants: 1, openConnections: 1 } });
  });

  it("signs a user on over HTTP: sign-in page, token endpoint, then a tool call as that user", async () => {
    await start();
    const authorize = new URL(`${base}/oauth/authorize`);
    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      code_challenge: CHALLENGE,
      code_challenge_method: "S256",
      state: "state-123",
    }).toString();

    const page = await fetch(authorize);
    expect(page.status).toBe(200);
    // The page's own policy, not the no-referrer of the other routes.
    expect(page.headers.get("referrer-policy")).toBe("same-origin");
    const loginRequest = /name="login_request" value="([^"]+)"/.exec(
      await page.text(),
    )?.[1];
    expect(loginRequest).toBeDefined();

    const signedOn = await fetch(`${base}/oauth/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: { origin: base },
      body: new URLSearchParams({
        login_request: loginRequest!,
        profile: FAKE_PROFILE,
        password: FAKE_PASSWORD,
      }),
    });
    expect(signedOn.status).toBe(303);
    const callback = new URL(signedOn.headers.get("location")!);
    expect(callback.origin + callback.pathname).toBe(REDIRECT);
    expect(callback.searchParams.get("state")).toBe("state-123");

    const token = await fetch(`${base}/oauth/token`, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: callback.searchParams.get("code")!,
        code_verifier: VERIFIER,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT,
      }),
    });
    expect(token.status).toBe(200);
    const { access_token: accessToken } = (await token.json()) as {
      access_token: string;
    };

    expect((await runSql(accessToken)).isError).toBeFalsy();
    expect(fake.signOns(FAKE_PROFILE)).toBe(1);
    expect(fake.requests).toContainEqual(
      expect.objectContaining({ profile: FAKE_PROFILE, sql: SQL }),
    );
  });

  it("zero-fills the bytes Node.js writes for a token response, through every middleware of the transport", async () => {
    // A browser client: CORS adds its headers to the token response.
    config.mcpAllowedOrigins = ["https://app.example.com"];
    await start();
    const written: Uint8Array[] = [];
    for (const method of ["write", "end"] as const) {
      const original = ServerResponse.prototype[method] as (
        this: ServerResponse,
        ...args: unknown[]
      ) => unknown;
      vi.spyOn(ServerResponse.prototype, method).mockImplementation(function (
        this: ServerResponse,
        ...args: unknown[]
      ) {
        if (this.req.url === "/oauth/token" && args[0] instanceof Uint8Array) {
          written.push(args[0]);
        }
        return original.apply(this, args) as ServerResponse;
      });
    }
    const signedOn = await grants().signOn({
      profile: Buffer.from(FAKE_PROFILE),
      password: Buffer.from(FAKE_PASSWORD),
      clientId: CLIENT_ID,
      redirectUri: REDIRECT,
      codeChallenge: CHALLENGE,
      address: "127.0.0.1",
    });
    if (!signedOn.ok) throw new Error(`sign-on refused: ${signedOn.reason}`);

    const response = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { origin: "https://app.example.com" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: signedOn.code,
        code_verifier: VERIFIER,
        client_id: CLIENT_ID,
      }),
    });
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://app.example.com",
    );
    const text = await response.text();
    expect(response.status, text).toBe(200);
    const { refresh_token: refreshToken } = JSON.parse(text) as {
      refresh_token: string;
    };

    // The body went out as written chunks; each is wiped once written.
    expect(written.reduce((sum, chunk) => sum + chunk.length, 0)).toBe(
      Buffer.byteLength(text),
    );
    await vi.waitFor(() =>
      expect(written.every((chunk) => chunk.every((byte) => byte === 0))).toBe(
        true,
      ),
    );
    expect(
      written.some((chunk) => Buffer.from(chunk).includes(refreshToken)),
    ).toBe(false);
  });

  it("close ends every sign-on: the IBM i connections are closed and no statement can run", async () => {
    await start();
    const { grantId } = await signOn();
    expect(fake.openSockets).toBe(1);

    await transport!.close();
    transport = undefined;

    // The fake hears of the close a moment after the server has closed.
    await vi.waitFor(() => expect(fake.openSockets).toBe(0));
    expect(fake.requests).toContainEqual(
      expect.objectContaining({ profile: FAKE_PROFILE, type: "exit" }),
    );
    expect(grants().status()).toMatchObject({ grants: 0, openConnections: 0 });
    const asCaller = {
      authInfo: {
        token: `grant:${grantId}`,
        clientId: CLIENT_ID,
        scopes: [],
        extra: { subject: FAKE_PROFILE, grantId },
      },
    };
    await expect(
      authContext.run(asCaller, () => executeQuery(SQL)),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.Unauthorized });
  });

  it("close ends the sign-ons even when closing the HTTP side fails", async () => {
    const started = await startHttpTransport(
      createTestServer,
      context(),
      createMapepireClient({
        host: "127.0.0.1",
        port: fake.port,
        trust: { kind: "pin", pem: Buffer.from(fake.certPem) },
      }),
    );
    transport = started;
    await signOn();
    const handlerClose = vi
      .spyOn(started.handler, "close")
      .mockRejectedValue(new Error("handler stuck"));

    await expect(started.close()).rejects.toThrow("handler stuck");

    await vi.waitFor(() => expect(fake.openSockets).toBe(0));
    expect(grants().status().grants).toBe(0);
    handlerClose.mockRestore();
  });

  it("runs the admin socket of OAUTH_ADMIN_SOCKET for as long as it listens", async () => {
    const path = join(directory, "admin.sock");
    config.oauth.adminSocket = path;

    await start();

    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(await sendAdminCommand(path, "status")).toBe(
      "grants=0 connections=0/50 blocked=0",
    );

    await transport!.close();
    transport = undefined;
    expect(existsSync(path)).toBe(false);
  });

  it("leaves nothing running when the port is in use", async () => {
    const path = join(directory, "admin-in-use.sock");
    config.oauth.adminSocket = path;
    const occupied = await new Promise<Server>((resolve) => {
      const server = createServer();
      server.listen(config.mcpHttpPort, "127.0.0.1", () => resolve(server));
    });

    try {
      await expect(start()).rejects.toMatchObject({
        code: JsonRpcErrorCode.ConfigurationError,
        message: expect.stringContaining("is already in use"),
      });
    } finally {
      await new Promise((resolve) => occupied.close(resolve));
    }

    expect(existsSync(path)).toBe(false);
    // A sign-on after shutdown is refused: the manager was shut down.
    expect(
      await grants().signOn({
        profile: Buffer.from(FAKE_PROFILE),
        password: Buffer.from(FAKE_PASSWORD),
        clientId: CLIENT_ID,
        redirectUri: REDIRECT,
        codeChallenge: CHALLENGE,
        address: "127.0.0.1",
      }),
    ).toEqual({ ok: false, reason: "at_capacity" });
    expect(fake.upgrades).toBe(0);
  });

  it("without a Mapepire client it starts no grant manager and reports the service pools", async () => {
    config.mcpAuthMode = "none";

    transport = await startHttpTransport(createTestServer, context());

    expect(createGrantManager).not.toHaveBeenCalled();
    expect(await (await fetch(`${base}/healthz`)).json()).toEqual({
      status: "ok",
      timestamp: expect.any(String),
      pools: {},
    });
  });
});

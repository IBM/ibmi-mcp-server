/**
 * Tests for MCP_AUTH_MODE=oauth without OAUTH_ISSUER_URL, as the MCP endpoint
 * sees it: which auth mode is selected, what the server refuses to start
 * with, and how an access token of the built-in authorization server is
 * accepted or refused.
 *
 * Drives the real Hono app (createHttpApp + createHttpAuth) with a real
 * grant manager against the in-process fake Mapepire server. Every
 * credential is made up; no IBM i is involved.
 *
 * @module tests/mcp-server/transports/auth/builtinOAuth.test
 */

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import inspector from "node:inspector";
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
import { config } from "../../../../src/config/index.js";
import type { GrantManager } from "../../../../src/ibmi-mcp-server/oauth/contracts.js";
import { createGrantManager } from "../../../../src/ibmi-mcp-server/oauth/grantManager.js";
import { createMapepireClient } from "../../../../src/ibmi-mcp-server/oauth/mapepireSession.js";
import {
  authContext,
  createBuiltinMapepireClient,
  createHttpAuth,
} from "../../../../src/mcp-server/transports/auth/index.js";
import { createHttpApp } from "../../../../src/mcp-server/transports/http/httpTransport.js";
import { JsonRpcErrorCode } from "../../../../src/types-global/errors.js";
import { logger, requestContextService } from "../../../../src/utils/index.js";
import {
  FAKE_PASSWORD,
  FAKE_PROFILE,
  startFakeMapepire,
  type FakeMapepire,
} from "../../../ibmi-mcp-server/oauth/fakeMapepire.js";
import {
  ISSUER,
  startFakeAuthorizationServer,
} from "./fakeAuthorizationServer.js";

const HOST = "localhost:3010";
const RESOURCE = "https://mcp.example.com/mcp";
const METADATA_URL =
  "https://mcp.example.com/.well-known/oauth-protected-resource/mcp";
const CLIENT_ID = "https://client.example/oauth/metadata.json";
const REDIRECT = "http://127.0.0.1:33418/callback";
const ADDRESS = "10.1.2.3";
const VERIFIER = "pkce-verifier-".repeat(4);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");
const MINUTE = 60_000;

const ENV_NAMES = [
  "DB2i_PASS",
  "DB2i_IGNORE_UNAUTHORIZED",
  "DB2i_JDBC_OPTIONS",
] as const;

const saved = {
  config: {
    mcpTransportType: config.mcpTransportType,
    mcpHttpHost: config.mcpHttpHost,
    mcpAllowedHosts: config.mcpAllowedHosts,
    mcpAllowedOrigins: config.mcpAllowedOrigins,
    mcpAuthMode: config.mcpAuthMode,
    mcpResourceUrl: config.mcpResourceUrl,
    mcpTlsCertFile: config.mcpTlsCertFile,
    mcpTlsKeyFile: config.mcpTlsKeyFile,
    mcpTrustedProxies: config.mcpTrustedProxies,
    oauthIssuerUrl: config.oauthIssuerUrl,
    oauthJwksUri: config.oauthJwksUri,
  },
  oauth: {
    codeAddressBinding: config.oauth.codeAddressBinding,
    grantMaxHours: config.oauth.grantMaxHours,
    idleCloseMinutes: config.oauth.idleCloseMinutes,
    maxConnections: config.oauth.maxConnections,
    allowedProfiles: config.oauth.allowedProfiles,
    allowPrivilegedProfiles: config.oauth.allowPrivilegedProfiles,
    signOnMaxFailures: config.oauth.signOnMaxFailures,
  },
  mapepire: { ...config.oauth.mapepire },
  rateLimitEnabled: config.rateLimit.enabled,
  ibmiHttpAuth: { ...config.ibmiHttpAuth },
  env: Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]])),
};

const context = () =>
  requestContextService.createRequestContext({ operation: "builtinOAuthTest" });

let directory: string;
let fake: FakeMapepire;
let clock: number;
let grants: GrantManager;
/** Every log call of a test, as JSON. */
let lines: string[];
/** The identity the MCP handler was given for the last request it served. */
let served: { passed?: unknown; inContext?: unknown } | undefined;

/** Stands in for the SDK handler: records the identity it is called with. */
const mcpHandler = {
  fetch: async (_request: Request, options?: { authInfo?: unknown }) => {
    served = {
      passed: options?.authInfo,
      inContext: authContext.getStore()?.authInfo,
    };
    return new Response("served");
  },
};

/** Builds the app the way startHttpTransport does. */
async function buildApp(manager: GrantManager | undefined = grants) {
  return createHttpApp(
    mcpHandler,
    context(),
    await createHttpAuth(context(), manager),
  );
}

type TestApp = Awaited<ReturnType<typeof buildApp>>;

function callMcp(app: TestApp, bearer?: string) {
  return app.request("/mcp", {
    method: "POST",
    headers: {
      host: HOST,
      "content-type": "application/json",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
}

/** Signs TESTUSER on at the fake and exchanges the code. */
async function signOn() {
  const signedOn = await grants.signOn({
    profile: Buffer.from(FAKE_PROFILE),
    password: Buffer.from(FAKE_PASSWORD),
    clientId: CLIENT_ID,
    redirectUri: REDIRECT,
    codeChallenge: CHALLENGE,
    address: ADDRESS,
  });
  if (!signedOn.ok) throw new Error(`sign-on refused: ${signedOn.reason}`);
  const tokens = await grants.exchangeCode({
    code: Buffer.from(signedOn.code),
    codeVerifier: VERIFIER,
    clientId: CLIENT_ID,
    redirectUri: REDIRECT,
    address: ADDRESS,
  });
  if (!tokens.ok) throw new Error(`code exchange failed: ${tokens.error}`);
  return {
    grantId: signedOn.grantId,
    accessToken: tokens.accessToken.toString("latin1"),
    refreshToken: tokens.refreshToken.toString("latin1"),
  };
}

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "ibmi-mcp-builtin-oauth-"));
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

beforeEach(async () => {
  Object.assign(config, {
    mcpTransportType: "http",
    mcpHttpHost: "127.0.0.1",
    mcpAllowedHosts: undefined,
    mcpAllowedOrigins: undefined,
    mcpAuthMode: "oauth",
    mcpResourceUrl: RESOURCE,
    mcpTlsCertFile: undefined,
    mcpTlsKeyFile: undefined,
    // The TLS proxy on this host that serves the public resource URL.
    mcpTrustedProxies: ["127.0.0.1/32"],
    oauthIssuerUrl: undefined,
    oauthJwksUri: undefined,
  });
  Object.assign(config.oauth, {
    codeAddressBinding: "strict",
    grantMaxHours: 12,
    idleCloseMinutes: 10,
    maxConnections: 50,
    allowedProfiles: [],
    allowPrivilegedProfiles: false,
    signOnMaxFailures: 2,
  });
  config.rateLimit.enabled = false;
  Object.assign(config.ibmiHttpAuth, {
    enabled: false,
    allowedHosts: ["ibmi.example.com"],
  });
  for (const name of ENV_NAMES) {
    delete process.env[name];
  }

  served = undefined;
  lines = [];
  for (const level of ["debug", "info", "warning", "error"] as const) {
    vi.spyOn(logger, level).mockImplementation((...args: unknown[]) => {
      lines.push(JSON.stringify(args));
    });
  }
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
  Object.assign(config.oauth.mapepire, {
    host: "127.0.0.1",
    port: fake.port,
    serverCertFile: undefined,
    caFile: undefined,
  });
  clock = Date.now();
  grants = createGrantManager({
    mapepire: createMapepireClient({
      host: "127.0.0.1",
      port: fake.port,
      trust: { kind: "pin", pem: Buffer.from(fake.certPem) },
    }),
    now: () => clock,
  });
});

afterEach(async () => {
  fake.drop();
  await grants.shutdown();
  await fake.stop();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Object.assign(config, saved.config);
  Object.assign(config.oauth, saved.oauth);
  Object.assign(config.oauth.mapepire, saved.mapepire);
  Object.assign(config.ibmiHttpAuth, saved.ibmiHttpAuth);
  config.rateLimit.enabled = saved.rateLimitEnabled;
  for (const name of ENV_NAMES) {
    if (saved.env[name] === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = saved.env[name];
    }
  }
});

describe("built-in OAuth: access tokens at the MCP endpoint", () => {
  it("accepts a grant's access token and hands the handler the grant, never the bearer", async () => {
    const app = await buildApp();
    const { grantId, accessToken } = await signOn();

    const response = await callMcp(app, accessToken);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("served");
    const identity = {
      token: `grant:${grantId}`,
      clientId: CLIENT_ID,
      scopes: [],
      // OAUTH_IDLE_CLOSE_MINUTES (10) plus 5 minutes.
      expiresAt: Math.floor((clock + 15 * MINUTE) / 1000),
      extra: { subject: FAKE_PROFILE, grantId },
      resourceMetadataUrl: METADATA_URL,
    };
    expect(served?.passed).toEqual(identity);
    expect(served?.inContext).toEqual(identity);
    expect(JSON.stringify(served)).not.toContain(accessToken);
    expect(lines.filter((line) => line.includes(accessToken))).toEqual([]);
  });

  it.each([
    ["a token it never issued", async () => "never-issued-token"],
    ["a refresh token", async () => (await signOn()).refreshToken],
    [
      "an access token past its lifetime",
      async () => {
        const { accessToken } = await signOn();
        clock += 16 * MINUTE;
        return accessToken;
      },
    ],
    [
      "the access token of a sign-on that has ended",
      async () => {
        const { accessToken } = await signOn();
        await grants.revoke(Buffer.from(accessToken));
        return accessToken;
      },
    ],
  ])("refuses %s with a 401 invalid_token challenge", async (_case, token) => {
    const app = await buildApp();
    const bearer = await token();

    const response = await callMcp(app, bearer);

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer error="invalid_token", error_description="Invalid access token", resource_metadata="${METADATA_URL}"`,
    );
    expect(await response.json()).toEqual({
      error: "invalid_token",
      error_description: "Invalid access token",
    });
    expect(served).toBeUndefined();
    expect(lines.filter((line) => line.includes(bearer))).toEqual([]);
  });

  it("refuses a request without a token, pointing at the resource metadata", async () => {
    const response = await callMcp(await buildApp());

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer error="invalid_token", error_description="Missing Authorization header", resource_metadata="${METADATA_URL}"`,
    );
    expect(served).toBeUndefined();
  });

  it('answers "connection closed, refresh" when the grant stands but its IBM i connection is closed', async () => {
    const app = await buildApp();
    const { accessToken } = await signOn();
    expect((await callMcp(app, accessToken)).status).toBe(200);
    served = undefined;

    fake.drop();
    await vi.waitFor(() => expect(grants.status().openConnections).toBe(0));
    const response = await callMcp(app, accessToken);

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer error="invalid_token", error_description="connection closed, refresh", resource_metadata="${METADATA_URL}"`,
    );
    expect(grants.status().grants).toBe(1);
    expect(served).toBeUndefined();
  });

  it("asks the grant manager on every request", async () => {
    const authenticate = vi.spyOn(grants, "authenticate");
    const app = await buildApp();
    const { accessToken } = await signOn();

    await callMcp(app, accessToken);
    await callMcp(app, accessToken);

    expect(authenticate).toHaveBeenCalledTimes(2);
    expect(authenticate).toHaveBeenCalledWith(accessToken);
  });

  it("ignores OAUTH_REQUIRED_SCOPES: the built-in authorization server issues no scopes", async () => {
    const savedScopes = config.oauthRequiredScopes;
    config.oauthRequiredScopes = ["mcp:tools"];
    try {
      const app = await buildApp();
      const { accessToken } = await signOn();

      expect((await callMcp(app, accessToken)).status).toBe(200);
    } finally {
      config.oauthRequiredScopes = savedScopes;
    }
  });
});

describe("built-in OAuth: protected resource metadata", () => {
  it.each([
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
  ])(
    "serves %s without a token, naming this server as the authorization server",
    async (path) => {
      const app = await buildApp();

      const response = await app.request(path, { headers: { host: HOST } });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        resource: RESOURCE,
        authorization_servers: ["https://mcp.example.com"],
        bearer_methods_supported: ["header"],
      });
    },
  );

  it("names the issuer with its path when the resource is under one", async () => {
    config.mcpResourceUrl = "https://apps.example.com/ibmi/mcp";
    const app = await buildApp();

    const response = await app.request(
      "/.well-known/oauth-protected-resource/ibmi/mcp",
      { headers: { host: HOST } },
    );

    expect(await response.json()).toMatchObject({
      resource: "https://apps.example.com/ibmi/mcp",
      authorization_servers: ["https://apps.example.com/ibmi"],
    });
    expect((await callMcp(app)).headers.get("www-authenticate")).toContain(
      'resource_metadata="https://apps.example.com/.well-known/oauth-protected-resource/ibmi/mcp"',
    );
  });
});

describe("auth mode selection", () => {
  it("MCP_AUTH_MODE=oauth without OAUTH_ISSUER_URL: tokens are looked up in the grant manager", async () => {
    const authenticate = vi.spyOn(grants, "authenticate");
    const auth = await createHttpAuth(context(), grants);

    expect(
      auth?.protectedResourceMetadata?.document.authorization_servers,
    ).toEqual(["https://mcp.example.com"]);
    await callMcp(await buildApp(), "some-token");
    expect(authenticate).toHaveBeenCalledWith("some-token");
  });

  it("MCP_AUTH_MODE=oauth with OAUTH_ISSUER_URL: the external issuer's tokens are verified, the grant manager is not asked", async () => {
    const authenticate = vi.spyOn(grants, "authenticate");
    const authServer = await startFakeAuthorizationServer();
    config.oauthIssuerUrl = ISSUER;

    const app = await buildApp();
    const auth = await createHttpAuth(context(), grants);

    expect(
      auth?.protectedResourceMetadata?.document.authorization_servers,
    ).toEqual([ISSUER]);
    expect((await callMcp(app, await authServer.token())).status).toBe(200);
    expect((await callMcp(app, "not-a-jwt")).status).toBe(401);
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("MCP_AUTH_MODE=none: no authentication, with or without a grant manager", async () => {
    config.mcpAuthMode = "none";

    expect(await createHttpAuth(context(), grants)).toBeNull();
    expect((await callMcp(await buildApp())).status).toBe(200);
  });

  it("MCP_AUTH_MODE=ibmi: IBM i tokens, the grant manager is not asked", async () => {
    const authenticate = vi.spyOn(grants, "authenticate");
    config.mcpAuthMode = "ibmi";

    const auth = await createHttpAuth(context(), grants);

    expect(auth?.protectedResourceMetadata).toBeUndefined();
    const response = await callMcp(await buildApp(), "some-token");
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBeNull();
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("refuses the built-in mode without a grant manager", async () => {
    await expect(createHttpAuth(context())).rejects.toMatchObject({
      code: JsonRpcErrorCode.ConfigurationError,
      message:
        "MCP_AUTH_MODE=oauth without OAUTH_ISSUER_URL: the built-in IBM i sign-on was not started. Set OAUTH_ISSUER_URL to use an external authorization server.",
    });
  });

  it("refuses the built-in mode without MCP_RESOURCE_URL", async () => {
    config.mcpResourceUrl = undefined;

    await expect(createHttpAuth(context(), grants)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ConfigurationError,
      message: "MCP_RESOURCE_URL is required when MCP_AUTH_MODE=oauth.",
    });
  });
});

describe("built-in OAuth: what the server refuses to start with", () => {
  const refusal = (message: string) => ({
    code: JsonRpcErrorCode.ConfigurationError,
    message,
  });
  const start = () => {
    try {
      createBuiltinMapepireClient();
      return undefined;
    } catch (error) {
      return error;
    }
  };
  const writeFile = (name: string, content: string) => {
    const file = join(directory, name);
    writeFileSync(file, content);
    return file;
  };

  it("starts with the settings of beforeEach, without contacting the IBM i", () => {
    expect(start()).toBeUndefined();
    expect(fake.upgrades).toBe(0);
    expect(fake.httpRequests).toBe(0);
  });

  it("the stdio transport", () => {
    config.mcpTransportType = "stdio";
    expect(start()).toMatchObject(
      refusal(
        "MCP_AUTH_MODE=oauth without OAUTH_ISSUER_URL (users sign on with their IBM i profile) needs the HTTP transport: set MCP_TRANSPORT_TYPE=http.",
      ),
    );
  });

  it.each(["0.0.0.0", "::", "10.1.2.3", "mcp.example.com"])(
    "MCP_HTTP_HOST=%s without a TLS listener",
    (host) => {
      config.mcpHttpHost = host;
      expect(start()).toMatchObject(
        refusal(
          `MCP_HTTP_HOST=${host} is not a loopback address and users type their IBM i password into a page this server serves: set MCP_TLS_CERT_FILE and MCP_TLS_KEY_FILE, or set MCP_HTTP_HOST=127.0.0.1 and put a TLS proxy on this host in front.`,
        ),
      );
    },
  );

  it.each(["localhost", "LOCALHOST", "::1", "127.0.0.2"])(
    "accepts the loopback MCP_HTTP_HOST=%s without a TLS listener",
    (host) => {
      config.mcpHttpHost = host;
      expect(start()).toBeUndefined();
    },
  );

  it("accepts a host that is not loopback with a TLS listener", () => {
    config.mcpHttpHost = "0.0.0.0";
    config.mcpTlsCertFile = "/etc/ssl/mcp.crt";
    config.mcpTlsKeyFile = "/etc/ssl/mcp.key";
    expect(start()).toBeUndefined();
  });

  it.each([
    ["https://mcp.example.com/mcp", "127.0.0.1", "mcp.example.com"],
    ["https://MCP.Example.com:8443/ibmi/mcp", "localhost", "mcp.example.com"],
    ["https://10.1.2.3/mcp", "::1", "10.1.2.3"],
    ["https://[2001:db8::1]/mcp", "127.0.0.1", "2001:db8::1"],
  ])(
    "a public MCP_RESOURCE_URL=%s behind a listener on %s without TLS, when MCP_TRUSTED_PROXIES names no proxy",
    (resourceUrl, host, named) => {
      config.mcpResourceUrl = resourceUrl;
      config.mcpHttpHost = host;
      config.mcpTrustedProxies = [];
      expect(start()).toMatchObject(
        refusal(
          `MCP_RESOURCE_URL names ${named} while the server listens on ${host} without TLS, so a proxy on this host is in front of it, and MCP_TRUSTED_PROXIES does not name that proxy: every user would appear at the proxy's address and pass OAUTH_SIGNON_ALLOWED_CIDRS. Set MCP_TRUSTED_PROXIES=127.0.0.1 (add ::1 if the proxy connects over IPv6) and have the proxy set X-Forwarded-For.`,
        ),
      );
    },
  );

  it.each([
    "http://127.0.0.1:3010/mcp",
    "http://localhost:3010/mcp",
    "http://[::1]:3010/mcp",
    "https://localhost/mcp",
  ])(
    "accepts the loopback MCP_RESOURCE_URL=%s without MCP_TRUSTED_PROXIES: no proxy need be in front",
    (resourceUrl) => {
      config.mcpResourceUrl = resourceUrl;
      config.mcpTrustedProxies = [];
      expect(start()).toBeUndefined();
    },
  );

  it("accepts a public MCP_RESOURCE_URL without MCP_TRUSTED_PROXIES when the server has its own TLS listener", () => {
    config.mcpHttpHost = "0.0.0.0";
    config.mcpTlsCertFile = "/etc/ssl/mcp.crt";
    config.mcpTlsKeyFile = "/etc/ssl/mcp.key";
    config.mcpTrustedProxies = [];
    expect(start()).toBeUndefined();
  });

  it("DB2i_PASS", () => {
    process.env.DB2i_PASS = "dummy-service-Pw";
    expect(start()).toMatchObject(
      refusal(
        "DB2i_PASS must not be set when users sign on with their IBM i profile (MCP_AUTH_MODE=oauth without OAUTH_ISSUER_URL): remove DB2i_PASS, no SQL runs as a service account in this mode.",
      ),
    );
    expect(JSON.stringify(start())).not.toContain("dummy-service-Pw");
  });

  it.each([
    ["true", "DB2i_SERVER_CERT_FILE", "serverCertFile"],
    ["1", "DB2i_CA_FILE", "caFile"],
  ] as const)(
    "DB2i_IGNORE_UNAUTHORIZED=%s together with %s",
    (value, name, setting) => {
      process.env.DB2i_IGNORE_UNAUTHORIZED = value;
      config.oauth.mapepire[setting] = writeFile("trusted.pem", fake.certPem);
      expect(start()).toMatchObject(
        refusal(
          `DB2i_IGNORE_UNAUTHORIZED=true and ${name} contradict each other: the first turns verification of the Mapepire certificate off, the second says what to verify it against. Remove one of them.`,
        ),
      );
      expect(lines).toEqual([]);
    },
  );

  it.each(["false", "0"])(
    "accepts DB2i_IGNORE_UNAUTHORIZED=%s with a certificate file, and warns of nothing",
    (value) => {
      process.env.DB2i_IGNORE_UNAUTHORIZED = value;
      config.oauth.mapepire.serverCertFile = writeFile("pin.pem", fake.certPem);
      expect(start()).toBeUndefined();
      expect(lines).toEqual([]);
    },
  );

  describe("a Mapepire server whose certificate is self-signed and expired", () => {
    let expired: FakeMapepire;
    const signOnThere = () =>
      createBuiltinMapepireClient().signOn(
        FAKE_PROFILE,
        Buffer.from(FAKE_PASSWORD),
        "test-grant",
      );

    beforeEach(async () => {
      expired = await startFakeMapepire({ expiredSelfSignedCert: true });
      config.oauth.mapepire.port = expired.port;
    });

    afterEach(() => expired.stop());

    it.each(["true", "1"])(
      "is signed on to with DB2i_IGNORE_UNAUTHORIZED=%s, after one warning that holds no secret",
      async (value) => {
        process.env.DB2i_IGNORE_UNAUTHORIZED = value;

        const outcome = await signOnThere();

        expect(outcome.class).toBe("ok");
        expect(expired.connects).toMatchObject([
          { profile: FAKE_PROFILE, passwordMatched: true },
        ]);
        expect(vi.mocked(logger.warning).mock.calls).toEqual([
          [
            expect.objectContaining({
              operation: "createBuiltinMapepireClient",
            }),
            "DB2i_IGNORE_UNAUTHORIZED=true: the Mapepire certificate is not verified, so the IBM i passwords users type on the sign-in page are sent to a server whose identity is not checked. Set DB2i_SERVER_CERT_FILE or DB2i_CA_FILE instead to verify it.",
          ],
        ]);
        expect(lines).toHaveLength(1);
        expect(lines[0]).not.toContain(FAKE_PASSWORD);
        if (outcome.class === "ok") await outcome.session.close();
      },
    );

    it.each([undefined, "false"])(
      "is sent nothing with DB2i_IGNORE_UNAUTHORIZED=%s",
      async (value) => {
        if (value !== undefined) process.env.DB2i_IGNORE_UNAUTHORIZED = value;

        expect(await signOnThere()).toEqual({ class: "pre" });

        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(expired.upgrades).toBe(0);
        expect(lines).toEqual([]);
      },
    );
  });

  it("no DB2i_HOST", () => {
    config.oauth.mapepire.host = undefined;
    expect(start()).toMatchObject(
      refusal(
        "DB2i_HOST is required when users sign on with their IBM i profile (MCP_AUTH_MODE=oauth without OAUTH_ISSUER_URL): set it to the IBM i they sign on to.",
      ),
    );
  });

  it("IBMI_HTTP_AUTH_ENABLED", () => {
    config.ibmiHttpAuth.enabled = true;
    expect(start()).toMatchObject(
      refusal(
        "IBMI_HTTP_AUTH_ENABLED=true cannot be combined with MCP_AUTH_MODE=oauth without OAUTH_ISSUER_URL: remove IBMI_HTTP_AUTH_ENABLED, users sign on at the built-in sign-in page.",
      ),
    );
  });

  it("an active inspector", () => {
    vi.spyOn(inspector, "url").mockReturnValue("ws://127.0.0.1:9229/test");
    expect(start()).toMatchObject(
      refusal(
        "The Node.js inspector is active, and it can read what users type at the IBM i sign-in page: start the server without --inspect.",
      ),
    );
  });

  it.each([
    ["DB2i_SERVER_CERT_FILE", "serverCertFile"],
    ["DB2i_CA_FILE", "caFile"],
  ] as const)("a %s that cannot be read", (name, setting) => {
    const file = join(directory, "missing.pem");
    config.oauth.mapepire[setting] = file;
    expect(start()).toMatchObject(
      refusal(
        `${name}: cannot read ${file} (ENOENT). Set ${name} to a file this process can read.`,
      ),
    );
  });

  it("a DB2i_JDBC_OPTIONS key outside the allowlist", () => {
    process.env.DB2i_JDBC_OPTIONS = "naming=system;user=QSECOFR";
    expect(start()).toMatchObject({
      code: JsonRpcErrorCode.ConfigurationError,
      message: expect.stringMatching(
        /^DB2i_JDBC_OPTIONS: "user" cannot be set/,
      ),
    });
  });

  it("an operator's prompt option in DB2i_JDBC_OPTIONS", () => {
    process.env.DB2i_JDBC_OPTIONS = "prompt=true";
    expect(start()).toMatchObject({
      code: JsonRpcErrorCode.ConfigurationError,
      message: expect.stringMatching(
        /^DB2i_JDBC_OPTIONS: "prompt" cannot be set/,
      ),
    });
  });

  it.each([
    [undefined, "prompt=false"],
    [
      "naming=system;libraries=LIBA,LIBB",
      "prompt=false;naming=system;libraries=LIBA,LIBB",
    ],
  ])(
    "signs on with DB2i_JDBC_OPTIONS=%s and the pinned certificate of DB2i_SERVER_CERT_FILE: prompt=false comes first",
    async (options, props) => {
      if (options !== undefined) process.env.DB2i_JDBC_OPTIONS = options;
      config.oauth.mapepire.serverCertFile = writeFile("pin.pem", fake.certPem);

      const client = createBuiltinMapepireClient();
      const outcome = await client.signOn(
        FAKE_PROFILE,
        Buffer.from(FAKE_PASSWORD),
        "test-grant",
      );

      expect(outcome.class).toBe("ok");
      expect(fake.connects).toHaveLength(1);
      expect(fake.connects[0]).toMatchObject({ profile: FAKE_PROFILE, props });
      if (outcome.class === "ok") await outcome.session.close();
    },
  );

  it("verifies the Mapepire certificate against DB2i_CA_FILE, and against Node's trust store without either file", async () => {
    const signOnHere = () =>
      createBuiltinMapepireClient().signOn(
        FAKE_PROFILE,
        Buffer.from(FAKE_PASSWORD),
        "test-grant",
      );
    config.oauth.mapepire.caFile = writeFile("ca.pem", fake.caPem);
    const outcome = await signOnHere();
    expect(outcome.class).toBe("ok");
    if (outcome.class === "ok") await outcome.session.close();
    expect(fake.upgrades).toBe(1);

    // The fake's certificate is from a CA made up for the test.
    config.oauth.mapepire.caFile = undefined;
    expect(await signOnHere()).toEqual({ class: "pre" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fake.upgrades).toBe(1);
  });
});

/**
 * @fileoverview Tests for the routes of the built-in OAuth authorization
 * server: in-process requests against its Hono app, with a real grant
 * manager that signs on to the in-process fake Mapepire server. Every
 * credential is made up; no IBM i is involved.
 *
 * After each test, no log line may hold a password, a code or a token, no
 * response body may hold a password, and no body but the token endpoint's
 * may hold a token.
 */

import { createHash } from "node:crypto";
import { once } from "node:events";
import type { ServerResponse } from "node:http";
import { connect, type AddressInfo } from "node:net";
import v8 from "node:v8";
import { runInNewContext } from "node:vm";
import { serve } from "@hono/node-server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../../../src/config/index.js";
import { createAuthorizationServer } from "../../../src/ibmi-mcp-server/oauth/authorizationServer.js";
import {
  LOGIN_REQUEST_TTL_MS,
  REFRESH_ROTATION_LIMIT,
  type AuthorizationServer,
  type GrantManager,
  type SignOnRefusal,
  type SignOnRequest,
  type TokenResult,
} from "../../../src/ibmi-mcp-server/oauth/contracts.js";
import { createGrantManager } from "../../../src/ibmi-mcp-server/oauth/grantManager.js";
import { createMapepireClient } from "../../../src/ibmi-mcp-server/oauth/mapepireSession.js";
import {
  JsonRpcErrorCode,
  McpError,
} from "../../../src/types-global/errors.js";
import { logger } from "../../../src/utils/internal/logger.js";
import {
  FAKE_PASSWORD,
  startFakeMapepire,
  type FakeMapepire,
} from "./fakeMapepire.js";
import { hasOwnMemory } from "./ownMemory.js";

const RESOURCE = "https://mcp.example/mcp";
const CLIENT_ID = "https://client.example/oauth/metadata.json";
const REDIRECT = "http://127.0.0.1:33418/callback";
const IPV6_REDIRECT = "http://[::1]:33418/callback";
const HTTPS_REDIRECT = "https://vscode.dev/redirect";
const APP_REDIRECT = "cursor://anysphere.cursor-mcp/oauth/callback";
const ADDRESS = "10.1.2.3";
const OUTSIDE_ADDRESS = "203.0.113.9";
const PROXY = "10.0.0.1";
const STATE = "state-123";
const VERIFIER = "pkce-verifier-".repeat(4);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");
const WRONG_PASSWORD = "wrong-Pw-000";
/** Every character a form has to encode, in a shape that can sign on. */
const SPECIAL_PASSWORD = "p+w &=/?#'<>~1";
const FORM = "application/x-www-form-urlencoded";
const LOOPBACK_NOTE =
  "If your browser then shows a page that can't be reached, don't share its address.";
const PROFILE_ROW = {
  STATUS: "*ENABLED",
  PASSWORD_CHANGE_DATE: "2026-01-01 00:00:00.000000",
  SPECIAL_AUTHORITIES: null,
};
/** The registration request VS Code sends, with its four redirect URIs. */
const VSCODE_REGISTRATION = {
  client_name: "Visual Studio Code",
  client_uri: "https://code.visualstudio.com",
  application_type: "native",
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  redirect_uris: [
    "https://insiders.vscode.dev/redirect",
    "https://vscode.dev/redirect",
    "http://127.0.0.1/",
    "http://127.0.0.1:33418/",
  ],
  token_endpoint_auth_method: "none",
};
const PAGE_HEADERS = {
  "referrer-policy": "same-origin",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "cross-origin-opener-policy": "same-origin",
};
const ALL_REFUSALS: SignOnRefusal[] = [
  "profile_syntax",
  "password_syntax",
  "profile_not_allowed",
  "blocked",
  "paused",
  "busy",
  "at_capacity",
  "unavailable",
  "not_permitted",
  "rejected",
  "password_expired",
  "profile_disabled",
  "privileged",
];

/** The settings every test starts from. */
const OAUTH_SETTINGS = {
  signOnAllowedCidrs: ["127.0.0.0/8", "::1/128", "10.0.0.0/8"],
  codeAddressBinding: "strict",
  grantMaxHours: 12,
  idleCloseMinutes: 10,
  maxConnections: 50,
  allowedProfiles: [],
  allowPrivilegedProfiles: false,
  signOnMaxFailures: 2,
  allowLoopbackRedirects: true,
  redirectUris: [],
} satisfies Partial<typeof config.oauth>;

const saved = {
  mcpAuthMode: config.mcpAuthMode,
  oauthIssuerUrl: config.oauthIssuerUrl,
  mcpResourceUrl: config.mcpResourceUrl,
  mcpTrustedProxies: config.mcpTrustedProxies,
};
const savedOauth = Object.fromEntries(
  Object.keys(OAUTH_SETTINGS).map((key) => [
    key,
    config.oauth[key as keyof typeof OAUTH_SETTINGS],
  ]),
);
const savedMapepireHost = config.oauth.mapepire.host;

let fake: FakeMapepire;
let grants: GrantManager;
let managers: GrantManager[];
let server: AuthorizationServer;
/** Origin of the issuer: where requests are sent, and the form's `Origin`. */
let origin: string;
/** Every log call, as JSON. */
let lines: string[];
/** Every response body, with the path that answered. */
let bodies: Array<{ path: string; text: string }>;
/** Codes and tokens the tests were given. */
let secrets: string[];

/** Creates the server under test for a resource URL (and so an issuer). */
function start(resourceUrl: string = RESOURCE): void {
  config.mcpResourceUrl = resourceUrl;
  grants = createGrantManager({
    mapepire: createMapepireClient({
      host: "127.0.0.1",
      port: fake.port,
      trust: { kind: "pin", pem: Buffer.from(fake.certPem) },
    }),
  });
  managers.push(grants);
  server = createAuthorizationServer(grants);
  origin = new URL(resourceUrl).origin;
}

beforeEach(async () => {
  config.mcpAuthMode = "oauth";
  config.oauthIssuerUrl = undefined;
  config.mcpTrustedProxies = [];
  Object.assign(config.oauth, OAUTH_SETTINGS);
  config.oauth.mapepire.host = "IBMI.EXAMPLE";
  managers = [];
  lines = [];
  bodies = [];
  secrets = [];
  for (const level of ["debug", "info", "warning", "error"] as const) {
    vi.spyOn(logger, level).mockImplementation((...args: unknown[]) => {
      lines.push(JSON.stringify(args));
    });
  }
  fake = await startFakeMapepire({
    accounts: { TESTUSER: FAKE_PASSWORD, OTHERUSR: SPECIAL_PASSWORD },
    statements: [{ match: "USER_INFO_BASIC", reply: { rows: [PROFILE_ROW] } }],
  });
  start();
});

afterEach(async () => {
  fake.drop();
  await Promise.all(managers.map((manager) => manager.shutdown()));
  vi.useRealTimers();
  vi.restoreAllMocks();
  await fake.stop();
  Object.assign(config, saved);
  Object.assign(config.oauth, savedOauth);
  config.oauth.mapepire.host = savedMapepireHost;

  const passwords = [
    FAKE_PASSWORD,
    WRONG_PASSWORD,
    SPECIAL_PASSWORD,
    Buffer.from(`TESTUSER:${FAKE_PASSWORD}`).toString("base64"),
  ];
  for (const secret of [...passwords, ...secrets]) {
    expect(lines.filter((line) => line.includes(secret))).toEqual([]);
  }
  for (const password of passwords) {
    expect(
      bodies.filter(({ text }) => text.includes(password)).map(pathOf),
    ).toEqual([]);
  }
  for (const secret of secrets.filter((secret) => !isCode(secret))) {
    expect(
      bodies
        .filter(
          ({ path, text }) =>
            path !== server.paths.token && text.includes(secret),
        )
        .map(pathOf),
    ).toEqual([]);
  }
});

// --- Helpers ----------------------------------------------------------------

const pathOf = ({ path }: { path: string }) => path;
const codes = new Set<string>();
const isCode = (secret: string) => codes.has(secret);

/** Sends a request to the app as a client at `address` (`null`: no socket). */
async function send(
  path: string,
  init: RequestInit = {},
  address: string | null = ADDRESS,
): Promise<Response> {
  const url = new URL(path, origin);
  const response = await server.app.request(
    url.href,
    init,
    address === null
      ? {}
      : { incoming: { socket: { remoteAddress: address } } },
  );
  bodies.push({ path: url.pathname, text: await response.clone().text() });
  return response;
}

/** The authorization request URL; `undefined` leaves a parameter out. */
function authorizeUrl(
  overrides: Record<string, string | undefined> = {},
): string {
  const query = new URLSearchParams();
  const parameters = {
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    state: STATE,
    ...overrides,
  };
  for (const [name, value] of Object.entries(parameters)) {
    if (value !== undefined) query.set(name, value);
  }
  return `${server.paths.authorize}?${query}`;
}

/** The signed login request in a sign-in page. */
function loginRequestOf(html: string): string {
  const match = /name="login_request" value="([^"]*)"/.exec(html);
  if (!match) throw new Error("the page has no sign-in form");
  return match[1]!;
}

/** The message a page shows, as HTML. */
function messageOf(html: string): string | undefined {
  return /<p class="error" role="alert">([^<]*)<\/p>/.exec(html)?.[1];
}

/** A sign-in page that must be served: its HTML and its login request. */
async function signInPage(
  overrides: Record<string, string | undefined> = {},
  address: string = ADDRESS,
) {
  const response = await send(authorizeUrl(overrides), {}, address);
  const html = await response.text();
  expect(response.status, html).toBe(200);
  return { response, html, loginRequest: loginRequestOf(html) };
}

interface FormOptions {
  profile?: string;
  password?: string;
  /** The `Origin` header; `null` sends none. */
  from?: string | null;
  address?: string;
  headers?: Record<string, string>;
}

/** Submits the sign-in form. */
function submit(loginRequest: string, options: FormOptions = {}) {
  const {
    profile = "testuser",
    password = FAKE_PASSWORD,
    from = origin,
    address = ADDRESS,
    headers = {},
  } = options;
  return send(
    server.paths.authorize,
    {
      method: "POST",
      headers: {
        "content-type": FORM,
        ...(from === null ? {} : { origin: from }),
        ...headers,
      },
      body: new URLSearchParams({
        login_request: loginRequest,
        profile,
        password,
      }).toString(),
    },
    address,
  );
}

/** Opens the sign-in page and submits it. */
async function signOn(
  overrides: Record<string, string | undefined> = {},
  options: FormOptions = {},
) {
  const { loginRequest } = await signInPage(overrides, options.address);
  return submit(loginRequest, options);
}

/** A sign-on that must succeed with a 303: where it redirects, and the code. */
async function signOnCode(
  overrides: Record<string, string | undefined> = {},
  options: FormOptions = {},
) {
  const response = await signOn(overrides, options);
  expect(response.status, await response.clone().text()).toBe(303);
  const location = new URL(response.headers.get("location")!);
  const code = location.searchParams.get("code")!;
  codes.add(code);
  secrets.push(code);
  return { response, location, code };
}

/** A request to the token endpoint. */
function token(
  parameters: Record<string, string>,
  address: string = ADDRESS,
  headers: Record<string, string> = {},
) {
  return send(
    server.paths.token,
    {
      method: "POST",
      headers: { "content-type": FORM, ...headers },
      body: new URLSearchParams(parameters).toString(),
    },
    address,
  );
}

function exchange(code: string, overrides: Record<string, string> = {}) {
  return token({
    grant_type: "authorization_code",
    code,
    code_verifier: VERIFIER,
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    ...overrides,
  });
}

function refresh(refreshToken: string, overrides: Record<string, string> = {}) {
  return token({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
    ...overrides,
  });
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
  refresh_token: string;
}

/** The tokens of a token response that must be a success. */
async function tokensOf(response: Response): Promise<TokenResponse> {
  const text = await response.text();
  expect(response.status, text).toBe(200);
  const tokens = JSON.parse(text) as TokenResponse;
  secrets.push(tokens.access_token, tokens.refresh_token);
  return tokens;
}

/** Signs on and exchanges the code. */
async function signedOnTokens(): Promise<TokenResponse> {
  const { code } = await signOnCode();
  return tokensOf(await exchange(code));
}

/** An RFC 6749 error answer: its status and `error`. */
async function oauthError(response: Response) {
  const body = (await response.json()) as {
    error: string;
    error_description: string;
  };
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(typeof body.error_description).toBe("string");
  return { status: response.status, error: body.error };
}

/** The redirect of an authorization request that its client must be told failed. */
async function errorRedirect(overrides: Record<string, string | undefined>) {
  const response = await send(authorizeUrl(overrides));
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location")!);
  expect(location.origin + location.pathname).toBe(REDIRECT);
  expect(location.searchParams.get("iss")).toBe("https://mcp.example");
  return location.searchParams;
}

function logged(reason: string): boolean {
  return lines.some((line) => line.includes(`"reason":"${reason}"`));
}

const isZeroed = (buffer: Buffer) => buffer.every((byte) => byte === 0);

/** Records every unpooled Buffer allocated from now on, by anyone. */
function unpooledBuffers(): Buffer[] {
  const allocated: Buffer[] = [];
  const allocate = Buffer.allocUnsafeSlow;
  vi.spyOn(Buffer, "allocUnsafeSlow").mockImplementation((size) => {
    const buffer = allocate(size);
    allocated.push(buffer);
    return buffer;
  });
  return allocated;
}

/** How many of `buffers` hold `secret`. */
const holding = (buffers: Buffer[], secret: string) =>
  buffers.filter((buffer) => buffer.includes(secret)).length;

// --- Metadata ---------------------------------------------------------------

describe("authorization server metadata", () => {
  it("serves exactly the document of the design at the well-known path of an issuer without a path", async () => {
    expect(server.paths).toEqual({
      metadata: "/.well-known/oauth-authorization-server",
      authorize: "/oauth/authorize",
      token: "/oauth/token",
      revoke: "/oauth/revoke",
      register: "/oauth/register",
    });
    const response = await send("/.well-known/oauth-authorization-server");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({
      issuer: "https://mcp.example",
      authorization_endpoint: "https://mcp.example/oauth/authorize",
      token_endpoint: "https://mcp.example/oauth/token",
      revocation_endpoint: "https://mcp.example/oauth/revoke",
      registration_endpoint: "https://mcp.example/oauth/register",
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      // Without it a client must assume client_secret_basic (RFC 8414).
      revocation_endpoint_auth_methods_supported: ["none"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
      scopes_supported: ["offline_access"],
    });
  });

  it("inserts the path of the issuer after the well-known part and serves the routes under it", async () => {
    start("https://apps.example.com/ibmi/mcp");
    expect(server.paths).toEqual({
      metadata: "/.well-known/oauth-authorization-server/ibmi",
      authorize: "/ibmi/oauth/authorize",
      token: "/ibmi/oauth/token",
      revoke: "/ibmi/oauth/revoke",
      register: "/ibmi/oauth/register",
    });
    const response = await send("/.well-known/oauth-authorization-server/ibmi");
    expect(await response.json()).toMatchObject({
      issuer: "https://apps.example.com/ibmi",
      authorization_endpoint: "https://apps.example.com/ibmi/oauth/authorize",
      token_endpoint: "https://apps.example.com/ibmi/oauth/token",
      revocation_endpoint: "https://apps.example.com/ibmi/oauth/revoke",
      registration_endpoint: "https://apps.example.com/ibmi/oauth/register",
    });
    for (const path of [
      "/.well-known/oauth-authorization-server",
      "/ibmi/.well-known/oauth-authorization-server",
      "/oauth/authorize",
      "/oauth/token",
    ]) {
      expect((await send(path)).status).toBe(404);
    }

    // The whole flow works under the path, and names the issuer with it.
    const { html } = await signInPage();
    expect(html).toContain('action="/ibmi/oauth/authorize"');
    const { location, code } = await signOnCode();
    expect(location.searchParams.get("iss")).toBe(
      "https://apps.example.com/ibmi",
    );
    await tokensOf(await exchange(code));
  });

  it("serves nothing but its five paths", async () => {
    for (const path of ["/", "/oauth", "/oauth/userinfo", "/mcp"]) {
      expect((await send(path)).status).toBe(404);
    }
    expect((await send(server.paths.token)).status).toBe(404);
    expect((await send(server.paths.metadata, { method: "POST" })).status).toBe(
      404,
    );
  });

  it("is not created when the server is not its own authorization server", () => {
    config.oauthIssuerUrl = "https://issuer.example";
    let thrown: unknown;
    try {
      createAuthorizationServer(grants);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(McpError);
    expect((thrown as McpError).code).toBe(JsonRpcErrorCode.ConfigurationError);
  });
});

// --- The sign-in page -------------------------------------------------------

describe("GET /oauth/authorize", () => {
  it("serves the sign-in page with its own headers", async () => {
    const { response } = await signInPage();
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' http://127.0.0.1:33418",
    );
    for (const [name, value] of Object.entries(PAGE_HEADERS)) {
      expect(response.headers.get(name)).toBe(value);
    }
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("allows the form to redirect to an application scheme by its scheme", async () => {
    config.oauth.redirectUris = [APP_REDIRECT, HTTPS_REDIRECT];
    const app = await signInPage({ redirect_uri: APP_REDIRECT });
    expect(app.response.headers.get("content-security-policy")).toContain(
      "form-action 'self' cursor:",
    );
    const https = await signInPage({ redirect_uri: HTTPS_REDIRECT });
    expect(https.response.headers.get("content-security-policy")).toMatch(
      /form-action 'self' https:\/\/vscode\.dev$/,
    );
  });

  it("names no IPv6 literal in the policy: a browser would ignore the entry", async () => {
    const { response, html } = await signInPage({
      redirect_uri: IPV6_REDIRECT,
    });
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    expect(html).toContain(`<strong>${IPV6_REDIRECT}</strong>`);
  });

  it("shows the system, the client as unverified, the destination and the warnings", async () => {
    const { html } = await signInPage();
    expect(html).toContain("<h1>Sign on to IBM i</h1>");
    expect(html).toContain('<p class="system">IBMI.EXAMPLE</p>');
    expect(html).toContain(
      "&quot;https://client.example/oauth/metadata.json&quot; (not verified) will run SQL as you, then return to <strong>http://127.0.0.1:33418/callback</strong>. Sign on only if you started this from that application.",
    );
    expect(html).toContain(LOOPBACK_NOTE);
    expect(messageOf(html)).toBeUndefined();
  });

  it("is a plain form without script, with labelled fields a password manager recognises", async () => {
    const { html } = await signInPage();
    expect(html).not.toMatch(/<script|javascript:|\son[a-z]+=|<link|<img/i);
    expect(html).toContain('<form method="post" action="/oauth/authorize">');
    expect(html).toContain('<label for="profile">');
    expect(html).toContain('<label for="password">');
    const profile = /<input id="profile"[^>]*>/.exec(html)![0];
    expect(profile).toContain('name="profile"');
    expect(profile).toContain('autocomplete="username"');
    expect(profile).toContain('autocapitalize="off"');
    const password = /<input id="password"[^>]*>/.exec(html)![0];
    expect(password).toContain('name="password"');
    expect(password).toContain('type="password"');
    expect(password).toContain('autocomplete="current-password"');
  });

  it("names a registered client by the name it gave, and says when it gave none", async () => {
    const named = await register({
      client_name: "Example Tool",
      redirect_uris: [REDIRECT],
    });
    const { html } = await signInPage({ client_id: named.client_id });
    expect(html).toContain(
      "&quot;Example Tool&quot; (not verified) will run SQL as you",
    );
    const unnamed = await register({ redirect_uris: [REDIRECT] });
    const page = await signInPage({ client_id: unnamed.client_id });
    expect(page.html).toContain(
      "An application that gave no name will run SQL as you",
    );
  });

  it("has no loopback note for a destination the operator listed", async () => {
    config.oauth.redirectUris = [HTTPS_REDIRECT];
    const { html } = await signInPage({ redirect_uri: HTTPS_REDIRECT });
    expect(html).toContain("<strong>https://vscode.dev/redirect</strong>");
    expect(html).not.toContain(LOOPBACK_NOTE);
  });

  it.each([
    ["no client_id", { client_id: undefined }],
    ["an http client_id", { client_id: "http://client.example/app" }],
    ["a client_id that is not a URL", { client_id: "my-app" }],
    ["a self. id that does not decode", { client_id: "self.e30" }],
    ["no redirect_uri", { redirect_uri: undefined }],
    ["an https redirect that is not listed", { redirect_uri: HTTPS_REDIRECT }],
    ["a redirect to another host", { redirect_uri: "http://10.1.2.3/cb" }],
    ["a loopback redirect with a fragment", { redirect_uri: `${REDIRECT}#x` }],
    [
      "a loopback redirect with user information",
      { redirect_uri: "http://user@127.0.0.1/cb" },
    ],
  ])(
    "answers %s with a page and no redirect",
    async (_name, overrides: Record<string, string | undefined>) => {
      // Every other parameter is wrong too: nothing is sent to a client
      // whose redirect URI has not been validated.
      const response = await send(
        authorizeUrl({
          response_type: "token",
          code_challenge: undefined,
          ...overrides,
        }),
      );
      const html = await response.text();
      expect(response.status).toBe(400);
      expect(response.headers.get("location")).toBeNull();
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("content-security-policy")).toContain(
        "form-action 'self'",
      );
      expect(html).not.toContain("<form");
      expect(messageOf(html)).toBeTruthy();
    },
  );

  it("refuses a redirect URI that is not one of a registered client's own", async () => {
    const client = await register({
      redirect_uris: ["http://127.0.0.1/own"],
    });
    const response = await send(authorizeUrl({ client_id: client.client_id }));
    expect(response.status).toBe(400);
    await signInPage({
      client_id: client.client_id,
      redirect_uri: "http://127.0.0.1:50123/own",
    });
  });

  it("refuses loopback redirects when OAUTH_ALLOW_LOOPBACK_REDIRECTS is off", async () => {
    config.oauth.allowLoopbackRedirects = false;
    expect((await send(authorizeUrl())).status).toBe(400);
  });

  it("names the client_id and the redirect URI it refuses", async () => {
    const client = await send(authorizeUrl({ client_id: "my-app" }));
    expect(messageOf(await client.text())).toContain(
      "client_id is &quot;my-app&quot;",
    );
    const redirect = await send(
      authorizeUrl({ redirect_uri: "https://elsewhere.example/cb" }),
    );
    expect(messageOf(await redirect.text())).toContain(
      "sent to &quot;https://elsewhere.example/cb&quot;",
    );
  });

  it.each([
    ["no response_type", { response_type: undefined }, "invalid_request"],
    [
      "another response_type",
      { response_type: "token" },
      "unsupported_response_type",
    ],
    ["no code_challenge", { code_challenge: undefined }, "invalid_request"],
    [
      "a code_challenge of 42 characters",
      { code_challenge: CHALLENGE.slice(1) },
      "invalid_request",
    ],
    [
      "a code_challenge of 44 characters",
      { code_challenge: `${CHALLENGE}A` },
      "invalid_request",
    ],
    [
      "a code_challenge with another character",
      { code_challenge: `${CHALLENGE.slice(1)}+` },
      "invalid_request",
    ],
    [
      "the plain challenge method",
      { code_challenge_method: "plain" },
      "invalid_request",
    ],
    [
      "no challenge method",
      { code_challenge_method: undefined },
      "invalid_request",
    ],
    [
      "the bare origin as resource",
      { resource: "https://mcp.example" },
      "invalid_target",
    ],
    [
      "another resource",
      { resource: "https://other.example/mcp" },
      "invalid_target",
    ],
    ["a resource that is not a URL", { resource: "mcp" }, "invalid_target"],
  ])(
    "redirects %s to the client as an error with state and iss",
    async (_name, overrides: Record<string, string | undefined>, error) => {
      const parameters = await errorRedirect(overrides);
      expect([...parameters.keys()].sort()).toEqual(["error", "iss", "state"]);
      expect(parameters.get("error")).toBe(error);
      expect(parameters.get("state")).toBe(STATE);
    },
  );

  it("accepts a state of 2048 characters and refuses a longer one without echoing it", async () => {
    await signInPage({ state: "s".repeat(2048) });
    const parameters = await errorRedirect({ state: "s".repeat(2049) });
    expect(parameters.get("error")).toBe("invalid_request");
    expect(parameters.has("state")).toBe(false);
  });

  it("leaves state out of an error redirect when the request had none", async () => {
    const parameters = await errorRedirect({
      state: undefined,
      response_type: "token",
    });
    expect(parameters.has("state")).toBe(false);
  });

  it("keeps the query of the redirect URI in an error redirect", async () => {
    const response = await send(
      authorizeUrl({
        redirect_uri: `${REDIRECT}?session=7`,
        response_type: "token",
      }),
    );
    const location = new URL(response.headers.get("location")!);
    expect(location.searchParams.get("session")).toBe("7");
    expect(location.searchParams.get("error")).toBe(
      "unsupported_response_type",
    );
  });

  it("accepts the resource URL in another spelling, and ignores scope and prompt", async () => {
    await signInPage({ resource: "HTTPS://MCP.EXAMPLE/mcp/" });
    await signInPage({ scope: "offline_access unknown:scope", prompt: "none" });
  });
});

// --- Where a sign-in request may come from ----------------------------------

describe("the address gate", () => {
  it("refuses the page and the form to an address outside OAUTH_SIGNON_ALLOWED_CIDRS", async () => {
    const { loginRequest } = await signInPage();
    const page = await send(authorizeUrl(), {}, OUTSIDE_ADDRESS);
    expect(page.status).toBe(403);
    expect(await page.text()).not.toContain("<form");
    expect(page.headers.get("cache-control")).toBe("no-store");

    const posted = await submit(loginRequest, { address: OUTSIDE_ADDRESS });
    expect(posted.status).toBe(403);
    expect(posted.headers.get("location")).toBeNull();
    expect(fake.upgrades).toBe(0);
    expect(logged("address_not_allowed")).toBe(true);
    // The refused request did not use the login request up.
    expect((await submit(loginRequest)).status).toBe(303);
  });

  it("follows OAUTH_SIGNON_ALLOWED_CIDRS", async () => {
    config.oauth.signOnAllowedCidrs = ["203.0.113.0/24"];
    start();
    await signInPage({}, OUTSIDE_ADDRESS);
    expect((await send(authorizeUrl())).status).toBe(403);
  });

  it.each([
    ["x-forwarded-for", "10.9.9.9"],
    ["forwarded", "for=10.9.9.9"],
    ["x-real-ip", "10.9.9.9"],
  ])(
    "refuses a request whose peer is not a trusted proxy but sends %s",
    async (header, value) => {
      const { loginRequest } = await signInPage();
      const page = await send(authorizeUrl(), { headers: { [header]: value } });
      expect(page.status).toBe(403);
      expect(await page.text()).toContain("MCP_TRUSTED_PROXIES");

      const posted = await submit(loginRequest, {
        headers: { [header]: value },
      });
      expect(posted.status).toBe(403);
      expect(fake.upgrades).toBe(0);
      expect(logged("forwarded_by_untrusted_peer")).toBe(true);

      const { code } = await signOnCode();
      const exchanged = await token(
        {
          grant_type: "authorization_code",
          code,
          code_verifier: VERIFIER,
          client_id: CLIENT_ID,
          redirect_uri: REDIRECT,
        },
        ADDRESS,
        { [header]: value },
      );
      expect(await oauthError(exchanged)).toEqual({
        status: 400,
        error: "invalid_request",
      });
      expect(
        lines.some((line) => line.includes('"event":"token_refused"')),
      ).toBe(true);
      // The refused exchange did not redeem the code.
      await tokensOf(await exchange(code));
    },
  );

  it("takes the address a trusted proxy reports, and refuses a proxy that reports none", async () => {
    config.mcpTrustedProxies = [`${PROXY}/32`];
    const viaProxy = (forwardedFor?: string) =>
      send(
        authorizeUrl(),
        forwardedFor ? { headers: { "x-forwarded-for": forwardedFor } } : {},
        PROXY,
      );
    expect((await viaProxy("10.7.7.7")).status).toBe(200);
    // The right-most hop is the client; what is left of it is the client's own claim.
    expect((await viaProxy(`10.7.7.7, ${OUTSIDE_ADDRESS}`)).status).toBe(403);
    expect(logged("address_not_allowed")).toBe(true);
    expect((await viaProxy(`${OUTSIDE_ADDRESS}, 10.7.7.7`)).status).toBe(200);
    expect((await viaProxy()).status).toBe(403);
    expect(logged("no_forwarded_address")).toBe(true);
  });

  it("refuses a request without a peer address", async () => {
    expect((await send(authorizeUrl(), {}, null)).status).toBe(403);
    expect(logged("no_peer_address")).toBe(true);
  });

  it("binds the code of a loopback redirect to the address a trusted proxy reported at sign-on", async () => {
    config.mcpTrustedProxies = [`${PROXY}/32`];
    const forwarded = { "x-forwarded-for": "10.7.7.7" };
    const page = await send(authorizeUrl(), { headers: forwarded }, PROXY);
    const posted = await submit(loginRequestOf(await page.text()), {
      address: PROXY,
      headers: forwarded,
    });
    const code = new URL(posted.headers.get("location")!).searchParams.get(
      "code",
    )!;
    secrets.push(code);
    codes.add(code);
    const parameters = {
      grant_type: "authorization_code",
      code,
      code_verifier: VERIFIER,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
    };
    // Same proxy, another client behind it.
    const other = await token(parameters, PROXY, {
      "x-forwarded-for": "10.8.8.8",
    });
    expect(await oauthError(other)).toEqual({
      status: 400,
      error: "invalid_grant",
    });
    expect(lines.some((line) => line.includes("signon_source_mismatch"))).toBe(
      true,
    );
    expect(grants.status().grants).toBe(0);
  });
});

// --- The submitted form -----------------------------------------------------

describe("POST /oauth/authorize", () => {
  it("signs on with one Mapepire connect and redirects a loopback client with code, state and iss", async () => {
    const { response, location, code } = await signOnCode();
    expect(location.origin + location.pathname).toBe(REDIRECT);
    expect([...location.searchParams.keys()].sort()).toEqual([
      "code",
      "iss",
      "state",
    ]);
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(location.searchParams.get("state")).toBe(STATE);
    expect(location.searchParams.get("iss")).toBe("https://mcp.example");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("same-origin");
    expect(await response.text()).toBe("");
    expect(fake.upgrades).toBe(1);
    expect(fake.connects).toHaveLength(1);
    expect(fake.connects[0]).toMatchObject({
      profile: "TESTUSER",
      passwordMatched: true,
    });
    expect(grants.status().grants).toBe(1);
  });

  it("leaves state out when the request had none, and keeps the query of the redirect URI", async () => {
    const { location } = await signOnCode({
      state: undefined,
      redirect_uri: `${REDIRECT}?session=7`,
    });
    expect([...location.searchParams.keys()].sort()).toEqual([
      "code",
      "iss",
      "session",
    ]);
  });

  it("redirects to the redirect URI as a browser reads it", async () => {
    const { location } = await signOnCode({
      redirect_uri: "HTTP://127.1:33418/callback",
    });
    expect(location.origin + location.pathname).toBe(REDIRECT);
  });

  it("answers an https client with a page that redirects", async () => {
    config.oauth.redirectUris = [HTTPS_REDIRECT];
    const response = await signOn({
      redirect_uri: HTTPS_REDIRECT,
      state: "a&b",
    });
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    for (const [name, value] of Object.entries(PAGE_HEADERS)) {
      expect(response.headers.get(name)).toBe(value);
    }
    const refresh = /<meta http-equiv="refresh" content="0;url=([^"]*)">/.exec(
      html,
    )![1]!;
    expect(html).toContain(`<a href="${refresh}">`);
    expect(html).not.toMatch(/<script|<form/);
    expect(refresh).toContain("&amp;state=a%26b&amp;iss=");
    const target = new URL(refresh.replaceAll("&amp;", "&"));
    expect(target.origin + target.pathname).toBe(HTTPS_REDIRECT);
    expect(target.searchParams.get("state")).toBe("a&b");
    expect(target.searchParams.get("iss")).toBe("https://mcp.example");
    const code = target.searchParams.get("code")!;
    codes.add(code);
    secrets.push(code);
    // The code is redeemable from any address: the redirect is not loopback.
    const exchanged = await token(
      {
        grant_type: "authorization_code",
        code,
        code_verifier: VERIFIER,
        client_id: CLIENT_ID,
        redirect_uri: HTTPS_REDIRECT,
      },
      "10.200.0.1",
    );
    await tokensOf(exchanged);
  });

  it("answers an IPv6 loopback client with a page that redirects: its policy could not allow a 303", async () => {
    const response = await signOn({ redirect_uri: IPV6_REDIRECT });
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("content-security-policy")).not.toContain("[");
    const refresh = /<meta http-equiv="refresh" content="0;url=([^"]*)">/.exec(
      html,
    )![1]!;
    const target = new URL(refresh.replaceAll("&amp;", "&"));
    expect(target.origin + target.pathname).toBe(IPV6_REDIRECT);
    expect(target.searchParams.get("state")).toBe(STATE);
    const code = target.searchParams.get("code")!;
    codes.add(code);
    secrets.push(code);
    // A loopback redirect: the code is bound to the sign-on's address.
    await tokensOf(await exchange(code, { redirect_uri: IPV6_REDIRECT }));
    expect(fake.signOns("TESTUSER")).toBe(1);
  });

  it("redirects an application-scheme client with a 303", async () => {
    config.oauth.redirectUris = [APP_REDIRECT];
    const { location } = await signOnCode({ redirect_uri: APP_REDIRECT });
    expect(location.protocol).toBe("cursor:");
    expect(location.host + location.pathname).toBe(
      "anysphere.cursor-mcp/oauth/callback",
    );
    expect(location.searchParams.get("state")).toBe(STATE);
  });

  it("decodes the form in bytes: a password with every encoded character signs on", async () => {
    await signOnCode({}, { profile: "otherusr", password: SPECIAL_PASSWORD });
    expect(fake.connects[0]).toMatchObject({
      profile: "OTHERUSR",
      passwordMatched: true,
    });
  });

  it("hands the grant manager Buffers outside the pool and the V8 heap and zero-fills them, whatever the manager does", async () => {
    const requests: SignOnRequest[] = [];
    const typed: boolean[] = [];
    vi.spyOn(grants, "signOn").mockImplementation(async (request) => {
      requests.push(request);
      typed.push(
        request.profile.equals(Buffer.from("TestUser")),
        request.password.equals(Buffer.from(FAKE_PASSWORD)),
        hasOwnMemory(request.profile),
        hasOwnMemory(request.password),
      );
      return { ok: false, reason: "rejected" };
    });
    const { loginRequest } = await signInPage();
    await submit(loginRequest, { profile: "TestUser" });
    expect(typed).toEqual([true, true, true, true]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      clientId: CLIENT_ID,
      redirectUri: REDIRECT,
      codeChallenge: CHALLENGE,
      address: ADDRESS,
    });
    expect(isZeroed(requests[0]!.profile)).toBe(true);
    expect(isZeroed(requests[0]!.password)).toBe(true);
  });

  it("zero-fills the body bytes it was given", async () => {
    const { loginRequest } = await signInPage();
    const chunk = new TextEncoder().encode(
      new URLSearchParams({
        login_request: loginRequest,
        profile: "testuser",
        password: FAKE_PASSWORD,
      }).toString(),
    );
    const response = await send(server.paths.authorize, {
      method: "POST",
      headers: { "content-type": FORM, origin },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(chunk);
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit);
    expect(response.status).toBe(303);
    const code = new URL(response.headers.get("location")!).searchParams.get(
      "code",
    )!;
    codes.add(code);
    secrets.push(code);
    expect(chunk.every((byte) => byte === 0)).toBe(true);
  });

  it("leaves the password in none of the Buffers the sign-on allocated", async () => {
    const { loginRequest } = await signInPage();
    const allocated = unpooledBuffers();
    const response = await submit(loginRequest);
    expect(response.status).toBe(303);
    const code = new URL(response.headers.get("location")!).searchParams.get(
      "code",
    )!;
    codes.add(code);
    secrets.push(code);
    // The body, each decoded field, and what the grant manager made of them.
    expect(allocated.length).toBeGreaterThan(3);
    for (const secret of [
      FAKE_PASSWORD,
      Buffer.from(`TESTUSER:${FAKE_PASSWORD}`).toString("base64"),
    ]) {
      expect(holding(allocated, secret)).toBe(0);
    }
  });

  it.each([
    ["another origin", "https://evil.example"],
    ["the issuer with another port", "https://mcp.example:8443"],
    ["the issuer over http", "http://mcp.example"],
    ["the null origin", "null"],
    ["no Origin header", null],
  ])("refuses a form sent from %s", async (_name, from) => {
    const { loginRequest } = await signInPage();
    const response = await submit(loginRequest, { from });
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("<form");
    expect(fake.upgrades).toBe(0);
    expect(logged("origin_mismatch")).toBe(true);
    // The origin is judged before the login request: it is still unused.
    expect((await submit(loginRequest)).status).toBe(303);
  });

  it("refuses a login request that was changed or that it did not sign", async () => {
    const { loginRequest } = await signInPage();
    const [payload, signature] = loginRequest.split(".") as [string, string];
    const login = JSON.parse(Buffer.from(payload, "base64url").toString());
    const forged = Buffer.from(
      JSON.stringify({ ...login, redirectUri: "http://127.0.0.1:1/attacker" }),
    ).toString("base64url");
    const flipped =
      signature.slice(0, -2) + (signature.endsWith("AA") ? "BB" : "AA");
    // Another process (another key) signed this one.
    const first = server;
    start();
    const foreign = (await signInPage()).loginRequest;
    server = first;

    for (const changed of [
      `${forged}.${signature}`,
      `${payload}.${flipped}`,
      `${payload}.`,
      payload,
      `.${signature}`,
      "",
      foreign,
    ]) {
      const response = await submit(changed);
      expect(response.status, changed).toBe(400);
      expect(await response.text()).not.toContain("<form");
    }
    expect(fake.upgrades).toBe(0);
    expect(logged("login_request_invalid")).toBe(true);
    expect((await submit(loginRequest)).status).toBe(303);
  });

  it("accepts a login request until it is ten minutes old, and not after", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const started = Date.now();
    const early = (await signInPage()).loginRequest;
    const late = (await signInPage()).loginRequest;
    vi.setSystemTime(started + LOGIN_REQUEST_TTL_MS - 1);
    expect((await submit(early)).status).toBe(303);
    vi.setSystemTime(started + LOGIN_REQUEST_TTL_MS);
    const response = await submit(late);
    expect(response.status).toBe(400);
    expect(messageOf(await response.text())).toContain("expired");
    expect(fake.signOns("TESTUSER")).toBe(1);
  });

  it("forgets a used login request once it has expired", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.spyOn(grants, "signOn").mockResolvedValue({
      ok: false,
      reason: "rejected",
    });
    const started = Date.now();
    const first = (await signInPage()).loginRequest;
    const { nonce } = JSON.parse(
      Buffer.from(first.split(".")[0]!, "base64url").toString(),
    ) as { nonce: string };

    // The map the server keeps used login requests in.
    const used: Array<Map<unknown, unknown>> = [];
    const set = Map.prototype.set;
    const spy = vi.spyOn(Map.prototype, "set").mockImplementation(function (
      this: Map<unknown, unknown>,
      key: unknown,
      value: unknown,
    ) {
      if (key === nonce) used.push(this);
      return set.call(this, key, value);
    });
    await submit(first);
    spy.mockRestore();
    expect(used).toHaveLength(1);
    expect([...used[0]!.keys()]).toEqual([nonce]);

    vi.setSystemTime(started + LOGIN_REQUEST_TTL_MS - 1);
    await submit((await signInPage()).loginRequest);
    expect(used[0]!.size).toBe(2);
    vi.setSystemTime(started + LOGIN_REQUEST_TTL_MS);
    await submit((await signInPage()).loginRequest);
    expect(used[0]!.has(nonce)).toBe(false);
    expect(used[0]!.size).toBe(2);
  });

  it("accepts a login request once: a later submission signs nothing on", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { loginRequest } = await signInPage();
    const rejected = await submit(loginRequest, { password: WRONG_PASSWORD });
    expect(rejected.status).toBe(200);
    expect(fake.signOns("TESTUSER")).toBe(1);

    vi.setSystemTime(Date.now() + 5_000);
    const replayed = await submit(loginRequest);
    expect(replayed.status).toBe(400);
    expect(messageOf(await replayed.text())).toContain("already used");
    expect(fake.signOns("TESTUSER")).toBe(1);

    // The page of the rejected attempt carries a new login request.
    const again = loginRequestOf(await rejected.text());
    expect(again).not.toBe(loginRequest);
    expect((await submit(again)).status).toBe(303);
    vi.setSystemTime(Date.now() + 5_000);
    expect((await submit(again)).status).toBe(400);
    expect(fake.signOns("TESTUSER")).toBe(2);
  });

  it("answers a form submitted twice, as a double click does, with the one sign-on's answer both times", async () => {
    const { loginRequest } = await signInPage();

    // A browser drops the first answer and shows the second.
    const [first, second] = await Promise.all([
      submit(loginRequest),
      // Whatever the second submission carries, it is not looked at.
      submit(loginRequest, { password: WRONG_PASSWORD }),
    ]);

    expect(first.status).toBe(303);
    expect(second.status).toBe(303);
    expect(second.headers.get("location")).toBe(first.headers.get("location"));
    expect(fake.signOns("TESTUSER")).toBe(1);
    expect(fake.connects[0]?.passwordMatched).toBe(true);
    expect(grants.status()).toMatchObject({ grants: 1, openConnections: 1 });
    const code = new URL(second.headers.get("location")!).searchParams.get(
      "code",
    )!;
    codes.add(code);
    secrets.push(code);
    await tokensOf(await exchange(code));
  });

  it("answers a second submission with a refused sign-on's page, and does not count it twice", async () => {
    const { loginRequest } = await signInPage();

    const [first, second] = await Promise.all([
      submit(loginRequest, { password: WRONG_PASSWORD }),
      submit(loginRequest, { password: WRONG_PASSWORD }),
    ]);

    for (const response of [first, second]) {
      const html = await response.text();
      expect(response.status).toBe(200);
      expect(messageOf(html)).toBe("Sign-on not accepted.");
      expect(loginRequestOf(html)).not.toBe(loginRequest);
    }
    expect(fake.signOns("TESTUSER")).toBe(1);
    expect(grants.status().blockedProfiles).toBe(0);
  });

  it("tells a second submission after the sign-on worked that it is done, without the code, only from the same address and only for 5 seconds", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { loginRequest } = await signInPage();
    const first = await submit(loginRequest);
    expect(first.status).toBe(303);
    const code = new URL(first.headers.get("location")!).searchParams.get(
      "code",
    )!;

    const elsewhere = await submit(loginRequest, { address: "10.9.9.9" });
    expect(elsewhere.status).toBe(400);
    expect(messageOf(await elsewhere.text())).toContain("already used");

    vi.setSystemTime(Date.now() + 4_999);
    const inTime = await submit(loginRequest);
    expect(inTime.status).toBe(200);
    expect(inTime.headers.get("location")).toBeNull();
    const html = await inTime.text();
    expect(html).toContain(
      "This sign-on has already completed. You can close this window.",
    );
    expect(html).not.toContain(code);
    expect(html).not.toContain("<form");

    vi.setSystemTime(Date.now() + 1);
    const late = await submit(loginRequest);
    expect(late.status).toBe(400);
    expect(late.headers.get("location")).toBeNull();
    expect(messageOf(await late.text())).toContain("already used");
    expect(fake.signOns("TESTUSER")).toBe(1);
    codes.add(code);
    secrets.push(code);
  });

  it("keeps no reference to the result that holds the code once the sign-on is answered", async () => {
    v8.setFlagsFromString("--expose-gc");
    const gc = runInNewContext("gc") as () => void;
    let reachable: WeakRef<object> | undefined;
    // Not a spy: a spy keeps every result it returned.
    grants.signOn = async () => {
      const result = { ok: true as const, code: "C".repeat(43), grantId: "g" };
      reachable = new WeakRef(result);
      return result;
    };
    const { loginRequest } = await signInPage();
    expect((await submit(loginRequest)).status).toBe(303);

    for (let i = 0; i < 3 && reachable?.deref(); i++) {
      await new Promise((resolve) => setImmediate(resolve));
      gc();
    }
    expect(reachable).toBeDefined();
    expect(reachable!.deref()).toBeUndefined();
    // The repeat answer is still given.
    const repeated = await submit(loginRequest);
    expect(await repeated.text()).toContain("already completed");
  });

  it("validates the client and redirect URI of the login request again", async () => {
    config.oauth.redirectUris = [HTTPS_REDIRECT];
    const { loginRequest } = await signInPage({ redirect_uri: HTTPS_REDIRECT });
    config.oauth.redirectUris = [];
    const response = await submit(loginRequest);
    expect(response.status).toBe(400);
    expect(fake.upgrades).toBe(0);
    expect(logged("client_not_allowed")).toBe(true);
  });

  it.each([
    ["no password", (login: string) => `login_request=${login}&profile=a`],
    ["no profile", (login: string) => `login_request=${login}&password=b`],
    ["no login request", () => "profile=a&password=b"],
    [
      "the password twice",
      (login: string) =>
        `login_request=${login}&profile=a&password=b&password=c`,
    ],
    [
      "broken percent-encoding",
      (login: string) => `login_request=${login}&profile=a&password=b%2`,
    ],
    [
      "a field without a value",
      (login: string) => `login_request=${login}&profile=a&password`,
    ],
    [
      "a body that is too long",
      (login: string) =>
        `login_request=${login}&profile=a&password=b&pad=${"x".repeat(64 * 1024)}`,
    ],
    ["an empty body", () => ""],
  ])("refuses a form with %s", async (_name, body) => {
    const { loginRequest } = await signInPage();
    const response = await send(server.paths.authorize, {
      method: "POST",
      headers: { "content-type": FORM, origin },
      body: body(loginRequest),
    });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("<form");
    expect(fake.upgrades).toBe(0);
  });

  it.each([
    [
      "is too long",
      (login: string) => [
        `login_request=${login}&profile=testuser&password=${FAKE_PASSWORD}&pad=`,
        "x".repeat(64 * 1024),
      ],
    ],
    [
      "is too long in one piece",
      (login: string) => [
        `login_request=${login}&password=${FAKE_PASSWORD}&pad=${"x".repeat(64 * 1024)}`,
      ],
    ],
    [
      "breaks off inside the password",
      (login: string) => [
        `login_request=${login}&profile=testuser&password=${FAKE_PASSWORD}%2`,
      ],
    ],
    [
      "has the password twice",
      (login: string) => [
        `login_request=${login}&password=${FAKE_PASSWORD}&password=x`,
      ],
    ],
    [
      "has the password where a name belongs",
      (login: string) => [`login_request=${login}&${FAKE_PASSWORD}=x`],
    ],
  ])(
    "leaves the password in no Buffer when the form %s",
    async (_name, chunks) => {
      const { loginRequest } = await signInPage();
      const encoder = new TextEncoder();
      const parts = chunks(loginRequest).map((chunk) => encoder.encode(chunk));
      const allocated = unpooledBuffers();
      const response = await send(server.paths.authorize, {
        method: "POST",
        headers: { "content-type": FORM, origin },
        body: new ReadableStream({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
        duplex: "half",
      } as RequestInit);
      expect(response.status).toBe(400);
      expect(fake.upgrades).toBe(0);
      expect(allocated.length).toBeGreaterThan(0);
      expect(holding(allocated, FAKE_PASSWORD)).toBe(0);
      expect(
        holding(
          parts.map((part) => Buffer.from(part.buffer)),
          FAKE_PASSWORD,
        ),
      ).toBe(0);
    },
  );

  it("reads a field whose name is percent-encoded, and skips fields it does not know", async () => {
    const { loginRequest } = await signInPage();
    const response = await send(server.paths.authorize, {
      method: "POST",
      headers: { "content-type": FORM, origin },
      body: `other=1&&login%5Frequest=${loginRequest}&profile=testuser&pass%77ord=${FAKE_PASSWORD}&broken=%zz`,
    });
    expect(response.status).toBe(303);
    const code = new URL(response.headers.get("location")!).searchParams.get(
      "code",
    )!;
    codes.add(code);
    secrets.push(code);
  });

  describe("a sign-on that fails", () => {
    /** Submits the form and returns the page it is answered with. */
    async function failedSignOn(options: FormOptions = {}) {
      const response = await signOn({}, options);
      const html = await response.text();
      expect(response.status, html).toBe(200);
      expect(response.headers.get("location")).toBeNull();
      expect(response.headers.get("content-security-policy")).toContain(
        "form-action 'self' http://127.0.0.1:33418",
      );
      expect(response.headers.get("cache-control")).toBe("no-store");
      // The form is there again, for the same client and destination.
      loginRequestOf(html);
      expect(html).toContain(
        "<strong>http://127.0.0.1:33418/callback</strong>",
      );
      return messageOf(html);
    }

    it("says only that the sign-on was not accepted when the IBM i rejects it", async () => {
      expect(await failedSignOn({ password: WRONG_PASSWORD })).toBe(
        "Sign-on not accepted.",
      );
      expect(await failedSignOn({ profile: "nobody", password: "x1" })).toBe(
        "Sign-on not accepted.",
      );
      expect(fake.connects).toHaveLength(2);
    });

    it("says that the password is expired, and where to change it", async () => {
      fake.signOn.TESTUSER = "expired";
      const message = await failedSignOn();
      expect(message).toContain("expired");
      expect(message).toContain("5250 session");
    });

    it("says that the profile is disabled, and whom to ask", async () => {
      fake.signOn.TESTUSER = "disabled";
      const message = await failedSignOn();
      expect(message).toContain("disabled");
      expect(message).toContain("administrator");
    });

    it("says that the system is unavailable when Mapepire cannot be reached or answers something else", async () => {
      fake.signOn.TESTUSER = "unknown_error";
      expect(await failedSignOn()).toContain("unavailable");
      fake.signOn.TESTUSER = "close";
      expect(await failedSignOn()).toContain("unavailable");
    });

    it("says that Mapepire does not permit the profile", async () => {
      fake.signOn.TESTUSER = "security_rule";
      expect(await failedSignOn()).toContain("not permitted to connect");
    });

    it("says that the block is local, and what to do, once the profile is blocked", async () => {
      await failedSignOn({ password: WRONG_PASSWORD });
      await failedSignOn({ password: WRONG_PASSWORD });
      const message = await failedSignOn();
      expect(message).toContain("blocked on this server");
      expect(message).toContain("The IBM i profile is not disabled");
      expect(message).toContain("Sign on at a 5250 session first");
      expect(message).toContain("unblock");
      expect(fake.signOns("TESTUSER")).toBe(2);
    });

    it("explains the refusal of a privileged profile", async () => {
      fake.statements = [
        {
          match: "USER_INFO_BASIC",
          reply: {
            rows: [{ ...PROFILE_ROW, SPECIAL_AUTHORITIES: "*ALLOBJ *JOBCTL" }],
          },
        },
      ];
      const message = await failedSignOn();
      expect(message).toContain("*ALLOBJ or *SECADM");
      expect(grants.status().grants).toBe(0);
    });

    it("gives the reason for credentials that cannot sign on, and sends nothing", async () => {
      expect(await failedSignOn({ profile: "elevenchars" })).toContain(
        "1 to 10 characters",
      );
      expect(await failedSignOn({ password: "semi;colon" })).toContain(
        "semicolon",
      );
      expect(await failedSignOn({ profile: "qsecofr" })).toContain(
        "not permitted to sign on through this server",
      );
      expect(fake.upgrades).toBe(0);
    });

    it.each([
      [{ password: "colon:Pw-123" }, "without a colon"],
      [{ password: "colon-Pw-123:" }, "without a colon"],
      [{ password: "percent%Pw-123" }, "a percent sign"],
      [{ password: "*CURRENT" }, "an asterisk at the start"],
      [{ profile: "1testuser" }, "not starting with a digit"],
    ])(
      "names the rule that %j breaks, and sends nothing",
      async (typed, rule) => {
        const message = await failedSignOn(typed);
        expect(message).toContain(rule);
        expect(message).toContain("Nothing was sent to the IBM i.");
        expect(fake.upgrades).toBe(0);
      },
    );

    it("has a fixed message of its own for every refusal", async () => {
      const messages = new Set<string>();
      for (const reason of ALL_REFUSALS) {
        vi.spyOn(grants, "signOn").mockResolvedValue({ ok: false, reason });
        const message = await failedSignOn();
        expect(message, reason).toBeTruthy();
        messages.add(message!);
      }
      expect(messages.size).toBe(ALL_REFUSALS.length);
    });

    it("never puts what was typed into the page or a log line", async () => {
      const typed = "<b>Typ3d&gt;";
      const pages = [
        await signOn({}, { profile: typed, password: WRONG_PASSWORD }),
        await signOn({}, { profile: "notthere", password: typed }),
        await signOn({}, { profile: WRONG_PASSWORD, password: "testuser" }),
      ];
      for (const page of pages) {
        const html = await page.text();
        expect(page.status).toBe(200);
        for (const text of [typed, "Typ3d", "notthere", "NOTTHERE"]) {
          expect(html).not.toContain(text);
        }
      }
      for (const text of ["Typ3d", "TYP3D"]) {
        expect(lines.filter((line) => line.includes(text))).toEqual([]);
      }
    });
  });
});

// --- Token endpoint ---------------------------------------------------------

describe("POST /oauth/token", () => {
  it("exchanges a code with its PKCE verifier for an access and a refresh token", async () => {
    const { code } = await signOnCode();
    const response = await exchange(code);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const tokens = await tokensOf(response);
    expect(Object.keys(tokens).sort()).toEqual([
      "access_token",
      "expires_in",
      "refresh_token",
      "scope",
      "token_type",
    ]);
    expect(tokens.token_type).toBe("Bearer");
    // The scope granted, whatever was asked for (RFC 6749, section 5.1).
    expect(tokens.scope).toBe("offline_access");
    // OAUTH_IDLE_CLOSE_MINUTES plus five minutes.
    expect(tokens.expires_in).toBe(15 * 60);
    expect(tokens.access_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokens.refresh_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokens.refresh_token).not.toBe(tokens.access_token);
    expect(await grants.authenticate(tokens.access_token)).toMatchObject({
      profile: "TESTUSER",
      clientId: CLIENT_ID,
    });
    // No IBM i contact but the sign-on.
    expect(fake.upgrades).toBe(1);
  });

  it("refuses a wrong verifier, another redirect URI and another client, and keeps the code for the right request", async () => {
    const { code } = await signOnCode();
    const other = await register({ redirect_uris: [REDIRECT] });
    const wrong: Array<Record<string, string>> = [
      { code_verifier: `${VERIFIER.slice(1)}x` },
      { code_verifier: CHALLENGE },
      { redirect_uri: "http://127.0.0.1:33418/other" },
      { redirect_uri: "http://127.0.0.1:33419/callback" },
      { client_id: other.client_id },
      { client_id: "https://client.example/other.json" },
    ];
    for (const overrides of wrong) {
      expect(await oauthError(await exchange(code, overrides))).toEqual({
        status: 400,
        error: "invalid_grant",
      });
    }
    await tokensOf(await exchange(code));
  });

  it("exchanges a code without redirect_uri, as a client that follows OAuth 2.1 sends it", async () => {
    const { code } = await signOnCode();
    const response = await token({
      grant_type: "authorization_code",
      code,
      code_verifier: VERIFIER,
      client_id: CLIENT_ID,
    });
    const tokens = await tokensOf(response);
    expect(await grants.authenticate(tokens.access_token)).toMatchObject({
      profile: "TESTUSER",
    });
  });

  it("refuses a resource that is not this server's at the code exchange and at a refresh, and accepts its own", async () => {
    const { code } = await signOnCode();
    const foreign = { resource: "https://other.example/mcp" };

    const refusedExchange = await exchange(code, foreign);
    expect(await oauthError(refusedExchange)).toEqual({
      status: 400,
      error: "invalid_target",
    });
    // What MCP clients send: the resource URL, here in another spelling.
    const first = await tokensOf(
      await exchange(code, { resource: "HTTPS://MCP.example/mcp/" }),
    );
    const refusedRefresh = await refresh(first.refresh_token, foreign);
    expect(await oauthError(refusedRefresh)).toEqual({
      status: 400,
      error: "invalid_target",
    });
    // Nothing was rotated by the refused request.
    const second = await tokensOf(
      await refresh(first.refresh_token, {
        resource: RESOURCE,
        scope: "admin everything",
      }),
    );
    expect(second.scope).toBe("offline_access");
    expect(second.refresh_token).not.toBe(first.refresh_token);
  });

  it("refuses an unknown code", async () => {
    expect(await oauthError(await exchange("A".repeat(43)))).toEqual({
      status: 400,
      error: "invalid_grant",
    });
  });

  it("logs why it refused, without the presented value", async () => {
    const presented = "B".repeat(43);
    await exchange(presented);
    const refusal = lines.find((line) => line.includes('"oauth_error"'));
    expect(refusal).toContain('"path":"/oauth/token"');
    expect(refusal).toContain('"error":"invalid_grant"');
    expect(lines.join("\n")).not.toContain(presented);
  });

  it("ends the sign-on when its code is presented a second time", async () => {
    const { code } = await signOnCode();
    const tokens = await tokensOf(await exchange(code));
    expect(await oauthError(await exchange(code))).toEqual({
      status: 400,
      error: "invalid_grant",
    });
    expect(await grants.authenticate(tokens.access_token)).toBe(
      "invalid_token",
    );
    expect(grants.status().grants).toBe(0);
  });

  it("refuses the code of a loopback redirect from another address than the sign-on's", async () => {
    const { code } = await signOnCode();
    const response = await token(
      {
        grant_type: "authorization_code",
        code,
        code_verifier: VERIFIER,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT,
      },
      "10.9.9.9",
    );
    expect(await oauthError(response)).toEqual({
      status: 400,
      error: "invalid_grant",
    });
    expect(grants.status().grants).toBe(0);
  });

  it.each([
    ["no grant_type", { grant_type: undefined }, "invalid_request"],
    [
      "another grant type",
      { grant_type: "client_credentials" },
      "unsupported_grant_type",
    ],
    ["no client_id", { client_id: undefined }, "invalid_client"],
    ["a client_id it cannot read", { client_id: "my-app" }, "invalid_client"],
    ["no code", { code: undefined }, "invalid_request"],
    ["no code_verifier", { code_verifier: undefined }, "invalid_request"],
    [
      "a refresh grant without a refresh token",
      { grant_type: "refresh_token" },
      "invalid_request",
    ],
  ])(
    "answers %s with a 400",
    async (_name, overrides: Record<string, string | undefined>, error) => {
      const { code } = await signOnCode();
      const parameters: Record<string, string | undefined> = {
        grant_type: "authorization_code",
        code,
        code_verifier: VERIFIER,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT,
        ...overrides,
      };
      const body = new URLSearchParams();
      for (const [name, value] of Object.entries(parameters)) {
        if (value !== undefined) body.set(name, value);
      }
      const response = await token(Object.fromEntries(body));
      expect(await oauthError(response)).toEqual({ status: 400, error });
      // A request it could not read did not redeem the code.
      await tokensOf(await exchange(code));
    },
  );

  it.each([
    ["a parameter twice", (code: string) => `code=${code}&code=${code}`],
    ["broken percent-encoding", (code: string) => `code=${code}%`],
    [
      "a body that is too long",
      (code: string) => `code=${code}&pad=${"x".repeat(64 * 1024)}`,
    ],
  ])("answers %s with invalid_request", async (_name, extra) => {
    const { code } = await signOnCode();
    const response = await send(server.paths.token, {
      method: "POST",
      headers: { "content-type": FORM },
      body: `grant_type=authorization_code&code_verifier=${VERIFIER}&client_id=${encodeURIComponent(CLIENT_ID)}&redirect_uri=${encodeURIComponent(REDIRECT)}&${extra(code)}`,
    });
    expect(await oauthError(response)).toEqual({
      status: 400,
      error: "invalid_request",
    });
    await tokensOf(await exchange(code));
  });

  it("rotates the refresh token, replays the pair for the previous one and ends the sign-on on a retired one", async () => {
    const first = await signedOnTokens();
    const second = await tokensOf(await refresh(first.refresh_token));
    expect(second.token_type).toBe("Bearer");
    expect(second.expires_in).toBe(15 * 60);
    expect(second.access_token).not.toBe(first.access_token);
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(await grants.authenticate(second.access_token)).toMatchObject({
      profile: "TESTUSER",
    });

    // Another client cannot use the refresh token.
    expect(
      await oauthError(
        await refresh(second.refresh_token, {
          client_id: "https://client.example/other.json",
        }),
      ),
    ).toEqual({ status: 400, error: "invalid_grant" });

    // The previous token replays the same pair; it does not rotate.
    const replayed = await tokensOf(await refresh(first.refresh_token));
    expect(replayed.access_token).toBe(second.access_token);
    expect(replayed.refresh_token).toBe(second.refresh_token);

    const third = await tokensOf(await refresh(second.refresh_token));
    expect(third.refresh_token).not.toBe(second.refresh_token);
    expect(await grants.authenticate(third.access_token)).toMatchObject({
      profile: "TESTUSER",
    });

    // The first token is retired now: presenting it ends the sign-on.
    expect(await oauthError(await refresh(first.refresh_token))).toEqual({
      status: 400,
      error: "invalid_grant",
    });
    expect(await grants.authenticate(third.access_token)).toBe("invalid_token");
    expect(await oauthError(await refresh(third.refresh_token))).toEqual({
      status: 400,
      error: "invalid_grant",
    });
    // Refreshing never signed on again: the connection stayed open.
    expect(fake.signOns("TESTUSER")).toBe(1);
  });

  it("refuses an access token and an unknown token as refresh token", async () => {
    const tokens = await signedOnTokens();
    for (const refreshToken of [tokens.access_token, "A".repeat(43)]) {
      expect(await oauthError(await refresh(refreshToken))).toEqual({
        status: 400,
        error: "invalid_grant",
      });
    }
    await tokensOf(await refresh(tokens.refresh_token));
  });

  it("answers more rotations than the limit with 429 and Retry-After", async () => {
    let tokens = await signedOnTokens();
    for (
      let rotation = 0;
      rotation < REFRESH_ROTATION_LIMIT.count;
      rotation++
    ) {
      tokens = await tokensOf(await refresh(tokens.refresh_token));
    }
    const response = await refresh(tokens.refresh_token);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(await oauthError(response)).toEqual({
      status: 429,
      error: "temporarily_unavailable",
    });
    // Nothing was rotated: the access token still works.
    expect(await grants.authenticate(tokens.access_token)).toMatchObject({
      profile: "TESTUSER",
    });
  });

  it("leaves the code and a presented refresh token in no Buffer but the response that issued it", async () => {
    const { code } = await signOnCode();
    const allocated = unpooledBuffers();
    const tokens = await tokensOf(await exchange(code));
    await tokensOf(await refresh(tokens.refresh_token));
    const responses = allocated.filter((buffer) =>
      buffer.toString("latin1", 0, 17).startsWith('{"access_token":"'),
    );
    expect(responses).toHaveLength(2);
    expect(allocated.length).toBeGreaterThan(6);
    expect(holding(allocated, code)).toBe(0);
    // Its own response is the one Buffer that still holds a token.
    expect(holding(allocated, tokens.refresh_token)).toBe(1);
    expect(holding(allocated, tokens.access_token)).toBe(1);
    expect(holding(responses, tokens.refresh_token)).toBe(1);
    expect(holding(responses, tokens.access_token)).toBe(1);
  });

  it("gives the grant manager the code and the refresh token as Buffers and zero-fills them and the tokens it returns", async () => {
    const issued = () => ({
      ok: true as const,
      accessToken: Buffer.from("A".repeat(43)),
      refreshToken: Buffer.from("R".repeat(43)),
      expiresInSeconds: 900,
    });
    const given: Buffer[] = [];
    const results = [issued(), issued()];
    const exchangeCode = vi
      .spyOn(grants, "exchangeCode")
      .mockImplementation(async (request) => {
        expect(request.code.toString()).toBe("the-code");
        expect(hasOwnMemory(request.code)).toBe(true);
        given.push(request.code);
        return results[0]!;
      });
    const refreshed = vi
      .spyOn(grants, "refresh")
      .mockImplementation(async (request) => {
        expect(request.refreshToken.toString()).toBe("the-refresh-token");
        expect(hasOwnMemory(request.refreshToken)).toBe(true);
        given.push(request.refreshToken);
        return results[1]!;
      });

    for (const response of [
      await exchange("the-code"),
      await refresh("the-refresh-token"),
    ]) {
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        access_token: "A".repeat(43),
        token_type: "Bearer",
        expires_in: 900,
        scope: "offline_access",
        refresh_token: "R".repeat(43),
      });
    }
    expect(exchangeCode.mock.calls[0]![0]).toMatchObject({
      codeVerifier: VERIFIER,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT,
      address: ADDRESS,
    });
    expect(refreshed.mock.calls[0]![0]).toMatchObject({
      clientId: CLIENT_ID,
      address: ADDRESS,
    });
    expect(given).toHaveLength(2);
    for (const buffer of [
      ...given,
      ...results.flatMap((result) => [result.accessToken, result.refreshToken]),
    ]) {
      expect(isZeroed(buffer)).toBe(true);
    }
  });
});

// --- Revocation -------------------------------------------------------------

describe("POST /oauth/revoke", () => {
  function revoke(parameters: Record<string, string>) {
    return send(server.paths.revoke, {
      method: "POST",
      headers: { "content-type": FORM },
      body: new URLSearchParams(parameters).toString(),
    });
  }

  it.each(["access_token", "refresh_token"] as const)(
    "ends the sign-on of a revoked %s and closes its IBM i connection",
    async (kind) => {
      const tokens = await signedOnTokens();
      const response = await revoke({ token: tokens[kind] });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).toBe("");
      expect(await grants.authenticate(tokens.access_token)).toBe(
        "invalid_token",
      );
      expect(await oauthError(await refresh(tokens.refresh_token))).toEqual({
        status: 400,
        error: "invalid_grant",
      });
      expect(grants.status()).toMatchObject({ grants: 0, openConnections: 0 });
    },
  );

  it("answers 200 for a token it does not know, and leaves other sign-ons alone", async () => {
    const tokens = await signedOnTokens();
    const response = await revoke({
      token: "A".repeat(43),
      token_type_hint: "refresh_token",
    });
    expect(response.status).toBe(200);
    expect(await grants.authenticate(tokens.access_token)).toMatchObject({
      profile: "TESTUSER",
    });
  });

  it("answers a request without a token with invalid_request", async () => {
    expect(await oauthError(await revoke({}))).toEqual({
      status: 400,
      error: "invalid_request",
    });
    expect(await oauthError(await revoke({ token_type_hint: "x" }))).toEqual({
      status: 400,
      error: "invalid_request",
    });
  });

  it("gives the grant manager the token as a Buffer and zero-fills it", async () => {
    const given: Buffer[] = [];
    vi.spyOn(grants, "revoke").mockImplementation(async (token) => {
      expect(token.toString()).toBe("the-token");
      expect(hasOwnMemory(token)).toBe(true);
      given.push(token);
    });
    expect((await revoke({ token: "the-token" })).status).toBe(200);
    expect(given).toHaveLength(1);
    expect(isZeroed(given[0]!)).toBe(true);
  });
});

// --- Registration -----------------------------------------------------------

interface Registration {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
}

function postRegistration(body: string) {
  return send(server.paths.register, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

/** A registration that must succeed. */
async function register(metadata: unknown): Promise<Registration> {
  const response = await postRegistration(JSON.stringify(metadata));
  const text = await response.text();
  expect(response.status, text).toBe(201);
  return JSON.parse(text) as Registration;
}

describe("POST /oauth/register", () => {
  it("registers VS Code with the redirect URIs that are allowed, which is enough to sign on", async () => {
    const response = await postRegistration(
      JSON.stringify(VSCODE_REGISTRATION),
    );
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const registration = (await response.json()) as Registration;
    expect(registration).toEqual({
      client_id: expect.stringMatching(/^self\.[A-Za-z0-9_-]+$/),
      client_name: "Visual Studio Code",
      redirect_uris: ["http://127.0.0.1/", "http://127.0.0.1:33418/"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });

    // Its fixed port and the random port it falls back to both work.
    for (const redirectUri of [
      "http://127.0.0.1:33418/",
      "http://127.0.0.1:54321/",
    ]) {
      const client = {
        client_id: registration.client_id,
        redirect_uri: redirectUri,
      };
      const { code, location } = await signOnCode(client);
      expect(location.origin + location.pathname).toBe(redirectUri);
      await tokensOf(await exchange(code, client));
    }
    // The forwarder it registered is not a destination here.
    const forwarder = await send(
      authorizeUrl({
        client_id: registration.client_id,
        redirect_uri: HTTPS_REDIRECT,
      }),
    );
    expect(forwarder.status).toBe(400);
  });

  it("keeps a redirect URI the operator listed", async () => {
    config.oauth.redirectUris = [HTTPS_REDIRECT];
    const registration = await register(VSCODE_REGISTRATION);
    expect(registration.redirect_uris).toEqual([
      "https://vscode.dev/redirect",
      "http://127.0.0.1/",
      "http://127.0.0.1:33418/",
    ]);
  });

  it("refuses a registration of which no redirect URI is allowed", async () => {
    const none = await postRegistration(
      JSON.stringify({ redirect_uris: [HTTPS_REDIRECT, "http://10.1.2.3/"] }),
    );
    expect(await oauthError(none)).toEqual({
      status: 400,
      error: "invalid_redirect_uri",
    });
    config.oauth.allowLoopbackRedirects = false;
    const loopback = await postRegistration(
      JSON.stringify(VSCODE_REGISTRATION),
    );
    expect(await oauthError(loopback)).toEqual({
      status: 400,
      error: "invalid_redirect_uri",
    });
  });

  it.each([
    ["not JSON", "redirect_uris=http://127.0.0.1/"],
    ["empty", ""],
    ["without redirect_uris", JSON.stringify({ client_name: "x" })],
    ["JSON null", "null"],
    [
      "too long",
      JSON.stringify({ redirect_uris: [REDIRECT], pad: "x".repeat(64 * 1024) }),
    ],
    [
      "too long for a client id",
      JSON.stringify({ redirect_uris: [`${REDIRECT}/${"x".repeat(1024)}`] }),
    ],
  ])("refuses a body that is %s", async (_name, body) => {
    expect(await oauthError(await postRegistration(body))).toEqual({
      status: 400,
      error: "invalid_client_metadata",
    });
  });
});

// --- Markup in what clients send --------------------------------------------

describe("markup in request values", () => {
  const SCRIPT = `"><script>alert(1)</script>`;

  it("escapes a client name", async () => {
    const client = await register({
      client_name: `${SCRIPT}'<img src=x onerror=alert(1)>`,
      redirect_uris: [REDIRECT],
    });
    const { html } = await signInPage({ client_id: client.client_id });
    expect(html).not.toMatch(/<script|<img/);
    expect(html).toContain(
      "&quot;&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&#39;&lt;img src=x onerror=alert(1)&gt;&quot; (not verified)",
    );
  });

  it("escapes the system name", async () => {
    config.oauth.mapepire.host = `<b>&"'`;
    start();
    const { html } = await signInPage();
    expect(html).toContain(
      "<title>Sign on to &lt;b&gt;&amp;&quot;&#39;</title>",
    );
    expect(html).toContain('<p class="system">&lt;b&gt;&amp;&quot;&#39;</p>');
    expect(html).not.toContain("<b>");
  });

  it("escapes a client_id and a redirect URI it refuses", async () => {
    for (const overrides of [
      { client_id: SCRIPT },
      { redirect_uri: `https://elsewhere.example/${SCRIPT}'` },
    ]) {
      const response = await send(authorizeUrl(overrides));
      const html = await response.text();
      expect(response.status).toBe(400);
      expect(html).not.toContain("<script");
      expect(html).toContain("&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
      expect(html).not.toMatch(/script>'/);
    }
  });

  it("escapes the redirect URI it shows and puts it into the policy as an origin only", async () => {
    const { html, response } = await signInPage({
      redirect_uri: `http://127.0.0.1:33418/cb'onmouseover='x/${SCRIPT}?q=${SCRIPT}`,
    });
    expect(html).not.toContain("<script");
    expect(html).not.toContain("cb'onmouseover");
    expect(html).toContain("/cb&#39;onmouseover=&#39;x/");
    expect(response.headers.get("content-security-policy")).toMatch(
      /form-action 'self' http:\/\/127\.0\.0\.1:33418$/,
    );
  });

  it("never renders state, and encodes it in every redirect", async () => {
    config.oauth.redirectUris = [HTTPS_REDIRECT];
    const { html, loginRequest } = await signInPage({
      state: SCRIPT,
      redirect_uri: HTTPS_REDIRECT,
    });
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert(1)");

    const page = await (await submit(loginRequest)).text();
    expect(page).not.toContain("<script");
    const target = new URL(
      /content="0;url=([^"]*)"/.exec(page)![1]!.replaceAll("&amp;", "&"),
    );
    expect(target.searchParams.get("state")).toBe(SCRIPT);
    const code = target.searchParams.get("code")!;
    codes.add(code);
    secrets.push(code);

    const error = await send(
      authorizeUrl({ state: SCRIPT, response_type: "token" }),
    );
    const location = error.headers.get("location")!;
    expect(location).not.toMatch(/[<>"]/);
    expect(new URL(location).searchParams.get("state")).toBe(SCRIPT);
  });
});

// --- Over a real listener ---------------------------------------------------

describe("through @hono/node-server", () => {
  it("signs on, exchanges the code and refreshes over HTTP", async () => {
    const listener = serve({
      fetch: (request, env) => server.app.fetch(request, env),
      port: 0,
      hostname: "127.0.0.1",
    });
    try {
      await once(listener, "listening");
      const { port } = listener.address() as AddressInfo;
      start(`http://127.0.0.1:${port}/mcp`);

      const page = await fetch(origin + authorizeUrl());
      expect(page.status).toBe(200);
      const posted = await fetch(origin + server.paths.authorize, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": FORM, origin },
        body: new URLSearchParams({
          login_request: loginRequestOf(await page.text()),
          profile: "otherusr",
          password: SPECIAL_PASSWORD,
        }),
      });
      expect(posted.status).toBe(303);
      const location = new URL(posted.headers.get("location")!);
      expect(location.searchParams.get("iss")).toBe(origin);
      const code = location.searchParams.get("code")!;
      secrets.push(code);

      const form = (parameters: Record<string, string>) =>
        fetch(origin + server.paths.token, {
          method: "POST",
          body: new URLSearchParams(parameters),
        });
      const exchanged = await form({
        grant_type: "authorization_code",
        code,
        code_verifier: VERIFIER,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT,
      });
      expect(exchanged.headers.get("content-type")).toBe("application/json");
      const tokens = await tokensOf(exchanged);
      expect(await grants.authenticate(tokens.access_token)).toMatchObject({
        profile: "OTHERUSR",
      });
      const refreshed = await tokensOf(
        await form({
          grant_type: "refresh_token",
          refresh_token: tokens.refresh_token,
          client_id: CLIENT_ID,
        }),
      );
      expect(await grants.authenticate(refreshed.access_token)).toMatchObject({
        profile: "OTHERUSR",
      });

      const revoked = await fetch(origin + server.paths.revoke, {
        method: "POST",
        body: new URLSearchParams({ token: refreshed.refresh_token }),
      });
      expect(revoked.status).toBe(200);
      expect(grants.status().grants).toBe(0);
    } finally {
      listener.close();
    }
  });

  it("zero-fills the token response body once it is written", async () => {
    const listener = serve({
      fetch: (request, env) => server.app.fetch(request, env),
      port: 0,
      hostname: "127.0.0.1",
    });
    try {
      await once(listener, "listening");
      const { port } = listener.address() as AddressInfo;
      start(`http://127.0.0.1:${port}/mcp`);
      // Signed on in process from ADDRESS, redeemed over the socket.
      config.oauth.codeAddressBinding = "audit";
      const { code } = await signOnCode();
      const allocated = unpooledBuffers();
      const form = (parameters: Record<string, string>) =>
        fetch(origin + server.paths.token, {
          method: "POST",
          body: new URLSearchParams(parameters),
        });
      const tokens = await tokensOf(
        await form({
          grant_type: "authorization_code",
          code,
          code_verifier: VERIFIER,
          client_id: CLIENT_ID,
        }),
      );
      const refreshed = await tokensOf(
        await form({
          grant_type: "refresh_token",
          refresh_token: tokens.refresh_token,
          client_id: CLIENT_ID,
        }),
      );
      // The response bodies: the JSON the client parsed, byte for byte.
      const lengths = new Set(
        [tokens, refreshed].map((answer) => JSON.stringify(answer).length),
      );
      const responses = allocated.filter((buffer) =>
        lengths.has(buffer.length),
      );
      expect(responses.length).toBeGreaterThanOrEqual(2);
      await vi.waitFor(() =>
        expect(responses.filter((buffer) => !isZeroed(buffer)).length).toBe(0),
      );
    } finally {
      listener.close();
    }
  });

  it("zero-fills the token response body when the client went away before the tokens were issued", async () => {
    const listener = serve({
      fetch: (request, env) => server.app.fetch(request, env),
      port: 0,
      hostname: "127.0.0.1",
    });
    try {
      await once(listener, "listening");
      const { port } = listener.address() as AddressInfo;
      start(`http://127.0.0.1:${port}/mcp`);
      config.oauth.codeAddressBinding = "audit";
      const { code } = await signOnCode();
      // The grant manager answers only after the response has closed.
      const closed = new Promise<void>((resolve) =>
        listener.once("request", (_request, response: ServerResponse) =>
          response.once("close", () => resolve()),
        ),
      );
      const exchangeCode = grants.exchangeCode.bind(grants);
      let issued: TokenResult | undefined;
      vi.spyOn(grants, "exchangeCode").mockImplementation(async (request) => {
        await closed;
        issued = await exchangeCode(request);
        return issued;
      });
      const allocated = unpooledBuffers();
      const form = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: VERIFIER,
        client_id: CLIENT_ID,
      }).toString();
      const socket = connect(port, "127.0.0.1");
      socket.on("error", () => {});
      await once(socket, "connect");
      socket.write(
        `POST ${server.paths.token} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
          `Content-Type: ${FORM}\r\nContent-Length: ${form.length}\r\n\r\n${form}`,
      );
      socket.destroy();

      await vi.waitFor(() => expect(issued?.ok).toBe(true));
      if (!issued?.ok) throw new Error("no tokens were issued");
      // The body, built in an unpooled Buffer of exactly its length.
      const length = JSON.stringify({
        access_token: "a".repeat(issued.accessToken.length),
        token_type: "Bearer",
        expires_in: issued.expiresInSeconds,
        scope: "offline_access",
        refresh_token: "r".repeat(issued.refreshToken.length),
      }).length;
      const body = await vi.waitFor(() => {
        const found = allocated.find((buffer) => buffer.length === length);
        expect(found).toBeDefined();
        return found!;
      });
      expect(isZeroed(body)).toBe(true);
    } finally {
      listener.close();
    }
  });
});

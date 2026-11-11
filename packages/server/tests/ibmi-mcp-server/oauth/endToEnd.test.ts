/**
 * @fileoverview End-to-end test of the built-in IBM i sign-on
 * (`MCP_AUTH_MODE=oauth` without `OAUTH_ISSUER_URL`).
 *
 * The server is started the way the binary starts it
 * (`initializeAndStartServer`) on a loopback port, with its production
 * middleware, the real tool set and a YAML tool file, against the in-process
 * fake Mapepire server. The MCP client is the real SDK client with its OAuth
 * support. The one thing no SDK does is the browser's part: the test loads
 * the authorization URL the SDK asks for and posts the sign-in form itself.
 * One case runs the same flow over the server's own TLS listener.
 *
 * Every credential is made up; no IBM i is involved.
 */

import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import { createServer, type AddressInfo } from "node:net";
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
  UnauthorizedError,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { config } from "../../../src/config/index.js";
import { SWEEP_INTERVAL_MS } from "../../../src/ibmi-mcp-server/oauth/contracts.js";
import { SourceManager } from "../../../src/ibmi-mcp-server/services/sourceManager.js";
import { ToolProcessor } from "../../../src/ibmi-mcp-server/utils/config/toolProcessor.js";
import {
  initializeAndStartServer,
  type RunningServer,
} from "../../../src/mcp-server/server.js";
import { rateLimiter } from "../../../src/utils/index.js";
import {
  FAKE_PASSWORD,
  FAKE_PROFILE,
  generateCertificates,
  startFakeMapepire,
  type FakeMapepire,
} from "./fakeMapepire.js";

// Every log line the server writes, so the test can show that none carries a
// password, an authorization code or a token.
const logged = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock("../../../src/utils/internal/logger.js", async () => {
  const { inspect } = await import("node:util");
  const record = (...args: unknown[]) => {
    logged.lines.push(inspect(args, { depth: 8, breakLength: Infinity }));
  };
  return {
    logger: {
      info: record,
      debug: record,
      warn: record,
      warning: record,
      error: record,
      trace: record,
      fatal: record,
    },
  };
});

const OTHER_PROFILE = "OTHERUSR";
const OTHER_PASSWORD = "other-Pw-456";
const WRONG_PASSWORD = "wrong-Pw-000";
const YAML_TOOL = "active_job_count";

const saved = {
  config: {
    mcpTransportType: config.mcpTransportType,
    mcpHttpHost: config.mcpHttpHost,
    mcpHttpPort: config.mcpHttpPort,
    mcpAuthMode: config.mcpAuthMode,
    mcpResourceUrl: config.mcpResourceUrl,
    mcpTlsCertFile: config.mcpTlsCertFile,
    mcpTlsKeyFile: config.mcpTlsKeyFile,
    oauthIssuerUrl: config.oauthIssuerUrl,
    toolsYamlPath: config.toolsYamlPath,
    selectedToolsets: config.selectedToolsets,
    ibmi_enableDefaultTools: config.ibmi_enableDefaultTools,
  },
  idleCloseMinutes: config.oauth.idleCloseMinutes,
  mapepire: { ...config.oauth.mapepire },
  ibmiHttpAuthEnabled: config.ibmiHttpAuth.enabled,
  env: {
    DB2i_USER: process.env.DB2i_USER,
    DB2i_PASS: process.env.DB2i_PASS,
    DB2i_IGNORE_UNAUTHORIZED: process.env.DB2i_IGNORE_UNAUTHORIZED,
    DB2i_JDBC_OPTIONS: process.env.DB2i_JDBC_OPTIONS,
  },
};

/** A port nothing is listening on. */
const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });

let directory: string;
let fake: FakeMapepire;
let running: RunningServer | undefined;
let base: string;
/** How the test's clients and its "browser" reach the server. */
let httpFetch: typeof fetch;
/** Clients to close after the test. */
let clients: Client[];
/** Passwords, codes and tokens of the test: none may be in a log line. */
let secrets: string[];
/** What the access logger printed. */
let accessLog: string[];

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "ibmi-mcp-e2e-"));
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

beforeEach(async () => {
  fake = await startFakeMapepire({
    accounts: {
      [FAKE_PROFILE]: FAKE_PASSWORD,
      [OTHER_PROFILE]: OTHER_PASSWORD,
    },
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
      {
        match: "QSYS2.SYSSCHEMAS",
        reply: { rows: [{ SCHEMA_NAME: "E2ELIB", SCHEMA_TEXT: "End to end" }] },
      },
      { match: "ACTIVE_JOB_INFO", reply: { rows: [{ ACTIVE_JOBS: 7 }] } },
    ],
  });

  const pinFile = join(directory, "mapepire-pin.pem");
  writeFileSync(pinFile, fake.certPem);
  // A tool file as an operator writes it: the source names the IBM i of
  // DB2i_HOST and service credentials that are not set in this mode.
  const toolsFile = join(directory, "tools.yaml");
  writeFileSync(
    toolsFile,
    `
sources:
  ibmi-system:
    host: 127.0.0.1
    user: \${DB2i_USER}
    password: \${DB2i_PASS}

tools:
  ${YAML_TOOL}:
    source: ibmi-system
    description: "Counts the active jobs."
    statement: "SELECT COUNT(*) AS ACTIVE_JOBS FROM TABLE(QSYS2.ACTIVE_JOB_INFO()) FETCH FIRST 1 ROWS ONLY"
`,
  );
  for (const name of Object.keys(saved.env)) {
    delete process.env[name];
  }

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  Object.assign(config, {
    mcpTransportType: "http",
    mcpHttpHost: "127.0.0.1",
    mcpHttpPort: port,
    mcpAuthMode: "oauth",
    mcpResourceUrl: `${base}/mcp`,
    mcpTlsCertFile: undefined,
    mcpTlsKeyFile: undefined,
    oauthIssuerUrl: undefined,
    toolsYamlPath: toolsFile,
    selectedToolsets: undefined,
    ibmi_enableDefaultTools: true,
  });
  Object.assign(config.oauth.mapepire, {
    host: "127.0.0.1",
    port: fake.port,
    serverCertFile: pinFile,
    caFile: undefined,
  });
  config.ibmiHttpAuth.enabled = false;

  httpFetch = fetch;
  clients = [];
  secrets = [FAKE_PASSWORD, OTHER_PASSWORD, WRONG_PASSWORD];
  accessLog = [];
  logged.lines.length = 0;
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    accessLog.push(args.join(" "));
  });
});

afterEach(async () => {
  await Promise.all(clients.map((client) => client.close().catch(() => {})));
  await running?.close();
  running = undefined;
  vi.useRealTimers();
  await fake.stop();
  ToolProcessor.clearWatchers();
  vi.restoreAllMocks();
  rateLimiter.reset();
  Object.assign(config, saved.config);
  Object.assign(config.oauth.mapepire, saved.mapepire);
  config.oauth.idleCloseMinutes = saved.idleCloseMinutes;
  config.ibmiHttpAuth.enabled = saved.ibmiHttpAuthEnabled;
  for (const [name, value] of Object.entries(saved.env)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

/** An OAuth client that keeps everything in memory and opens no browser. */
class MemoryOAuthProvider implements OAuthClientProvider {
  /** Where the SDK last asked for the user to be sent. */
  authorizationUrl?: URL;
  /** Every token set this client was given, oldest first. */
  readonly issued: StoredOAuthTokens[] = [];
  readonly expectedState = randomBytes(8).toString("hex");
  private client?: StoredOAuthClientInformation;
  private current?: StoredOAuthTokens;
  private verifier = "";
  private discovery?: OAuthDiscoveryState;

  constructor(readonly redirectUrl: string) {}

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "End-to-end test client",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }
  state() {
    return this.expectedState;
  }
  clientInformation() {
    return this.client;
  }
  saveClientInformation(information: StoredOAuthClientInformation) {
    this.client = information;
  }
  tokens() {
    return this.current;
  }
  saveTokens(tokens: StoredOAuthTokens) {
    this.current = tokens;
    if (this.issued.at(-1)?.access_token !== tokens.access_token) {
      this.issued.push(tokens);
      secrets.push(tokens.access_token, tokens.refresh_token ?? "none");
    }
  }
  redirectToAuthorization(authorizationUrl: URL) {
    this.authorizationUrl = authorizationUrl;
  }
  saveCodeVerifier(codeVerifier: string) {
    this.verifier = codeVerifier;
  }
  codeVerifier() {
    return this.verifier;
  }
  saveDiscoveryState(state: OAuthDiscoveryState) {
    this.discovery = state;
  }
  discoveryState() {
    return this.discovery;
  }
  invalidateCredentials(scope: string) {
    if (scope === "all" || scope === "tokens") this.current = undefined;
    if (scope === "all" || scope === "client") this.client = undefined;
    if (scope === "all" || scope === "discovery") this.discovery = undefined;
  }
}

/** One MCP client application: its OAuth state and the requests its SDK made. */
interface TestClient {
  provider: MemoryOAuthProvider;
  /** `METHOD path status` of every request the SDK made, in order. */
  trace: string[];
  /** `WWW-Authenticate` of every 401 the SDK was answered with. */
  challenges: string[];
  transport(): StreamableHTTPClientTransport;
  /** A connected SDK client. */
  connect(): Promise<Client>;
}

function newTestClient(): TestClient {
  // A loopback redirect URI, as a native client registers. Nothing listens
  // there: the test reads the redirect instead of following it.
  const provider = new MemoryOAuthProvider("http://127.0.0.1:33418/callback");
  const trace: string[] = [];
  const challenges: string[] = [];
  const tracedFetch: typeof fetch = async (input, init) => {
    const response = await httpFetch(input, init);
    const url = new URL(input instanceof Request ? input.url : String(input));
    trace.push(`${init?.method ?? "GET"} ${url.pathname} ${response.status}`);
    if (response.status === 401) {
      challenges.push(response.headers.get("www-authenticate") ?? "");
    }
    return response;
  };
  const transport = () =>
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      authProvider: provider,
      fetch: tracedFetch,
    });
  return {
    provider,
    trace,
    challenges,
    transport,
    async connect() {
      const client = new Client({ name: "e2e-client", version: "0.0.0" });
      clients.push(client);
      await client.connect(transport());
      return client;
    },
  };
}

/**
 * A `fetch` over HTTPS that trusts `ca` only, with the whole response read
 * before it resolves.
 */
function fetchTrusting(ca: string): typeof fetch {
  return (input, init) =>
    new Promise((resolve, reject) => {
      const request = https.request(
        input instanceof Request ? input.url : String(input),
        {
          method: init?.method ?? "GET",
          headers: Object.fromEntries(new Headers(init?.headers)),
          ca,
          agent: false,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => {
            const headers = new Headers();
            for (const [name, value] of Object.entries(response.headers)) {
              headers.set(name, String(value));
            }
            resolve(
              new Response(Buffer.concat(chunks), {
                status: response.statusCode,
                headers,
              }),
            );
          });
        },
      );
      request.on("error", reject);
      request.end(init?.body == null ? undefined : String(init.body));
    });
}

/** The sign-in form of a page: where it posts to and its signed login request. */
function signInForm(html: string): { action: string; loginRequest: string } {
  const action = /<form[^>]* action="([^"]+)"/.exec(html)?.[1];
  const loginRequest = /name="login_request" value="([^"]+)"/.exec(html)?.[1];
  if (!action || !loginRequest) {
    throw new Error("The page has no sign-in form.");
  }
  return { action, loginRequest };
}

/** What the browser does with a sign-in page: fill in the form and post it. */
function submitSignIn(html: string, profile: string, password: string) {
  const { action, loginRequest } = signInForm(html);
  return httpFetch(new URL(action, base), {
    method: "POST",
    redirect: "manual",
    headers: { origin: base },
    body: new URLSearchParams({
      login_request: loginRequest,
      profile,
      password,
    }),
  });
}

/**
 * Takes a client through the whole sign-on: the SDK discovers the
 * authorization server and registers, the "browser" signs on, the SDK
 * exchanges the code. Returns a connected client.
 */
async function signOn(
  testClient: TestClient,
  profile: string,
  password: string,
): Promise<Client> {
  const { provider } = testClient;
  // Without a token the SDK is answered 401, and asks for the user to be
  // sent to the authorization server.
  await expect(testClient.connect()).rejects.toBeInstanceOf(UnauthorizedError);
  const page = await httpFetch(provider.authorizationUrl!);
  expect(page.status).toBe(200);
  const signedOn = await submitSignIn(await page.text(), profile, password);
  expect(signedOn.status).toBe(303);
  const callback = new URL(signedOn.headers.get("location")!);
  secrets.push(callback.searchParams.get("code")!);
  expect(callback.origin + callback.pathname).toBe(provider.redirectUrl);
  expect(callback.searchParams.get("state")).toBe(provider.expectedState);
  await testClient.transport().finishAuth(callback.searchParams);
  return testClient.connect();
}

const text = (result: Awaited<ReturnType<Client["callTool"]>>) =>
  JSON.stringify(result.content);

/** The statements the fake ran, by the profile of the connection they ran on. */
const statementsOf = (profile: string) =>
  fake.requests.filter(
    (request) => request.profile === profile && typeof request.sql === "string",
  );

const jobsOf = (profile: string) =>
  fake.connects
    .filter((connect) => connect.profile === profile)
    .map((connect) => connect.job);

/** The audit events the server logged, in order. */
const auditEvents = () =>
  logged.lines.flatMap((line) => /event: '([a-z_]+)'/.exec(line)?.[1] ?? []);

/** No log line and no access-log line carries a secret of this test. */
function expectNoSecretLogged(): void {
  // The lines searched are the server's own: its audit events and its access
  // log are among them.
  expect(logged.lines.some((line) => line.includes("event: 'signon_ok'"))).toBe(
    true,
  );
  expect(accessLog).toContain("<-- POST /oauth/authorize");
  for (const secret of secrets) {
    expect(secret.length).toBeGreaterThan(8);
    for (const line of [...logged.lines, ...accessLog]) {
      // Not `expect(line).not.toContain(secret)`: a failure would print both.
      expect(line.includes(secret)).toBe(false);
    }
  }
}

describe("built-in IBM i sign-on, end to end", () => {
  it("discovers, registers, signs on, calls tools as the user, survives an idle close through a refresh, and ends at revocation", async () => {
    // The connection of a sign-on is closed after 60 ms without a request.
    // The sweep that does it runs every 30 s; the test fires it by hand.
    config.oauth.idleCloseMinutes = 0.001;
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const sourcePools = vi.spyOn(SourceManager.prototype, "registerSource");
    running = await initializeAndStartServer();

    // --- Discovery, as any client sees it ---------------------------------
    const unauthenticated = await fetch(`${base}/mcp`, { method: "POST" });
    expect(unauthenticated.status).toBe(401);
    const resourceMetadataUrl = `${base}/.well-known/oauth-protected-resource/mcp`;
    expect(unauthenticated.headers.get("www-authenticate")).toBe(
      `Bearer error="invalid_token", error_description="Missing Authorization header", resource_metadata="${resourceMetadataUrl}"`,
    );
    const resourceMetadata = (await (
      await fetch(resourceMetadataUrl)
    ).json()) as Record<string, unknown>;
    expect(resourceMetadata).toMatchObject({
      resource: `${base}/mcp`,
      authorization_servers: [base],
    });
    const serverMetadata = (await (
      await fetch(`${base}/.well-known/oauth-authorization-server`)
    ).json()) as Record<string, unknown>;
    expect(serverMetadata).toMatchObject({
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      revocation_endpoint: `${base}/oauth/revoke`,
      code_challenge_methods_supported: ["S256"],
      client_id_metadata_document_supported: true,
    });

    // --- The SDK client: 401, discovery, registration ----------------------
    const app = newTestClient();
    const { provider, trace } = app;
    await expect(app.connect()).rejects.toBeInstanceOf(UnauthorizedError);
    expect(trace).toEqual([
      "POST /mcp 401",
      "GET /.well-known/oauth-protected-resource/mcp 200",
      "GET /.well-known/oauth-authorization-server 200",
      "POST /oauth/register 201",
    ]);
    const registered = provider.clientInformation()!;
    expect(registered.client_id).toMatch(/^self\./);
    const authorizationUrl = provider.authorizationUrl!;
    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(
      `${base}/oauth/authorize`,
    );
    expect(Object.fromEntries(authorizationUrl.searchParams)).toMatchObject({
      response_type: "code",
      client_id: registered.client_id,
      redirect_uri: provider.redirectUrl,
      code_challenge_method: "S256",
      resource: `${base}/mcp`,
    });
    expect(fake.upgrades).toBe(0);

    // --- The browser: sign-in page and form --------------------------------
    const page = await fetch(authorizationUrl);
    expect(page.status).toBe(200);
    // The page's own headers, not the ones the other routes get: under
    // `Referrer-Policy: no-referrer` a browser posts the form with
    // `Origin: null`, which the server refuses.
    expect(page.headers.get("referrer-policy")).toBe("same-origin");
    expect(page.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    expect(page.headers.get("cache-control")).toContain("no-store");
    const html = await page.text();
    // The client is shown as it named itself, and where the result goes.
    expect(html).toContain("End-to-end test client");
    expect(html).toContain("http://127.0.0.1:33418/callback");

    const signedOn = await submitSignIn(html, "testuser", FAKE_PASSWORD);
    expect(signedOn.status).toBe(303);
    const callback = new URL(signedOn.headers.get("location")!);
    const code = callback.searchParams.get("code")!;
    secrets.push(code);
    expect(callback.origin + callback.pathname).toBe(provider.redirectUrl);
    expect(callback.searchParams.get("state")).toBe(provider.expectedState);
    expect(callback.searchParams.get("iss")).toBe(base);
    // Exactly one sign-on reached the IBM i, as the profile typed.
    expect(fake.connects).toEqual([
      expect.objectContaining({
        profile: FAKE_PROFILE,
        passwordMatched: true,
        application: expect.stringMatching(/^ibmi-mcp\//),
      }),
    ]);
    const [firstJob] = jobsOf(FAKE_PROFILE);

    // --- Token exchange, with PKCE ------------------------------------------
    const wrongVerifier = await fetch(`${base}/oauth/token`, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: "not-the-verifier-".repeat(3),
        client_id: registered.client_id,
        redirect_uri: provider.redirectUrl,
      }),
    });
    expect(wrongVerifier.status).toBe(400);
    expect(await wrongVerifier.json()).toMatchObject({
      error: "invalid_grant",
    });
    trace.length = 0;
    await app.transport().finishAuth(callback.searchParams);
    expect(trace).toEqual(["POST /oauth/token 200"]);
    expect(provider.issued).toHaveLength(1);
    expect(provider.issued[0]).toMatchObject({
      token_type: "Bearer",
      // The idle close plus five minutes.
      expires_in: 300,
      refresh_token: expect.any(String),
    });

    // --- Tools, on the connection of the signed-on user --------------------
    const client = await app.connect();
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    expect(tools).toEqual(expect.arrayContaining(["list_schemas", YAML_TOOL]));

    const schemas = await client.callTool({
      name: "list_schemas",
      arguments: { filter: "E2E%" },
    });
    expect(schemas.isError).toBeFalsy();
    expect(text(schemas)).toContain("E2ELIB");
    const counted = await client.callTool({ name: YAML_TOOL, arguments: {} });
    expect(counted.isError).toBeFalsy();
    expect(text(counted)).toContain("ACTIVE_JOBS");
    expect(statementsOf(FAKE_PROFILE).map((request) => request.sql)).toEqual([
      expect.stringContaining("USER_INFO_BASIC"),
      expect.stringContaining("QSYS2.SYSSCHEMAS"),
      expect.stringContaining("ACTIVE_JOB_INFO"),
    ]);
    // Still the one connection of the sign-on, and no service pool.
    expect(fake.upgrades).toBe(1);
    expect(sourcePools).not.toHaveBeenCalled();

    // --- Idle close ----------------------------------------------------------
    await new Promise((resolve) => setTimeout(resolve, 100));
    vi.advanceTimersByTime(SWEEP_INTERVAL_MS);
    await vi.waitFor(() => expect(fake.openSockets).toBe(0));
    expect(fake.requests).toContainEqual(
      expect.objectContaining({ profile: FAKE_PROFILE, type: "exit" }),
    );
    expect(await (await fetch(`${base}/healthz`)).json()).toMatchObject({
      signOn: { grants: 1, openConnections: 0 },
    });

    // --- 401, refresh, retry on a new job -----------------------------------
    trace.length = 0;
    app.challenges.length = 0;
    const afterIdle = await client.callTool({
      name: "list_schemas",
      arguments: { filter: "E2E%" },
    });
    expect(afterIdle.isError).toBeFalsy();
    expect(text(afterIdle)).toContain("E2ELIB");
    expect(trace).toEqual([
      "POST /mcp 401",
      "POST /oauth/token 200",
      "POST /mcp 200",
    ]);
    expect(app.challenges).toEqual([
      `Bearer error="invalid_token", error_description="connection closed, refresh", resource_metadata="${resourceMetadataUrl}"`,
    ]);
    expect(provider.issued).toHaveLength(2);
    expect(provider.issued[1]!.access_token).not.toBe(
      provider.issued[0]!.access_token,
    );
    expect(provider.issued[1]!.refresh_token).not.toBe(
      provider.issued[0]!.refresh_token,
    );
    // One more sign-on with the sealed password, on a new job.
    const jobs = jobsOf(FAKE_PROFILE);
    expect(jobs).toHaveLength(2);
    expect(jobs[1]).not.toBe(firstJob);
    expect(fake.openSockets).toBe(1);
    expect(statementsOf(FAKE_PROFILE)).toHaveLength(4);

    // --- Revocation ----------------------------------------------------------
    const { access_token: accessToken, refresh_token: refreshToken } =
      provider.issued[1]!;
    const revoked = await fetch(`${base}/oauth/revoke`, {
      method: "POST",
      body: new URLSearchParams({ token: refreshToken! }),
    });
    expect(revoked.status).toBe(200);
    await vi.waitFor(() => expect(fake.openSockets).toBe(0));

    const afterRevoke = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(afterRevoke.status).toBe(401);
    expect(afterRevoke.headers.get("www-authenticate")).toContain(
      'error="invalid_token", error_description="Invalid access token"',
    );
    // The SDK's refresh is refused too, so it asks for a new sign-on.
    trace.length = 0;
    await expect(
      client.callTool({ name: "list_schemas", arguments: {} }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(trace).toEqual(["POST /mcp 401", "POST /oauth/token 400"]);
    expect(fake.upgrades).toBe(2);
    expect(await (await fetch(`${base}/healthz`)).json()).toMatchObject({
      signOn: { grants: 0, openConnections: 0 },
    });

    expect(auditEvents()).toEqual([
      "signon_ok",
      "code_exchanged",
      "connection_closed",
      "token_refreshed",
      "reconnect_ok",
      "grant_ended",
    ]);
    expectNoSecretLogged();
  });

  it("parallel calls after an idle close share one refresh rotation and one new connection", async () => {
    config.oauth.idleCloseMinutes = 0.001;
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    running = await initializeAndStartServer();
    const app = newTestClient();
    const client = await signOn(app, FAKE_PROFILE, FAKE_PASSWORD);
    await new Promise((resolve) => setTimeout(resolve, 100));
    vi.advanceTimersByTime(SWEEP_INTERVAL_MS);
    await vi.waitFor(() => expect(fake.openSockets).toBe(0));

    // Each call that is answered 401 refreshes with the same refresh token:
    // the first rotates it, the others are given the same new pair. A call
    // that arrives while the connection is being reopened waits for it.
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        client.callTool({ name: "list_schemas", arguments: {} }),
      ),
    );

    for (const result of results) {
      expect(result.isError).toBeFalsy();
    }
    expect(app.provider.issued).toHaveLength(2);
    expect(jobsOf(FAKE_PROFILE)).toHaveLength(2);
    expect(fake.openSockets).toBe(1);
    const events = auditEvents();
    expect(events.filter((event) => event === "token_refreshed")).toHaveLength(
      1,
    );
    expect(events.filter((event) => event === "reconnect_ok")).toHaveLength(1);
    expect(events).not.toContain("grant_ended");
    expectNoSecretLogged();
  });

  it("two users signed on at once each run on their own connection", async () => {
    running = await initializeAndStartServer();

    const [first, second] = await Promise.all([
      signOn(newTestClient(), FAKE_PROFILE, FAKE_PASSWORD),
      signOn(newTestClient(), OTHER_PROFILE, OTHER_PASSWORD),
    ]);
    expect(fake.openSockets).toBe(2);

    // Interleaved calls, told apart by their filter.
    const calls = Array.from({ length: 6 }, () => [
      first.callTool({
        name: "list_schemas",
        arguments: { filter: "FIRST%" },
      }),
      second.callTool({
        name: "list_schemas",
        arguments: { filter: "SECOND%" },
      }),
      first.callTool({ name: YAML_TOOL, arguments: {} }),
    ]).flat();
    for (const result of await Promise.all(calls)) {
      expect(result.isError).toBeFalsy();
    }

    const ranFor = (filter: string) =>
      fake.requests
        .filter((request) => JSON.stringify(request.parameters) === filter)
        .map((request) => request.profile);
    expect(ranFor('["FIRST%",0,51]')).toEqual(Array(6).fill(FAKE_PROFILE));
    expect(ranFor('["SECOND%",0,51]')).toEqual(Array(6).fill(OTHER_PROFILE));
    expect(
      fake.requests
        .filter((request) => String(request.sql).includes("ACTIVE_JOB_INFO"))
        .map((request) => request.profile),
    ).toEqual(Array(6).fill(FAKE_PROFILE));
    // One sign-on and one job each; nothing was opened besides.
    expect(fake.upgrades).toBe(2);
    expect(fake.connects.map((connect) => connect.profile).sort()).toEqual([
      OTHER_PROFILE,
      FAKE_PROFILE,
    ]);
    expect(new Set(fake.connects.map((connect) => connect.job)).size).toBe(2);

    // Ending one sign-on leaves the other user's connection alone.
    await first.close();
    const health = (await (await fetch(`${base}/healthz`)).json()) as {
      signOn: Record<string, number>;
    };
    expect(health.signOn).toMatchObject({ grants: 2, openConnections: 2 });

    expectNoSecretLogged();
  });

  it("blocks a profile after two rejected passwords: the third attempt never reaches the IBM i", async () => {
    running = await initializeAndStartServer();
    const app = newTestClient();
    await expect(app.connect()).rejects.toBeInstanceOf(UnauthorizedError);
    let page = await fetch(app.provider.authorizationUrl!);

    for (const attempt of [1, 2]) {
      // A refused sign-on comes back as the page, with a new form.
      page = await submitSignIn(
        await page.text(),
        FAKE_PROFILE,
        WRONG_PASSWORD,
      );
      expect(page.status).toBe(200);
      expect(fake.signOns(FAKE_PROFILE)).toBe(attempt);
    }
    const second = await page.text();
    expect(second).toContain("Sign-on not accepted.");

    // The right password now: refused here, and not forwarded.
    const third = await submitSignIn(second, FAKE_PROFILE, FAKE_PASSWORD);
    expect(third.status).toBe(200);
    expect(await third.text()).toContain(
      "Sign-on for this user profile is blocked on this server",
    );
    expect(fake.signOns(FAKE_PROFILE)).toBe(2);
    expect(fake.upgrades).toBe(2);
    expect(fake.openSockets).toBe(0);
    expect(await (await fetch(`${base}/healthz`)).json()).toMatchObject({
      signOn: { grants: 0, openConnections: 0, blockedProfiles: 1 },
    });

    // Another profile is not affected.
    const other = await signOn(newTestClient(), OTHER_PROFILE, OTHER_PASSWORD);
    expect((await other.listTools()).tools.length).toBeGreaterThan(0);
    expect(fake.signOns(FAKE_PROFILE)).toBe(2);

    expectNoSecretLogged();
  });

  it("serves the whole sign-on over its own TLS listener", async () => {
    const certificate = generateCertificates(["127.0.0.1", "localhost"]);
    config.mcpTlsCertFile = join(directory, "listener.crt");
    config.mcpTlsKeyFile = join(directory, "listener.key");
    writeFileSync(config.mcpTlsCertFile, certificate.certPem);
    writeFileSync(config.mcpTlsKeyFile, certificate.keyPem);
    base = `https://127.0.0.1:${config.mcpHttpPort}`;
    config.mcpResourceUrl = `${base}/mcp`;
    httpFetch = fetchTrusting(certificate.caPem);
    running = await initializeAndStartServer();

    // Nothing answers in cleartext on that port.
    await expect(
      fetch(`http://127.0.0.1:${config.mcpHttpPort}/healthz`),
    ).rejects.toThrow();

    const app = newTestClient();
    const client = await signOn(app, FAKE_PROFILE, FAKE_PASSWORD);
    expect(app.trace).toEqual(
      expect.arrayContaining([
        "GET /.well-known/oauth-authorization-server 200",
        "POST /oauth/register 201",
        "POST /oauth/token 200",
      ]),
    );
    // Every endpoint the client was told about is an https one.
    expect(app.provider.authorizationUrl!.origin).toBe(base);
    expect(app.provider.issued[0]!.issuer).toBe(base);

    const schemas = await client.callTool({
      name: "list_schemas",
      arguments: {},
    });
    expect(schemas.isError).toBeFalsy();
    expect(text(schemas)).toContain("E2ELIB");
    expect(statementsOf(FAKE_PROFILE)).toHaveLength(2);

    expectNoSecretLogged();
  });
});

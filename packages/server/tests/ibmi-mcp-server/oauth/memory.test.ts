/**
 * @fileoverview Memory test of the built-in IBM i sign-on: after a sign-on
 * and after a refresh that reopens the IBM i connection, no JavaScript
 * string in this process holds the password, the authorization code or a
 * refresh token, and the password and the refresh tokens are not in the
 * Buffer pool.
 *
 * The server is started the way the binary starts it
 * (`initializeAndStartServer`) on a loopback port. What is searched is a V8
 * heap snapshot of this process, so nothing here may make a string of a
 * secret either:
 * - the fake Mapepire server runs in a worker thread (its own heap);
 * - the test is its own browser and OAuth client, and handles the password,
 *   the code and the refresh tokens as bytes in unpooled Buffers only;
 * - the secrets are computed, not written out: source text is in the heap.
 *
 * The snapshot is searched as bytes, with V8's truncation of long strings
 * switched off, and canary strings show that the search finds what is there.
 *
 * Every credential is made up; no IBM i is involved.
 */

import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  closeSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { connect, createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import v8 from "node:v8";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { config } from "../../../src/config/index.js";
import { SWEEP_INTERVAL_MS } from "../../../src/ibmi-mcp-server/oauth/contracts.js";
import {
  initializeAndStartServer,
  type RunningServer,
} from "../../../src/mcp-server/server.js";
import { rateLimiter } from "../../../src/utils/index.js";
import {
  startIsolatedFakeMapepire,
  type IsolatedFakeMapepire,
} from "./fakeMapepire.js";

// Eight characters, so that "HEAPUSER:" is nine bytes and the Base64 of the
// password is a substring of the Base64 of the Basic credentials.
const PROFILE = "HEAPUSER";
const CLIENT_ID = "https://client.example/oauth/metadata.json";
const REDIRECT = "http://127.0.0.1:33418/callback";
const VERIFIER = "pkce-verifier-".repeat(4);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

const saved = {
  config: {
    mcpTransportType: config.mcpTransportType,
    mcpHttpHost: config.mcpHttpHost,
    mcpHttpPort: config.mcpHttpPort,
    mcpAuthMode: config.mcpAuthMode,
    mcpResourceUrl: config.mcpResourceUrl,
    oauthIssuerUrl: config.oauthIssuerUrl,
    toolsYamlPath: config.toolsYamlPath,
    ibmi_enableDefaultTools: config.ibmi_enableDefaultTools,
  },
  idleCloseMinutes: config.oauth.idleCloseMinutes,
  mapepire: { ...config.oauth.mapepire },
  ibmiHttpAuthEnabled: config.ibmiHttpAuth.enabled,
  env: {
    DB2i_PASS: process.env.DB2i_PASS,
    DB2i_IGNORE_UNAUTHORIZED: process.env.DB2i_IGNORE_UNAUTHORIZED,
    DB2i_JDBC_OPTIONS: process.env.DB2i_JDBC_OPTIONS,
  },
};

let directory: string;
let isolated: IsolatedFakeMapepire | undefined;
let running: RunningServer | undefined;
let base: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "ibmi-mcp-memory-"));
  for (const name of Object.keys(saved.env)) {
    delete process.env[name];
  }
});

const POOL_SIZE = Buffer.poolSize;

afterEach(async () => {
  Buffer.poolSize = POOL_SIZE;
  await running?.close();
  running = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  await isolated?.stop();
  isolated = undefined;
  rmSync(directory, { recursive: true, force: true });
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

/** 24 bytes that follow a pattern; `first` 0x61 gives the password. */
function patterned(first: number, span = 26): Buffer {
  const bytes = Buffer.allocUnsafeSlow(24);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = first + ((i * 7 + 3) % span);
  }
  return bytes;
}

/** The password of this test, in a Buffer of its own. Never a literal. */
const password = () => patterned(0x61);

/** The parts as one unpooled Buffer. A string part must hold no secret. */
function unpooled(...parts: Array<string | Buffer>): Buffer<ArrayBuffer> {
  let length = 0;
  for (const part of parts) {
    length += part.length;
  }
  const whole = Buffer.allocUnsafeSlow(length);
  let offset = 0;
  for (const part of parts) {
    offset +=
      typeof part === "string"
        ? whole.write(part, offset, "latin1")
        : part.copy(whole, offset);
  }
  return whole;
}

/** Posts a form body and zero-fills it. */
async function postForm(path: string, body: Buffer<ArrayBuffer>) {
  try {
    return await fetch(base + path, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: base,
      },
      body,
    });
  } finally {
    body.fill(0);
  }
}

/**
 * Posts a form body on a socket of its own, zero-fills it, and returns the
 * whole answer, head and body, in one unpooled Buffer. `fetch` would put the
 * answer in the Buffer pool or make a string of it.
 */
async function postRaw(path: string, body: Buffer<ArrayBuffer>) {
  const { port } = new URL(base);
  const socket = connect(Number(port), "127.0.0.1");
  await once(socket, "connect");
  socket.write(
    unpooled(
      `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${base}\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`,
      body,
    ),
  );
  body.fill(0);
  const chunks: Buffer[] = [];
  for await (const chunk of socket) {
    chunks.push(chunk as Buffer);
  }
  const answer = unpooled(...chunks);
  for (const chunk of chunks) {
    chunk.fill(0);
  }
  return answer;
}

/** Posts the sign-in form. Returns the code of the redirect, in a Buffer of its own. */
async function signOnCode(body: Buffer<ArrayBuffer>) {
  const answer = await postRaw("/oauth/authorize", body);
  try {
    expect(answer.subarray(0, 12).toString("latin1")).toBe("HTTP/1.1 303");
    const start = answer.indexOf("?code=") + "?code=".length;
    return unpooled(answer.subarray(start, answer.indexOf("&", start)));
  } finally {
    answer.fill(0);
  }
}

/** The signed login request of a sign-in page. */
function loginRequestOf(html: string): string {
  const marker = 'name="login_request" value="';
  const start = html.indexOf(marker) + marker.length;
  return html.slice(start, html.indexOf('"', start));
}

/** A string member of a JSON body, as bytes in a Buffer of its own. */
function member(json: Buffer, name: string): Buffer {
  const marker = `"${name}":"`;
  const start = json.indexOf(marker) + marker.length;
  const end = json.indexOf('"', start);
  return unpooled(json.subarray(start, end));
}

/** Posts to the token endpoint; the tokens of the answer, as bytes. */
async function tokens(body: Buffer<ArrayBuffer>) {
  const json = await postRaw("/oauth/token", body);
  try {
    expect(json.subarray(0, 12).toString("latin1")).toBe("HTTP/1.1 200");
    return {
      accessToken: member(json, "access_token"),
      refreshToken: member(json, "refresh_token"),
    };
  } finally {
    json.fill(0);
  }
}

const refresh = (refreshToken: Buffer) =>
  tokens(
    unpooled(
      `grant_type=refresh_token&client_id=${encodeURIComponent(CLIENT_ID)}&refresh_token=`,
      refreshToken,
    ),
  );

/** Calls a built-in tool as the holder of an access token. */
async function listSchemas(accessToken: Buffer): Promise<void> {
  // The access token is a header on every MCP request: a string by nature.
  const bearer = accessToken.toString("latin1");
  const client = new Client({ name: "memory-test", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      authProvider: { token: async () => bearer },
    }),
  );
  try {
    const result = await client.callTool({
      name: "list_schemas",
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
  } finally {
    await client.close();
  }
}

/**
 * A V8 heap snapshot of this process, as its JSON bytes. It starts with a
 * full GC. Written to a file and read into an unpooled Buffer: the chunks of
 * `v8.getHeapSnapshot()` come from the Buffer pool this test checks, and
 * tens of megabytes of them would fill its slab.
 */
function heapSnapshot(): Buffer {
  const file = v8.writeHeapSnapshot(join(directory, "heap.heapsnapshot"));
  const fd = openSync(file, "r");
  try {
    const snapshot = Buffer.allocUnsafeSlow(fstatSync(fd).size);
    let read = 0;
    while (read < snapshot.length) {
      read += readSync(fd, snapshot, read, snapshot.length - read, read);
    }
    return snapshot;
  } finally {
    closeSync(fd);
    rmSync(file);
  }
}

/** How often each needle is in the snapshot. The needles stay bytes. */
function occurrences<Name extends string>(
  snapshot: Buffer,
  needles: Record<Name, Buffer>,
): Record<Name, number> {
  const counts = {} as Record<Name, number>;
  for (const name of Object.keys(needles) as Name[]) {
    let count = 0;
    for (
      let at = snapshot.indexOf(needles[name]);
      at !== -1;
      at = snapshot.indexOf(needles[name], at + 1)
    ) {
      count++;
    }
    counts[name] = count;
  }
  return counts;
}

/** The password as a string could hold it: whole, in part, upper-cased, as Base64. */
function passwordNeedles() {
  const plain = password();
  const upper = unpooled(plain);
  for (let i = 0; i < upper.length; i++) {
    upper[i] = upper[i]! - 0x20;
  }
  const base64 = Buffer.allocUnsafeSlow(32);
  base64.write(plain.toString("base64"), "latin1");
  return {
    password: plain,
    passwordStart: plain.subarray(0, 12),
    passwordEnd: plain.subarray(12),
    upperCased: upper,
    upperCasedPart: upper.subarray(6, 18),
    base64,
    base64Part: base64.subarray(4, 24),
  };
}

/** A refresh token, whole and in two parts. */
const tokenNeedles = (token: Buffer) => ({
  whole: token,
  start: token.subarray(0, 20),
  end: token.subarray(20),
});

const NONE = { whole: 0, start: 0, end: 0 };

it("leaves no string with the password, the code or a refresh token in the heap, and neither in the Buffer pool", async () => {
  // Strings longer than 1024 characters are cut in a snapshot by default.
  v8.setFlagsFromString("--heap-snapshot-string-limit=10000000");
  isolated = await startIsolatedFakeMapepire({
    accounts: { [PROFILE]: password().toString("latin1") },
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
      { match: "QSYS2.SYSSCHEMAS", reply: { rows: [{ SCHEMA_NAME: "LIB" }] } },
    ],
  });
  const pinFile = join(directory, "mapepire-pin.pem");
  writeFileSync(pinFile, isolated.certPem);
  const port = await new Promise<number>((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const address = probe.address() as AddressInfo;
      probe.close(() => resolve(address.port));
    });
  });
  base = `http://127.0.0.1:${port}`;
  Object.assign(config, {
    mcpTransportType: "http",
    mcpHttpHost: "127.0.0.1",
    mcpHttpPort: port,
    mcpAuthMode: "oauth",
    mcpResourceUrl: `${base}/mcp`,
    oauthIssuerUrl: undefined,
    toolsYamlPath: undefined,
    ibmi_enableDefaultTools: true,
  });
  Object.assign(config.oauth.mapepire, {
    host: "127.0.0.1",
    port: isolated.port,
    serverCertFile: pinFile,
    caFile: undefined,
  });
  config.ibmiHttpAuth.enabled = false;
  // The connection is closed after 60 ms without a request, by a sweep the
  // test fires by hand.
  config.oauth.idleCloseMinutes = 0.001;
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  // The access log: method, path and status.
  vi.spyOn(console, "log").mockImplementation(() => {});

  // One slab for every pooled allocation from here on, so that the check
  // at the end sees all of them: the current slab is filled up, and the
  // next one is made at the new size.
  Buffer.poolSize = 64 * 1024 * 1024;
  const slab = Buffer.allocUnsafe(1).buffer;
  while (Buffer.allocUnsafe(1).buffer === slab) {
    Buffer.allocUnsafe(4096);
  }
  const poolBefore = Buffer.allocUnsafe(1).buffer;
  expect(poolBefore.byteLength).toBe(Buffer.poolSize);
  running = await initializeAndStartServer();

  // --- Sign-on ---------------------------------------------------------------
  const authorize = new URL(`${base}/oauth/authorize`);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
  }).toString();
  const page = await fetch(authorize);
  expect(page.status).toBe(200);

  // The fields swapped: the password typed into the profile field. Refused
  // here; the page comes back with a new form.
  const swapped = await postForm(
    "/oauth/authorize",
    unpooled(
      `login_request=${loginRequestOf(await page.text())}&profile=`,
      password(),
      `&password=${PROFILE}`,
    ),
  );
  expect(swapped.status).toBe(200);
  const again = await swapped.text();
  expect(again).toContain("That is not a user profile name");

  const code = await signOnCode(
    unpooled(
      `login_request=${loginRequestOf(again)}&profile=${PROFILE}&password=`,
      password(),
    ),
  );
  const first = await tokens(
    unpooled(
      `grant_type=authorization_code&code_verifier=${VERIFIER}&client_id=${encodeURIComponent(CLIENT_ID)}&redirect_uri=${encodeURIComponent(REDIRECT)}&code=`,
      code,
    ),
  );
  await listSchemas(first.accessToken);

  // Strings that are reachable on purpose: the search must find them. The
  // second is at the end of one long flat string, past where V8 would cut
  // it.
  const canary = patterned(0x30, 10).toString("latin1");
  const longCanary = unpooled("-".repeat(5000), patterned(0x47, 20)).toString(
    "latin1",
  );
  const canaries = { short: patterned(0x30, 10), long: patterned(0x47, 20) };
  await new Promise((resolve) => setTimeout(resolve, 300));

  let snapshot = heapSnapshot();
  expect(occurrences(snapshot, canaries)).toEqual({
    short: expect.toSatisfy((count: number) => count > 0),
    long: expect.toSatisfy((count: number) => count > 0),
  });
  // The server does hold the profile, as a string.
  expect(snapshot.includes(PROFILE)).toBe(true);
  expect(occurrences(snapshot, passwordNeedles())).toEqual({
    password: 0,
    passwordStart: 0,
    passwordEnd: 0,
    upperCased: 0,
    upperCasedPart: 0,
    base64: 0,
    base64Part: 0,
  });
  expect(occurrences(snapshot, tokenNeedles(first.refreshToken))).toEqual(NONE);
  // Nor the code: it was a string only while its redirect was built.
  expect(occurrences(snapshot, tokenNeedles(code))).toEqual(NONE);

  // --- Idle close, then a refresh that signs on again with the sealed password
  vi.advanceTimersByTime(SWEEP_INTERVAL_MS);
  await vi.waitFor(async () =>
    expect((await isolated!.state()).requests).toContainEqual(
      expect.objectContaining({ profile: PROFILE, type: "exit" }),
    ),
  );
  // The next request finds the connection closed; the refresh reopens it.
  const refused = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${first.accessToken.toString("latin1")}`,
    },
  });
  expect(refused.status).toBe(401);
  const second = await refresh(first.refreshToken);
  // The previous refresh token again: the same pair, from the replay record.
  const replayed = await refresh(first.refreshToken);
  expect(replayed.refreshToken.equals(second.refreshToken)).toBe(true);
  expect(second.refreshToken.equals(first.refreshToken)).toBe(false);
  // Waits for the reconnect, then runs on the new connection.
  await listSchemas(second.accessToken);
  expect((await isolated.state()).connects).toMatchObject([
    { profile: PROFILE, passwordMatched: true },
    { profile: PROFILE, passwordMatched: true },
  ]);
  await new Promise((resolve) => setTimeout(resolve, 300));

  snapshot = heapSnapshot();
  expect(occurrences(snapshot, canaries)).toEqual({
    short: expect.toSatisfy((count: number) => count > 0),
    long: expect.toSatisfy((count: number) => count > 0),
  });
  expect(occurrences(snapshot, passwordNeedles())).toEqual({
    password: 0,
    passwordStart: 0,
    passwordEnd: 0,
    upperCased: 0,
    upperCasedPart: 0,
    base64: 0,
    base64Part: 0,
  });
  expect(occurrences(snapshot, tokenNeedles(first.refreshToken))).toEqual(NONE);
  expect(occurrences(snapshot, tokenNeedles(second.refreshToken))).toEqual(
    NONE,
  );
  expect(occurrences(snapshot, tokenNeedles(code))).toEqual(NONE);

  // Nor are the bytes in the Buffer pool: the one slab of the whole test.
  // A boolean: a failing toBe on two 64 MiB slabs would print their diff.
  expect(Buffer.allocUnsafe(1).buffer === poolBefore).toBe(true);
  const pool = Buffer.from(poolBefore);
  expect(pool.includes(password())).toBe(false);
  expect(pool.includes(first.refreshToken)).toBe(false);
  expect(pool.includes(second.refreshToken)).toBe(false);
  // Kept reachable until here.
  expect(canary.length + longCanary.length).toBe(5048);
}, 180_000);

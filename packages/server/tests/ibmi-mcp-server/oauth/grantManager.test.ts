/**
 * @fileoverview Tests for the grant manager of the built-in OAuth sign-on,
 * driven against the in-process fake Mapepire server. Every credential is
 * made up; no IBM i is involved.
 *
 * The manager's clock is the `clock` variable; timers are faked only in the
 * tests that call `fakeTimers`, and sockets always run in real time.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../../../src/config/index.js";
import {
  CONNECT_REPLY_TIMEOUT_MS,
  HANDSHAKE_TIMEOUT_MS,
  RECONNECT_BACKOFF_MS,
  RECONNECT_WAIT_MS,
  SOFT_BUDGET,
  STATEMENT_QUEUE_DEPTH,
  STATEMENT_TIMEOUT_MS,
  SWEEP_INTERVAL_MS,
  type CodeExchangeRequest,
  type GrantManager,
  type MapepireClient,
  type RefreshRequest,
  type SignOnOutcome,
  type SignOnRequest,
  type TokenResult,
} from "../../../src/ibmi-mcp-server/oauth/contracts.js";
import { createGrantManager } from "../../../src/ibmi-mcp-server/oauth/grantManager.js";
import { createMapepireClient } from "../../../src/ibmi-mcp-server/oauth/mapepireSession.js";
import {
  newSecret,
  seal,
  sealReplay,
  unseal,
  unwrapKey,
  wrapKey,
} from "../../../src/ibmi-mcp-server/oauth/sealing.js";
import {
  JsonRpcErrorCode,
  McpError,
} from "../../../src/types-global/errors.js";
import { logger } from "../../../src/utils/internal/logger.js";
import {
  FAKE_PASSWORD,
  startFakeMapepire,
  type FakeMapepire,
  type SignOnBehaviour,
} from "./fakeMapepire.js";

// A paginated result stops at 4 rows in this file.
vi.hoisted(() => {
  process.env.IBMI_PAGINATION_MAX_ROWS = "4";
});

// The server holds at most 6 grants in this file (1,000 in production).
vi.mock(
  "../../../src/ibmi-mcp-server/oauth/contracts.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../../src/ibmi-mcp-server/oauth/contracts.js")
    >()),
    MAX_GRANTS: 6,
  }),
);

// The real envelope, with its results recorded so tests can look at the
// Buffers it handed out.
vi.mock(
  "../../../src/ibmi-mcp-server/oauth/sealing.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../src/ibmi-mcp-server/oauth/sealing.js")
      >();
    return {
      ...actual,
      newSecret: vi.fn(actual.newSecret),
      seal: vi.fn(actual.seal),
      unseal: vi.fn(actual.unseal),
      wrapKey: vi.fn(actual.wrapKey),
      unwrapKey: vi.fn(actual.unwrapKey),
      sealReplay: vi.fn(actual.sealReplay),
    };
  },
);

const CLIENT_ID = "https://client.example/oauth/metadata.json";
const REDIRECT = "http://127.0.0.1:33418/callback";
const ADDRESS = "10.1.2.3";
const VERIFIER = "pkce-verifier-".repeat(4);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");
const WRONG_PASSWORD = "wrong-Pw-000";
const CHANGED_PASSWORD = "changed-Pw-456";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const PROFILE_ROW = {
  STATUS: "*ENABLED",
  PASSWORD_CHANGE_DATE: "2026-01-01 00:00:00.000000",
  SPECIAL_AUTHORITIES: null,
};

const realSetTimeout = setTimeout;

let fake: FakeMapepire;
let clock: number;
let managers: GrantManager[];
/** Every log call, as JSON. */
let lines: string[];
/** Every password, code and token a test handled. */
let secrets: string[];

beforeEach(async () => {
  vi.clearAllMocks();
  Object.assign(config.oauth, {
    codeAddressBinding: "strict",
    grantMaxHours: 12,
    idleCloseMinutes: 10,
    maxConnections: 50,
    allowedProfiles: [],
    allowPrivilegedProfiles: false,
    signOnMaxFailures: 2,
  });
  clock = Date.UTC(2026, 10, 10, 12);
  managers = [];
  lines = [];
  secrets = [
    FAKE_PASSWORD,
    WRONG_PASSWORD,
    CHANGED_PASSWORD,
    Buffer.from(`TESTUSER:${FAKE_PASSWORD}`).toString("base64"),
  ];
  for (const level of ["debug", "info", "warning", "error"] as const) {
    vi.spyOn(logger, level).mockImplementation((...args: unknown[]) => {
      lines.push(JSON.stringify(args));
    });
  }
  fake = await startFakeMapepire({
    accounts: {
      TESTUSER: FAKE_PASSWORD,
      OTHERUSR: FAKE_PASSWORD,
      THIRDUSR: FAKE_PASSWORD,
    },
  });
  profileRow({});
});

afterEach(async () => {
  // Cut the sockets first: a stalled fake never completes a close handshake.
  fake.drop();
  await Promise.all(managers.map((grants) => grants.shutdown()));
  vi.useRealTimers();
  vi.restoreAllMocks();
  await fake.stop();
  // No test may have logged a password, a code or a token.
  for (const secret of secrets) {
    expect(lines.filter((line) => line.includes(secret))).toEqual([]);
  }
});

// --- Helpers ----------------------------------------------------------------

/** What the fake answers for the profile's row in QSYS2.USER_INFO_BASIC. */
function profileRow(row: Record<string, unknown>): void {
  fake.statements = [
    ...fake.statements.filter(({ match }) => match !== "USER_INFO_BASIC"),
    { match: "USER_INFO_BASIC", reply: { rows: [{ ...PROFILE_ROW, ...row }] } },
  ];
}

function clientFor(): MapepireClient {
  return createMapepireClient({
    host: "127.0.0.1",
    port: fake.port,
    trust: { kind: "pin", pem: Buffer.from(fake.certPem) },
  });
}

function manager(mapepire: MapepireClient = clientFor()): GrantManager {
  const grants = createGrantManager({ mapepire, now: () => clock });
  managers.push(grants);
  return grants;
}

type SignOnFields = Partial<
  Omit<SignOnRequest, "profile" | "password"> & {
    profile: string;
    password: string;
  }
>;

function signOn(grants: GrantManager, fields: SignOnFields = {}) {
  const { profile = "testuser", password = FAKE_PASSWORD, ...rest } = fields;
  return grants.signOn({
    profile: Buffer.from(profile),
    password: Buffer.from(password),
    clientId: CLIENT_ID,
    redirectUri: REDIRECT,
    codeChallenge: CHALLENGE,
    address: ADDRESS,
    ...rest,
  });
}

/** A sign-on that must succeed: its code and grant id. */
async function signOnCode(grants: GrantManager, fields: SignOnFields = {}) {
  const result = await signOn(grants, fields);
  if (!result.ok) throw new Error(`sign-on was refused: ${result.reason}`);
  secrets.push(result.code);
  return result;
}

function exchange(
  grants: GrantManager,
  code: string,
  fields: Partial<CodeExchangeRequest> = {},
) {
  return grants.exchangeCode({
    code: Buffer.from(code),
    codeVerifier: VERIFIER,
    clientId: CLIENT_ID,
    redirectUri: REDIRECT,
    address: ADDRESS,
    ...fields,
  });
}

/** The tokens of an answer that must be a success, as text. */
function tokens(result: TokenResult) {
  if (!result.ok) throw new Error(`the token request failed: ${result.error}`);
  const pair = {
    accessToken: result.accessToken.toString("latin1"),
    refreshToken: result.refreshToken.toString("latin1"),
  };
  secrets.push(pair.accessToken, pair.refreshToken);
  return pair;
}

/** Signs on and exchanges the code. */
async function grant(grants: GrantManager, fields: SignOnFields = {}) {
  const { code, grantId } = await signOnCode(grants, fields);
  return {
    grantId,
    ...tokens(
      await exchange(
        grants,
        code,
        fields.redirectUri ? { redirectUri: fields.redirectUri } : {},
      ),
    ),
  };
}

function refresh(
  grants: GrantManager,
  refreshToken: string,
  fields: Partial<RefreshRequest> = {},
) {
  return grants.refresh({
    refreshToken: Buffer.from(refreshToken),
    clientId: CLIENT_ID,
    address: ADDRESS,
    ...fields,
  });
}

/** Fakes the timers the manager and its sessions set; sockets stay real. */
function fakeTimers(): void {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
}

/**
 * Moves the manager's clock, then lets its sweep run once. The faked timers
 * move by one sweep interval only, so that no timeout fires on I/O that is
 * still under way in real time.
 */
async function sweepAfter(ms: number): Promise<void> {
  clock += ms;
  await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);
}

/** Waits on real I/O, also while timers are faked. */
async function until(condition: () => boolean): Promise<void> {
  while (!condition()) await new Promise((resolve) => setImmediate(resolve));
}

/** Real time for something that must not happen to have had its chance. */
const settle = () => new Promise((resolve) => realSetTimeout(resolve, 50));

/** A grant whose connection the sweep has closed as idle. */
async function idleGrant(grants: GrantManager, fields: SignOnFields = {}) {
  grants.start();
  const signedOn = await grant(grants, fields);
  await sweepAfter(10 * MINUTE);
  await until(() => grants.status().openConnections === 0);
  return signedOn;
}

async function rejection(promise: Promise<unknown>): Promise<McpError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(McpError);
  return error as McpError;
}

const entries = () =>
  lines.map((line) => (JSON.parse(line) as [Record<string, unknown>])[0]);
const logged = (event: string) =>
  entries().filter((entry) => entry?.event === event);
const allZero = (buffer: Buffer) => buffer.every((byte) => byte === 0);
const results = (mock: unknown) =>
  vi
    .mocked(mock as () => Buffer | undefined)
    .mock.results.map((result) => result.value)
    .filter((value): value is Buffer => Buffer.isBuffer(value));
const rejectedAtFake = () =>
  fake.connects.filter((connect) => !connect.passwordMatched).length;

// --- Tests ------------------------------------------------------------------

describe("the whole flow", () => {
  it("signs on, exchanges the code, runs SQL as the profile, refreshes and revokes", async () => {
    fake.statements.push({ match: "SYSDUMMY1", reply: { rows: [{ ONE: 1 }] } });
    const grants = manager();
    grants.start();

    const password = Buffer.from(FAKE_PASSWORD);
    const signedOn = await grants.signOn({
      profile: Buffer.from("testuser"),
      password,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT,
      codeChallenge: CHALLENGE,
      address: ADDRESS,
    });
    if (!signedOn.ok) throw new Error(signedOn.reason);
    const { code, grantId } = signedOn;
    secrets.push(code);
    expect(allZero(password)).toBe(true);
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The code left the manager as text; its bytes are wiped.
    expect(results(newSecret)).toHaveLength(1);
    expect(allZero(results(newSecret)[0]!)).toBe(true);
    expect(fake.connects).toEqual([
      expect.objectContaining({
        profile: "TESTUSER",
        passwordMatched: true,
        application: `ibmi-mcp/${grantId}`,
      }),
    ]);
    expect(fake.requests[0]).toMatchObject({
      type: "prepare_sql_execute",
      parameters: ["TESTUSER"],
    });
    expect(String(fake.requests[0]!.sql)).toContain("QSYS2.USER_INFO_BASIC");

    const first = await exchange(grants, code);
    expect(first).toMatchObject({ ok: true, expiresInSeconds: 15 * 60 });
    const { accessToken, refreshToken } = tokens(first);
    expect(accessToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await expect(grants.authenticate(accessToken)).resolves.toEqual({
      profile: "TESTUSER",
      grantId,
      clientId: CLIENT_ID,
      expiresAt: Math.floor((clock + 15 * MINUTE) / 1000),
    });

    const result = await grants.executeQuery(
      grantId,
      "SELECT 1 AS ONE FROM SYSIBM.SYSDUMMY1",
    );
    expect(result.data).toEqual([{ ONE: 1 }]);
    expect(fake.requests.at(-1)).toMatchObject({
      profile: "TESTUSER",
      type: "sql",
    });
    expect(grants.status()).toEqual({
      grants: 1,
      openConnections: 1,
      maxConnections: 50,
      blockedProfiles: 0,
    });
    // The sweep and the sign-on asked Mapepire for nothing but the upgrade.
    expect(fake.httpRequests).toBe(0);
    expect(grants.describeGrants()).toEqual([
      {
        grantId,
        profile: "TESTUSER",
        clientId: CLIENT_ID,
        jobName: fake.connects[0]!.job,
        createdAt: clock,
        lastUsedAt: clock,
        expiresAt: clock + 12 * HOUR,
      },
    ]);

    const rotated = tokens(await refresh(grants, refreshToken));
    expect(rotated.accessToken).not.toBe(accessToken);
    expect(rotated.refreshToken).not.toBe(refreshToken);
    // A rotation does not replace access tokens: each lives its own time.
    expect(await grants.authenticate(accessToken)).toMatchObject({ grantId });
    expect(await grants.authenticate(rotated.accessToken)).toMatchObject({
      grantId,
    });

    await grants.revoke(Buffer.from(rotated.accessToken));
    expect(await grants.authenticate(accessToken)).toBe("invalid_token");
    expect(await grants.authenticate(rotated.accessToken)).toBe(
      "invalid_token",
    );
    expect(await refresh(grants, rotated.refreshToken)).toEqual({
      ok: false,
      error: "invalid_grant",
    });
    await until(() => fake.openSockets === 0);
    expect(fake.requests.some((request) => request.type === "exit")).toBe(true);
    expect(fake.connects).toHaveLength(1);
    expect(grants.status()).toMatchObject({ grants: 0, openConnections: 0 });

    expect(logged("signon_ok")).toEqual([
      expect.objectContaining({
        profile: "TESTUSER",
        clientId: CLIENT_ID,
        destination: REDIRECT,
        address: ADDRESS,
        grantId,
        job: fake.connects[0]!.job,
        tokenHash: createHash("sha256").update(code).digest("hex").slice(0, 8),
      }),
    ]);
    expect(logged("code_exchanged")).toHaveLength(1);
    expect(logged("token_refreshed")).toHaveLength(1);
    expect(logged("grant_ended")).toEqual([
      expect.objectContaining({ grantId, reason: "revoked" }),
    ]);
  });

  it("derives the access-token lifetime from OAUTH_IDLE_CLOSE_MINUTES", async () => {
    config.oauth.idleCloseMinutes = 3;
    const grants = manager();
    const { code } = await signOnCode(grants);
    const answer = await exchange(grants, code);
    expect(answer).toMatchObject({ ok: true, expiresInSeconds: 8 * 60 });
    const { accessToken } = tokens(answer);
    clock += 8 * MINUTE - 1;
    expect(await grants.authenticate(accessToken)).toMatchObject({
      profile: "TESTUSER",
    });
    clock += 1;
    expect(await grants.authenticate(accessToken)).toBe("invalid_token");
  });

  it("looks an access token up without copying it into the Buffer pool", async () => {
    const grants = manager();
    const { grantId, accessToken } = await grant(grants);
    const poolBefore = Buffer.allocUnsafe(1).buffer;

    expect(await grants.authenticate(accessToken)).toMatchObject({ grantId });

    for (const slab of [poolBefore, Buffer.allocUnsafe(1).buffer]) {
      expect(Buffer.from(slab).includes(accessToken)).toBe(false);
    }
  });

  it("answers an unknown access token with invalid_token", async () => {
    const grants = manager();
    await grant(grants);
    expect(await grants.authenticate("not-a-token")).toBe("invalid_token");
  });
});

describe("checks before anything is forwarded", () => {
  it("refuses a profile that is not a profile name and logs nothing typed", async () => {
    const grants = manager();
    const password = Buffer.from(FAKE_PASSWORD);
    const result = await grants.signOn({
      profile: Buffer.from("my pass!"),
      password,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT,
      codeChallenge: CHALLENGE,
      address: ADDRESS,
    });
    expect(result).toEqual({ ok: false, reason: "profile_syntax" });
    expect(allZero(password)).toBe(true);
    expect(fake.upgrades).toBe(0);
    expect(logged("signon_refused_syntax")).toHaveLength(1);
    expect(lines.filter((line) => /my pass/i.test(line))).toEqual([]);
    // The refusal gave the sign-on slot back.
    expect(
      await signOn(grants, { profile: "my pass!", password: "my pass!" }),
    ).toEqual({ ok: false, reason: "profile_syntax" });
  });

  it("applies the profile filter before the profile's syntax", async () => {
    config.oauth.allowedProfiles = ["TESTUSER"];
    expect(await signOn(manager(), { profile: "my pass!" })).toEqual({
      ok: false,
      reason: "profile_not_allowed",
    });
    expect(lines.filter((line) => /my pass/i.test(line))).toEqual([]);
  });

  it("applies the profile filter before the equal-fields refusal", async () => {
    const grants = manager();
    expect(
      await signOn(grants, { profile: "quser", password: "QUSER" }),
    ).toEqual({ ok: false, reason: "profile_not_allowed" });
    config.oauth.allowedProfiles = ["OTHERUSR"];
    expect(await signOn(grants)).toEqual({
      ok: false,
      reason: "profile_not_allowed",
    });
    expect(fake.upgrades).toBe(0);
  });

  it("refuses a password equal to the profile before asking the throttle", async () => {
    const grants = manager();
    await signOn(grants, { password: WRONG_PASSWORD });
    await signOn(grants, { password: WRONG_PASSWORD });
    expect(await signOn(grants)).toEqual({ ok: false, reason: "blocked" });
    expect(await signOn(grants, { password: "TestUser" })).toEqual({
      ok: false,
      reason: "password_is_profile",
    });
  });

  it("asks the throttle before judging the password's shape", async () => {
    const grants = manager();
    const unusable = "semi;colon-Pw";
    secrets.push(unusable);
    expect(await signOn(grants, { password: unusable })).toEqual({
      ok: false,
      reason: "password_syntax",
    });
    expect(fake.upgrades).toBe(0);
    // The refusal gave the profile's sign-on slot back.
    await signOn(grants, { password: WRONG_PASSWORD });
    await signOn(grants, { password: WRONG_PASSWORD });
    expect(await signOn(grants, { password: unusable })).toEqual({
      ok: false,
      reason: "blocked",
    });
    expect(fake.signOns("TESTUSER")).toBe(2);
  });

  it("answers unavailable, and frees the profile's slot, when the client fails unexpectedly", async () => {
    const real = clientFor();
    let signOns = 0;
    const grants = manager({
      ...real,
      signOn: (...args) =>
        ++signOns === 1
          ? Promise.reject(new Error("unexpected"))
          : real.signOn(...args),
    });
    const password = Buffer.from(FAKE_PASSWORD);
    const result = await grants.signOn({
      profile: Buffer.from("testuser"),
      password,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT,
      codeChallenge: CHALLENGE,
      address: ADDRESS,
    });
    expect(result).toEqual({ ok: false, reason: "unavailable" });
    expect(allZero(password)).toBe(true);
    expect((await signOn(grants)).ok).toBe(true);
  });

  it("lets one sign-on per profile be in flight", async () => {
    const grants = manager();
    const [first, second] = await Promise.all([signOn(grants), signOn(grants)]);
    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, reason: "busy" });
    expect(fake.signOns("TESTUSER")).toBe(1);
  });

  it.each([
    ["a colon", "colon:Pw-123"],
    ["a colon at the end", "colon-Pw-123:"],
    ["a percent sign", "percent%%Pw-123"],
    ["an asterisk at the start", "*CURRENT"],
  ])(
    "forwards no password with %s, and counts nothing",
    async (_rule, password) => {
      secrets.push(password);
      // An account with that password: only the check stops the sign-on.
      fake.accounts.TESTUSER = password;
      const grants = manager();
      for (let attempt = 0; attempt < 3; attempt++) {
        expect(await signOn(grants, { password })).toEqual({
          ok: false,
          reason: "password_syntax",
        });
      }
      await settle();
      expect(fake.upgrades).toBe(0);
      expect(grants.status().blockedProfiles).toBe(0);
      expect(logged("signon_refused_syntax")).toHaveLength(3);
    },
  );

  it("forwards no profile that starts with a digit, and counts nothing", async () => {
    fake.accounts["1TESTUSER"] = FAKE_PASSWORD;
    const grants = manager();
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(await signOn(grants, { profile: "1testuser" })).toEqual({
        ok: false,
        reason: "profile_syntax",
      });
    }
    await settle();
    expect(fake.upgrades).toBe(0);
    expect(grants.status().blockedProfiles).toBe(0);
    expect(lines.filter((line) => /1testuser/i.test(line))).toEqual([]);
  });

  it("signs on to a server that answers 404 to everything but the upgrade, and asks it for no version", async () => {
    const grants = manager();
    grants.start();
    const { refreshToken } = await grant(grants);
    tokens(await refresh(grants, refreshToken));
    expect(fake.httpRequests).toBe(0);
    expect(
      fake.requests.filter(
        ({ type }) => type !== "sql" && type !== "prepare_sql_execute",
      ),
    ).toEqual([]);
  });
});

describe("sign-on outcomes and what they count", () => {
  it.each<[SignOnBehaviour, string]>([
    ["security_rule", "not_permitted"],
    ["invalid_password", "not_permitted"],
    ["not_connected", "not_permitted"],
    ["expired", "password_expired"],
    ["disabled", "profile_disabled"],
  ])("does not count a %s answer", async (behaviour, reason) => {
    fake.signOn.TESTUSER = behaviour;
    const grants = manager();
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(await signOn(grants)).toEqual({ ok: false, reason });
    }
    expect(fake.signOns("TESTUSER")).toBe(3);
    expect(grants.status()).toMatchObject({ grants: 0, blockedProfiles: 0 });
    await until(() => fake.openSockets === 0);
  });

  it("does not count a connection that never opened", async () => {
    fakeTimers();
    fake.signOn.TESTUSER = "no_upgrade";
    const grants = manager();
    for (let attempt = 1; attempt <= 3; attempt++) {
      const result = signOn(grants);
      await until(() => fake.upgrades === attempt);
      await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS);
      expect(await result).toEqual({ ok: false, reason: "unavailable" });
    }
    expect(fake.signOns("TESTUSER")).toBe(0);
    delete fake.signOn.TESTUSER;
    expect((await signOn(grants)).ok).toBe(true);
  });

  it("forwards at most OAUTH_SIGNON_MAX_FAILURES rejected sign-ons until the profile is unblocked", async () => {
    const grants = manager();
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await signOn(grants, { password: WRONG_PASSWORD })).toEqual({
        ok: false,
        reason: "rejected",
      });
    }
    // Blocked whatever is typed, and nothing more reaches the IBM i.
    expect(await signOn(grants)).toEqual({ ok: false, reason: "blocked" });
    expect(await signOn(grants, { password: WRONG_PASSWORD })).toEqual({
      ok: false,
      reason: "blocked",
    });
    expect(fake.signOns("TESTUSER")).toBe(2);
    expect(grants.status().blockedProfiles).toBe(1);
    expect(logged("signon_rejected")).toHaveLength(2);
    expect(logged("signon_blocked")).toHaveLength(2);
    // Another profile is not affected.
    expect((await signOn(grants, { profile: "otherusr" })).ok).toBe(true);

    expect(grants.unblock("testuser")).toBe(true);
    expect(grants.unblock("testuser")).toBe(false);
    expect(logged("profile_unblocked")).toHaveLength(1);
    expect((await signOn(grants)).ok).toBe(true);
    expect(grants.status().blockedProfiles).toBe(0);
  });

  it.each([
    // What mapepire-server 2.3.2 returned on a real system, with a made-up profile.
    ["the host servers' form", "(Password is incorrect.:TESTUSER)"],
    [
      "the native sign-on's form",
      "(Password is incorrect.:USER:TESTUSER CPF22E2)",
    ],
  ])(
    "counts a rejection in %s against the hard budget",
    async (_form, detail) => {
      fake.signOn.TESTUSER = {
        reply: {
          success: false,
          error: `java.sql.SQLNonTransientConnectionException: The application server rejected the connection. ${detail}`,
        },
      };
      const grants = manager();
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(await signOn(grants)).toEqual({ ok: false, reason: "rejected" });
      }
      expect(await signOn(grants)).toEqual({ ok: false, reason: "blocked" });
      expect(fake.signOns("TESTUSER")).toBe(2);
      expect(grants.status().blockedProfiles).toBe(1);
      // Nothing Mapepire answered is logged.
      expect(lines.filter((line) => line.includes("rejected the"))).toEqual([]);
    },
  );

  it("clears the rejected count on a success", async () => {
    const grants = manager();
    await signOn(grants, { password: WRONG_PASSWORD });
    expect((await signOn(grants)).ok).toBe(true);
    await signOn(grants, { password: WRONG_PASSWORD });
    expect((await signOn(grants)).ok).toBe(true);
    expect(fake.signOns("TESTUSER")).toBe(4);
  });

  it.each<SignOnBehaviour>(["unknown_error", "close"])(
    "pauses a profile after two %s answers, for 30 minutes",
    async (behaviour) => {
      fake.signOn.TESTUSER = behaviour;
      const grants = manager();
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(await signOn(grants)).toEqual({
          ok: false,
          reason: "unavailable",
        });
      }
      expect(await signOn(grants)).toEqual({ ok: false, reason: "paused" });
      expect(fake.signOns("TESTUSER")).toBe(2);
      expect(grants.status().blockedProfiles).toBe(0);

      delete fake.signOn.TESTUSER;
      clock += SOFT_BUDGET.pauseMs;
      expect((await signOn(grants)).ok).toBe(true);
    },
  );

  it("treats a connect that is never answered as unavailable and counts it softly", async () => {
    fakeTimers();
    fake.signOn.TESTUSER = "no_reply";
    const grants = manager();
    for (let attempt = 1; attempt <= 2; attempt++) {
      const result = signOn(grants);
      await until(() => fake.signOns("TESTUSER") === attempt);
      await vi.advanceTimersByTimeAsync(CONNECT_REPLY_TIMEOUT_MS);
      expect(await result).toEqual({ ok: false, reason: "unavailable" });
    }
    expect(logged("signon_timeout")).toHaveLength(2);
    expect(await signOn(grants)).toEqual({ ok: false, reason: "paused" });
    expect(fake.signOns("TESTUSER")).toBe(2);
  });
});

describe("sign-ons whose result is not known", () => {
  /** Submits the form; when the sign-on is forwarded, lets its connect go unanswered. */
  async function unansweredSignOn(grants: GrantManager) {
    const forwarded = fake.signOns("TESTUSER");
    let result: Awaited<ReturnType<typeof signOn>> | undefined;
    const pending = signOn(grants, { password: WRONG_PASSWORD }).then(
      (answer) => (result = answer),
    );
    await until(
      () => result !== undefined || fake.signOns("TESTUSER") > forwarded,
    );
    if (result === undefined) {
      await vi.advanceTimersByTimeAsync(CONNECT_REPLY_TIMEOUT_MS);
    }
    return pending;
  }

  it("forwards at most twice OAUTH_SIGNON_MAX_FAILURES of them, however long the wait between, until the profile is unblocked", async () => {
    fakeTimers();
    fake.signOn.TESTUSER = "no_reply";
    const grants = manager();
    const reasons: unknown[] = [];

    // Three submissions every 31 minutes, for two hours.
    for (let round = 0; round < 4; round++) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const result = await unansweredSignOn(grants);
        reasons.push(result.ok || result.reason);
      }
      clock += SOFT_BUDGET.pauseMs + MINUTE;
    }

    expect(reasons).toEqual([
      "unavailable",
      "unavailable",
      "paused",
      "unavailable",
      "unavailable",
      ...Array.from({ length: 7 }, () => "blocked"),
    ]);
    expect(fake.signOns("TESTUSER")).toBe(4);
    expect(grants.status().blockedProfiles).toBe(1);

    delete fake.signOn.TESTUSER;
    expect(grants.unblock("TESTUSER")).toBe(true);
    expect((await signOn(grants)).ok).toBe(true);
    expect(grants.status().blockedProfiles).toBe(0);
  });

  it("honours OAUTH_SIGNON_MAX_FAILURES=1: two of them block", async () => {
    fakeTimers();
    config.oauth.signOnMaxFailures = 1;
    fake.signOn.TESTUSER = "unknown_error";
    const grants = manager();

    expect(await signOn(grants)).toEqual({ ok: false, reason: "unavailable" });
    expect(await signOn(grants)).toEqual({ ok: false, reason: "unavailable" });
    clock += SOFT_BUDGET.pauseMs;

    expect(await signOn(grants)).toEqual({ ok: false, reason: "blocked" });
    expect(fake.signOns("TESTUSER")).toBe(2);
  });
});

describe("privileged profiles", () => {
  it.each(["*ALLOBJ", "*SECADM *JOBCTL", "*JOBCTL *ALLOBJ *SAVSYS"])(
    "refuses a profile holding %s and closes its job",
    async (authorities) => {
      profileRow({ SPECIAL_AUTHORITIES: authorities });
      const grants = manager();
      expect(await signOn(grants)).toEqual({ ok: false, reason: "privileged" });
      await until(() => fake.openSockets === 0);
      expect(grants.status().grants).toBe(0);
      expect(logged("signon_refused_privileged")).toHaveLength(1);
    },
  );

  it.each([
    ["fails", { error: "SQL0551 Not authorized", sqlState: "42501" }],
    ["returns no row", { rows: [] }],
  ])("refuses a profile whose row read %s", async (_case, reply) => {
    fake.statements = [{ match: "USER_INFO_BASIC", reply }];
    const grants = manager();
    expect(await signOn(grants)).toEqual({ ok: false, reason: "privileged" });
    await until(() => fake.openSockets === 0);
  });

  it("lets them sign on with OAUTH_ALLOW_PRIVILEGED_PROFILES", async () => {
    config.oauth.allowPrivilegedProfiles = true;
    const grants = manager();
    profileRow({ SPECIAL_AUTHORITIES: "*ALLOBJ *SECADM" });
    expect((await signOn(grants)).ok).toBe(true);
    fake.statements = [{ match: "USER_INFO_BASIC", reply: { rows: [] } }];
    expect((await signOn(grants)).ok).toBe(true);
  });

  it("lets a profile with other special authorities sign on", async () => {
    profileRow({ SPECIAL_AUTHORITIES: "*JOBCTL *SPLCTL" });
    expect((await signOn(manager())).ok).toBe(true);
  });
});

describe("code exchange", () => {
  it.each<[string, Partial<CodeExchangeRequest>]>([
    ["verifier", { codeVerifier: "another-verifier-".repeat(3) }],
    ["client", { clientId: "https://other.example/client.json" }],
    ["redirect URI", { redirectUri: "http://127.0.0.1:33418/other" }],
  ])("refuses another %s and leaves the code usable", async (_what, fields) => {
    const grants = manager();
    const { code } = await signOnCode(grants);
    expect(await exchange(grants, code, fields)).toEqual({
      ok: false,
      error: "invalid_grant",
    });
    expect((await exchange(grants, code)).ok).toBe(true);
  });

  it("refuses a verifier that is not one, even when it hashes to the challenge", async () => {
    const codeVerifier = "too-short";
    const grants = manager();
    const { code } = await signOnCode(grants, {
      codeChallenge: createHash("sha256")
        .update(codeVerifier)
        .digest("base64url"),
    });
    expect(await exchange(grants, code, { codeVerifier })).toEqual({
      ok: false,
      error: "invalid_grant",
    });
  });

  it("exchanges a code without a redirect URI, as a client that follows OAuth 2.1 sends it", async () => {
    const grants = manager();
    const { code, grantId } = await signOnCode(grants);

    const { accessToken } = tokens(
      await exchange(grants, code, { redirectUri: undefined }),
    );

    expect(await grants.authenticate(accessToken)).toMatchObject({ grantId });
  });

  it("still checks PKCE, the client and the address of a code that comes without a redirect URI", async () => {
    const grants = manager();
    const { code } = await signOnCode(grants);
    const without = { redirectUri: undefined };

    for (const wrong of [
      { codeVerifier: "another-verifier-".repeat(3) },
      { clientId: "https://other.example/client.json" },
    ]) {
      expect(await exchange(grants, code, { ...without, ...wrong })).toEqual({
        ok: false,
        error: "invalid_grant",
      });
    }
    expect(grants.status().grants).toBe(1);
    expect(
      await exchange(grants, code, { ...without, address: "10.9.9.9" }),
    ).toEqual({ ok: false, error: "invalid_grant" });
    expect(grants.status().grants).toBe(0);
  });

  it("refuses a code it never issued", async () => {
    const grants = manager();
    await signOnCode(grants);
    expect(await exchange(grants, "A".repeat(43))).toEqual({
      ok: false,
      error: "invalid_grant",
    });
    expect(grants.status().grants).toBe(1);
  });

  it("ends the grant when a code is presented twice", async () => {
    const grants = manager();
    const { code, grantId } = await signOnCode(grants);
    const { accessToken } = tokens(await exchange(grants, code));
    expect(await exchange(grants, code)).toEqual({
      ok: false,
      error: "invalid_grant",
    });
    expect(await grants.authenticate(accessToken)).toBe("invalid_token");
    await until(() => fake.openSockets === 0);
    expect(logged("grant_ended")).toEqual([
      expect.objectContaining({ grantId, reason: "code_replay" }),
    ]);
  });

  it("refuses a code after 60 seconds, then closes the job and deletes the grant", async () => {
    fakeTimers();
    const grants = manager();
    grants.start();
    const { code, grantId } = await signOnCode(grants);
    clock += 60_000;
    expect(await exchange(grants, code)).toEqual({
      ok: false,
      error: "invalid_grant",
    });
    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);
    await until(() => fake.openSockets === 0);
    expect(grants.status().grants).toBe(0);
    expect(logged("grant_ended")).toEqual([
      expect.objectContaining({ grantId, reason: "code_expired" }),
    ]);
  });

  it("strict binding: a loopback code from another address is burned and its grant ended", async () => {
    const grants = manager();
    const { code, grantId } = await signOnCode(grants);
    expect(await exchange(grants, code, { address: "10.9.9.9" })).toEqual({
      ok: false,
      error: "invalid_grant",
    });
    expect(await exchange(grants, code)).toEqual({
      ok: false,
      error: "invalid_grant",
    });
    await until(() => fake.openSockets === 0);
    expect(grants.status().grants).toBe(0);
    expect(logged("signon_source_mismatch")).toEqual([
      expect.objectContaining({
        grantId,
        address: "10.9.9.9",
        signOnAddress: ADDRESS,
      }),
    ]);
    expect(logged("grant_ended")).toEqual([
      expect.objectContaining({ reason: "signon_source_mismatch" }),
    ]);
  });

  it("audit binding: the mismatch is logged and the exchange proceeds", async () => {
    config.oauth.codeAddressBinding = "audit";
    const grants = manager();
    const { code, grantId } = await signOnCode(grants);
    const answer = await exchange(grants, code, { address: "10.9.9.9" });
    expect(await grants.authenticate(tokens(answer).accessToken)).toMatchObject(
      { grantId },
    );
    expect(logged("signon_source_mismatch")).toHaveLength(1);
  });

  it("compares all loopback addresses as equal", async () => {
    const grants = manager();
    const { code } = await signOnCode(grants, { address: "127.0.0.1" });
    expect((await exchange(grants, code, { address: "::1" })).ok).toBe(true);
    expect(logged("signon_source_mismatch")).toEqual([]);
  });

  it("does not bind a redirect that is not loopback", async () => {
    const redirectUri = "https://app.example/oauth/callback";
    const grants = manager();
    const { code } = await signOnCode(grants, { redirectUri });
    const answer = await exchange(grants, code, {
      redirectUri,
      address: "10.9.9.9",
    });
    expect(answer.ok).toBe(true);
    tokens(answer);
  });
});

describe("refresh", () => {
  it("returns the same pair to a replayed refresh token, three times", async () => {
    const grants = manager();
    const { refreshToken } = await grant(grants);
    const rotated = tokens(await refresh(grants, refreshToken));
    for (let replay = 0; replay < 3; replay++) {
      expect(tokens(await refresh(grants, refreshToken))).toEqual(rotated);
    }
    expect(await refresh(grants, refreshToken)).toEqual({
      ok: false,
      error: "invalid_grant",
    });
    expect(logged("refresh_replayed")).toHaveLength(3);
    // The grant is kept.
    expect(await grants.authenticate(rotated.accessToken)).toMatchObject({
      profile: "TESTUSER",
    });
  });

  it("ends the grant when a retired refresh token is presented", async () => {
    const grants = manager();
    const { grantId, refreshToken } = await grant(grants);
    const second = tokens(await refresh(grants, refreshToken));
    const third = tokens(await refresh(grants, second.refreshToken));
    expect(await refresh(grants, refreshToken)).toEqual({
      ok: false,
      error: "invalid_grant",
    });
    expect(await grants.authenticate(third.accessToken)).toBe("invalid_token");
    expect(await refresh(grants, third.refreshToken)).toEqual({
      ok: false,
      error: "invalid_grant",
    });
    await until(() => fake.openSockets === 0);
    expect(logged("grant_ended")).toEqual([
      expect.objectContaining({ grantId, reason: "refresh_reuse" }),
    ]);
  });

  it("retires the previous refresh token 60 seconds after its successor access token is used", async () => {
    const grants = manager();
    const { refreshToken } = await grant(grants);
    const rotated = tokens(await refresh(grants, refreshToken));
    await grants.authenticate(rotated.accessToken);
    clock += 60_000;
    expect(await refresh(grants, refreshToken)).toEqual({
      ok: false,
      error: "invalid_grant",
    });
    expect(grants.status().grants).toBe(0);
  });

  it("answers the thirteenth rotation of a grant in five minutes with rate_limited", async () => {
    const grants = manager();
    let { refreshToken } = await grant(grants);
    for (let rotation = 0; rotation < 12; rotation++) {
      ({ refreshToken } = tokens(await refresh(grants, refreshToken)));
    }
    expect(await refresh(grants, refreshToken)).toEqual({
      ok: false,
      error: "rate_limited",
    });
    clock += 5 * MINUTE;
    expect((await refresh(grants, refreshToken)).ok).toBe(true);
  });

  it("refuses another client's refresh and keeps the token", async () => {
    const grants = manager();
    const { refreshToken } = await grant(grants);
    expect(
      await refresh(grants, refreshToken, {
        clientId: "https://other.example/client.json",
      }),
    ).toEqual({ ok: false, error: "invalid_grant" });
    expect((await refresh(grants, refreshToken)).ok).toBe(true);
  });

  it("lets a refresh token live to the grant's absolute expiry, then ends the grant", async () => {
    fakeTimers();
    const grants = manager();
    const { grantId, refreshToken } = await idleGrant(grants);
    clock += 12 * HOUR - 10 * MINUTE - 1;
    const late = tokens(await refresh(grants, refreshToken));
    expect(await grants.authenticate(late.accessToken)).toMatchObject({
      grantId,
    });

    await sweepAfter(1);
    await until(() => fake.openSockets === 0);
    expect(await refresh(grants, late.refreshToken)).toEqual({
      ok: false,
      error: "invalid_grant",
    });
    expect(logged("grant_ended")).toEqual([
      expect.objectContaining({ grantId, reason: "expired" }),
    ]);
  });
});

describe("the profile's row at refresh (connection open)", () => {
  it("re-reads it and keeps the grant when nothing changed", async () => {
    const grants = manager();
    const { grantId, refreshToken } = await grant(grants);
    tokens(await refresh(grants, refreshToken));
    await until(
      () =>
        fake.requests.filter((request) =>
          String(request.sql).includes("USER_INFO_BASIC"),
        ).length === 2,
    );
    await settle();
    expect(grants.describeGrants()).toEqual([
      expect.objectContaining({ grantId }),
    ]);
  });

  it("ends the grant when the profile is no longer enabled", async () => {
    const grants = manager();
    const { grantId, refreshToken } = await grant(grants);
    profileRow({ STATUS: "*DISABLED" });
    const answer = await refresh(grants, refreshToken);
    const { accessToken } = tokens(answer);
    await until(() => grants.status().grants === 0);
    expect(await grants.authenticate(accessToken)).toBe("invalid_token");
    await until(() => fake.openSockets === 0);
    expect(logged("grant_ended")).toEqual([
      expect.objectContaining({ grantId, reason: "profile_disabled" }),
    ]);
  });

  it("ends every grant of the profile when its password changed, with no sign-on attempt", async () => {
    const grants = manager();
    const one = await grant(grants);
    await grant(grants);
    await grant(grants, { profile: "otherusr" });
    profileRow({ PASSWORD_CHANGE_DATE: "2026-11-10 09:30:00.000000" });
    tokens(await refresh(grants, one.refreshToken));
    await until(() => grants.status().grants === 1);
    expect(grants.describeGrants()).toEqual([
      expect.objectContaining({ profile: "OTHERUSR" }),
    ]);
    expect(logged("grant_ended").map((entry) => entry.reason)).toEqual([
      "profile_changed",
      "profile_changed",
    ]);
    expect(fake.connects).toHaveLength(3);
  });

  it("keeps the grant when the row cannot be read", async () => {
    const grants = manager();
    const { refreshToken } = await grant(grants);
    fake.statements = [
      { match: "USER_INFO_BASIC", reply: { error: "SQL0551 Not authorized" } },
    ];
    tokens(await refresh(grants, refreshToken));
    await until(() => fake.requests.length === 2);
    await settle();
    expect(grants.status()).toMatchObject({ grants: 1, openConnections: 1 });
  });
});

describe("idle close and reconnect", () => {
  it("closes the connection after OAUTH_IDLE_CLOSE_MINUTES without a request, not before", async () => {
    fakeTimers();
    const grants = manager();
    grants.start();
    const { accessToken } = await grant(grants);
    await sweepAfter(9 * MINUTE);
    await grants.authenticate(accessToken);
    await sweepAfter(5 * MINUTE);
    await settle();
    // 14 minutes after sign-on, 5 after the last request.
    expect(grants.status().openConnections).toBe(1);
    await sweepAfter(5 * MINUTE);
    await until(() => fake.openSockets === 0);
    expect(grants.status()).toMatchObject({ grants: 1, openConnections: 0 });
  });

  it("counts a statement as use, and closes no connection while one runs", async () => {
    fakeTimers();
    fake.statements.push({ match: "SLOW", reply: "no_reply" });
    const grants = manager();
    grants.start();
    const { grantId } = await grant(grants);
    await sweepAfter(9 * MINUTE);
    await grants.executeQuery(grantId, "VALUES 1");
    await sweepAfter(5 * MINUTE);
    await settle();
    expect(grants.status().openConnections).toBe(1);

    const running = rejection(grants.executeQuery(grantId, "CALL SLOW()"));
    await until(() => fake.requests.at(-1)?.sql === "CALL SLOW()");
    await sweepAfter(10 * MINUTE);
    await settle();
    expect(grants.status().openConnections).toBe(1);
    fake.drop();
    await running;
  });

  it("does not count a refresh, or the profile row it reads, as use of the connection", async () => {
    fakeTimers();
    const grants = manager();
    grants.start();
    const { refreshToken } = await grant(grants);
    const rowsRead = () =>
      fake.requests.filter((request) =>
        String(request.sql).includes("USER_INFO_BASIC"),
      ).length;

    // A client that refreshes by the clock and sends no request.
    await sweepAfter(9 * MINUTE);
    tokens(await refresh(grants, refreshToken));
    await until(() => rowsRead() === 2);
    await settle();
    expect(grants.status().openConnections).toBe(1);

    await sweepAfter(MINUTE);
    expect(grants.status().openConnections).toBe(0);
    await until(() => fake.openSockets === 0);
    expect(fake.signOns("TESTUSER")).toBe(1);
  });

  it("gives a connection reopened by a refresh a whole idle period", async () => {
    fakeTimers();
    const grants = manager();
    const { refreshToken } = await idleGrant(grants);
    tokens(await refresh(grants, refreshToken));
    await until(() => grants.status().openConnections === 1);

    // The next sweep, with no request in between.
    await sweepAfter(0);
    await settle();
    expect(grants.status().openConnections).toBe(1);
    await sweepAfter(10 * MINUTE - 1);
    await settle();
    expect(grants.status().openConnections).toBe(1);

    await sweepAfter(1);
    expect(grants.status().openConnections).toBe(0);
    expect(fake.signOns("TESTUSER")).toBe(2);
  });

  it("reconnects to a new job inside a refresh, and queries run again", async () => {
    fakeTimers();
    fake.statements.push({ match: "SYSDUMMY1", reply: { rows: [{ ONE: 1 }] } });
    const grants = manager();
    const { grantId, accessToken, refreshToken } = await idleGrant(grants);
    const firstJob = fake.connects[0]!.job;
    await until(() => fake.openSockets === 0);
    expect(fake.requests.at(-1)).toMatchObject({ type: "exit" });
    expect(logged("connection_closed")).toEqual([
      expect.objectContaining({ grantId, job: firstJob, reason: "idle" }),
    ]);
    expect(await grants.authenticate(accessToken)).toBe("connection_closed");
    await expect(
      grants.executeQuery(grantId, "VALUES 1"),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.Unauthorized });
    expect(grants.status()).toMatchObject({ grants: 1, openConnections: 0 });

    // The token answer does not wait for the connection; the next request does.
    const next = tokens(await refresh(grants, refreshToken));
    expect(grants.status().openConnections).toBe(0);
    expect(await grants.authenticate(next.accessToken)).toMatchObject({
      profile: "TESTUSER",
      grantId,
    });
    expect(fake.connects).toHaveLength(2);
    expect(fake.connects[1]).toMatchObject({
      profile: "TESTUSER",
      passwordMatched: true,
      application: `ibmi-mcp/${grantId}`,
    });
    const secondJob = fake.connects[1]!.job;
    expect(secondJob).not.toBe(firstJob);
    expect(grants.describeGrants()[0]!.jobName).toBe(secondJob);
    expect(logged("reconnect_ok")).toEqual([
      expect.objectContaining({ grantId, job: secondJob }),
    ]);
    const result = await grants.executeQuery(
      grantId,
      "SELECT 1 AS ONE FROM SYSIBM.SYSDUMMY1",
    );
    expect(result.data).toEqual([{ ONE: 1 }]);

    // The grant key and the password existed only for the connect.
    expect(results(unseal)).toHaveLength(1);
    expect(results(unseal).every(allZero)).toBe(true);
    expect(results(unwrapKey).every(allZero)).toBe(true);

    // The new connection is followed like the first.
    fake.drop();
    await until(() =>
      logged("connection_closed").some(
        (entry) => entry.reason === "lost" && entry.job === secondJob,
      ),
    );
    expect(grants.status()).toMatchObject({ grants: 1, openConnections: 0 });
  });

  it("closes the job of a reconnect whose grant ended meanwhile", async () => {
    fakeTimers();
    const grants = manager();
    const { grantId, refreshToken } = await idleGrant(grants);
    tokens(await refresh(grants, refreshToken));
    expect(await grants.revokeByAdmin(grantId)).toBe(1);
    await until(() => fake.connects.length === 2);
    await until(() => fake.openSockets === 0);
    expect(grants.status()).toMatchObject({ grants: 0, openConnections: 0 });
  });

  it("shares one reconnect between the requests that found the connection closed", async () => {
    fakeTimers();
    const grants = manager();
    const { grantId, accessToken, refreshToken } = await idleGrant(grants);
    const answers = await Promise.all([
      refresh(grants, refreshToken),
      refresh(grants, refreshToken),
      refresh(grants, refreshToken),
    ]);
    const [first, second, third] = answers.map(tokens);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    const identities = await Promise.all([
      grants.authenticate(first!.accessToken),
      grants.authenticate(first!.accessToken),
      grants.authenticate(accessToken),
    ]);
    for (const identity of identities) {
      expect(identity).toMatchObject({ grantId });
    }
    await settle();
    expect(fake.connects).toHaveLength(2);
    expect(fake.upgrades).toBe(2);
    expect(logged("refresh_replayed")).toHaveLength(2);
    // The password was decrypted once.
    expect(results(unseal)).toHaveLength(1);
  });

  it("makes a request wait at most 25 seconds for a reconnect in flight", async () => {
    fakeTimers();
    const real = clientFor();
    let signOns = 0;
    let abort: (() => void) | undefined;
    const grants = manager({
      // The reconnect does not settle before the manager is shut down.
      signOn: (...args) =>
        ++signOns === 1
          ? real.signOn(...args)
          : new Promise((resolve) => {
              abort = () => resolve({ class: "pre" });
            }),
      abort: () => abort?.(),
    });
    const { refreshToken } = await idleGrant(grants);
    const next = tokens(await refresh(grants, refreshToken));
    let answer: unknown;
    void grants.authenticate(next.accessToken).then((result) => {
      answer = result;
    });
    await until(() => signOns === 2);
    await vi.advanceTimersByTimeAsync(RECONNECT_WAIT_MS - 1);
    expect(answer).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(answer).toBe("connection_closed");
  });

  it("runs a reconnect outside the async context of the refresh that started it", async () => {
    fakeTimers();
    const context = new AsyncLocalStorage<string>();
    const real = clientFor();
    const contexts: unknown[] = [];
    const grants = manager({
      ...real,
      signOn(...args) {
        contexts.push(context.getStore());
        return real.signOn(...args);
      },
    });
    const { grantId, refreshToken } = await context.run("sign-on request", () =>
      idleGrant(grants),
    );
    const next = tokens(
      await context.run("refresh request", () => refresh(grants, refreshToken)),
    );
    expect(await grants.authenticate(next.accessToken)).toMatchObject({
      grantId,
    });
    expect(contexts).toEqual(["sign-on request", undefined]);
  });

  it("reconnects after the connection was lost, keeping the grant", async () => {
    const grants = manager();
    const { grantId, accessToken, refreshToken } = await grant(grants);
    fake.drop();
    await until(() => logged("connection_closed").length === 1);
    expect(logged("connection_closed")[0]).toMatchObject({
      grantId,
      reason: "lost",
    });
    expect(await grants.authenticate(accessToken)).toBe("connection_closed");
    const next = tokens(await refresh(grants, refreshToken));
    expect(await grants.authenticate(next.accessToken)).toMatchObject({
      grantId,
    });
    expect(fake.connects).toHaveLength(2);
  });
});

describe("reconnect outcomes", () => {
  /** A refresh whose reconnect the fake answers as `behaviour`. */
  async function failedReconnect(
    grants: GrantManager,
    refreshToken: string,
    behaviour: SignOnBehaviour,
  ) {
    fake.signOn.TESTUSER = behaviour;
    // An upgrade that is never answered has no connect request to wait for.
    const reached = () =>
      behaviour === "no_upgrade" ? fake.upgrades : fake.connects.length;
    const before = reached();
    const next = tokens(await refresh(grants, refreshToken));
    await until(() => reached() === before + 1);
    const request = grants.authenticate(next.accessToken);
    if (behaviour === "no_upgrade" || behaviour === "no_reply") {
      // Past the handshake and connect-reply timeouts, whichever applies.
      await vi.advanceTimersByTimeAsync(CONNECT_REPLY_TIMEOUT_MS);
    }
    return { ...next, answer: await request };
  }

  it("keeps the grant when no connection opened, and tries again no sooner than 15 seconds later", async () => {
    fakeTimers();
    const grants = manager();
    const { grantId, refreshToken } = await idleGrant(grants);
    const failed = await failedReconnect(grants, refreshToken, "no_upgrade");
    expect(failed.answer).toBe("connection_closed");
    expect(grants.status().grants).toBe(1);
    expect(logged("reconnect_unavailable")).toEqual([
      expect.objectContaining({ grantId, reason: "pre" }),
    ]);

    delete fake.signOn.TESTUSER;
    clock += RECONNECT_BACKOFF_MS.pre - 1;
    const early = tokens(await refresh(grants, failed.refreshToken));
    await settle();
    expect(fake.upgrades).toBe(2);
    expect(await grants.authenticate(early.accessToken)).toBe(
      "connection_closed",
    );

    clock += 1;
    const later = tokens(await refresh(grants, early.refreshToken));
    expect(await grants.authenticate(later.accessToken)).toMatchObject({
      grantId,
    });
    expect(fake.upgrades).toBe(3);
    expect(grants.status().blockedProfiles).toBe(0);
  });

  it("ends the grant after two unavailable or unanswered reconnects in a row, 60 seconds apart", async () => {
    fakeTimers();
    const grants = manager();
    const { grantId, refreshToken } = await idleGrant(grants);
    const first = await failedReconnect(grants, refreshToken, "no_reply");
    expect(first.answer).toBe("connection_closed");
    expect(grants.status().grants).toBe(1);

    clock += RECONNECT_BACKOFF_MS.other - 1;
    const early = tokens(await refresh(grants, first.refreshToken));
    await settle();
    expect(fake.upgrades).toBe(2);

    clock += 1;
    const second = await failedReconnect(
      grants,
      early.refreshToken,
      "unknown_error",
    );
    expect(second.answer).toBe("invalid_token");
    expect(grants.status().grants).toBe(0);
    expect(logged("grant_ended")).toEqual([
      expect.objectContaining({ grantId, reason: "reconnect_failed" }),
    ]);
  });

  it("starts the count again after a reconnect that worked", async () => {
    fakeTimers();
    const grants = manager();
    const { grantId, refreshToken } = await idleGrant(grants);
    const first = await failedReconnect(grants, refreshToken, "unknown_error");
    expect(first.answer).toBe("connection_closed");

    delete fake.signOn.TESTUSER;
    clock += RECONNECT_BACKOFF_MS.other;
    const worked = tokens(await refresh(grants, first.refreshToken));
    expect(await grants.authenticate(worked.accessToken)).toMatchObject({
      grantId,
    });

    await sweepAfter(10 * MINUTE);
    await until(() => grants.status().openConnections === 0);
    const again = await failedReconnect(
      grants,
      worked.refreshToken,
      "unknown_error",
    );
    expect(again.answer).toBe("connection_closed");
    expect(grants.status().grants).toBe(1);
  });

  it("ends the grant when Mapepire itself refuses, without counting", async () => {
    fakeTimers();
    const grants = manager();
    const { grantId, refreshToken } = await idleGrant(grants);
    const failed = await failedReconnect(grants, refreshToken, "security_rule");
    expect(failed.answer).toBe("invalid_token");
    expect(grants.status()).toMatchObject({ grants: 0, blockedProfiles: 0 });
    expect(logged("grant_ended")).toEqual([
      expect.objectContaining({ grantId, reason: "reconnect_not_permitted" }),
    ]);
    delete fake.signOn.TESTUSER;
    expect((await signOn(grants)).ok).toBe(true);
  });

  it("a stale password costs exactly one rejected sign-on and ends every grant of the profile", async () => {
    fakeTimers();
    const grants = manager();
    const one = await idleGrant(grants);
    const two = await grant(grants);
    const other = await grant(grants, { profile: "otherusr" });
    await sweepAfter(10 * MINUTE);
    await until(() => grants.status().openConnections === 0);

    fake.accounts.TESTUSER = CHANGED_PASSWORD;
    const next = tokens(await refresh(grants, one.refreshToken));
    expect(await grants.authenticate(next.accessToken)).toBe("invalid_token");
    expect(await refresh(grants, two.refreshToken)).toEqual({
      ok: false,
      error: "invalid_grant",
    });
    await settle();
    expect(rejectedAtFake()).toBe(1);
    expect(fake.signOns("TESTUSER")).toBe(3);
    expect(grants.describeGrants()).toEqual([
      expect.objectContaining({ grantId: other.grantId }),
    ]);
    expect(logged("reconnect_rejected")).toHaveLength(1);
    expect(logged("grant_ended").map((entry) => entry.reason)).toEqual([
      "reconnect_rejected",
      "reconnect_rejected",
    ]);
  });

  it("sends a stale password at most twice when its reconnects go unanswered, however many grants hold it", async () => {
    fakeTimers();
    const real = clientFor();
    let signOns = 0;
    const grants = manager({
      ...real,
      signOn(...args) {
        signOns++;
        return real.signOn(...args);
      },
    });
    grants.start();
    const clients = [];
    for (let i = 0; i < 5; i++) clients.push(await grant(grants));
    const other = await grant(grants, { profile: "otherusr" });
    await sweepAfter(10 * MINUTE);
    await until(() => grants.status().openConnections === 0);

    fake.accounts.TESTUSER = CHANGED_PASSWORD;
    fake.signOn.TESTUSER = "no_reply";
    // Every client refreshes every five minutes, for three hours.
    for (let step = 0; step < 36; step++) {
      clock += 5 * MINUTE;
      for (const client of clients) {
        const started = signOns;
        const answer = await refresh(grants, client.refreshToken);
        if (answer.ok) client.refreshToken = tokens(answer).refreshToken;
        if (signOns > started) {
          const unavailable = logged("reconnect_unavailable").length;
          await until(() => fake.connects.length === signOns);
          await vi.advanceTimersByTimeAsync(CONNECT_REPLY_TIMEOUT_MS);
          await until(
            () => logged("reconnect_unavailable").length > unavailable,
          );
        }
      }
    }

    expect(rejectedAtFake()).toBe(2);
    expect(grants.describeGrants()).toEqual([
      expect.objectContaining({ grantId: other.grantId }),
    ]);
    expect(logged("grant_ended").map((entry) => entry.reason)).toEqual(
      Array.from({ length: 5 }, () => "reconnect_failed"),
    );
    expect(grants.status().blockedProfiles).toBe(0);
  });

  it("a sign-on after a password change ends the profile's earlier grants: their stale password is never sent, and the new grant stays", async () => {
    fakeTimers();
    const grants = manager();
    const closed = await idleGrant(grants);
    const open = await grant(grants);
    const other = await grant(grants, { profile: "otherusr" });

    fake.accounts.TESTUSER = CHANGED_PASSWORD;
    profileRow({ PASSWORD_CHANGE_DATE: "2026-11-10 09:30:00.000000" });
    const fresh = await grant(grants, { password: CHANGED_PASSWORD });

    expect(logged("grant_ended")).toEqual([
      expect.objectContaining({
        grantId: closed.grantId,
        reason: "profile_changed",
      }),
      expect.objectContaining({
        grantId: open.grantId,
        reason: "profile_changed",
      }),
    ]);
    for (const earlier of [closed, open]) {
      expect(await refresh(grants, earlier.refreshToken)).toEqual({
        ok: false,
        error: "invalid_grant",
      });
    }
    // The new grant's own refresh re-reads the row and finds its own date.
    const rowsRead = fake.requests.length;
    const next = tokens(await refresh(grants, fresh.refreshToken));
    await until(() => fake.requests.length > rowsRead);
    await settle();
    expect(await grants.authenticate(next.accessToken)).toMatchObject({
      grantId: fresh.grantId,
    });
    expect(
      grants
        .describeGrants()
        .map((described) => described.grantId)
        .sort(),
    ).toEqual([fresh.grantId, other.grantId].sort());
    expect(rejectedAtFake()).toBe(0);
  });

  it("a rejected reconnect with the old password does not end a grant that sealed the new one", async () => {
    fakeTimers();
    const real = clientFor();
    let releaseRow!: () => void;
    const rowHeld = new Promise<void>((resolve) => (releaseRow = resolve));
    let answerReconnect!: (outcome: SignOnOutcome) => void;
    let signOns = 0;
    let readingRow = false;
    const grants = manager({
      ...real,
      async signOn(...args) {
        const number = ++signOns;
        if (number === 3) {
          // The reconnect of the earlier grant: answered below.
          return new Promise((resolve) => (answerReconnect = resolve));
        }
        const outcome = await real.signOn(...args);
        if (number === 2 && outcome.class === "ok") {
          // The new sign-on: its profile row is read when the test says so.
          const { session } = outcome;
          const execute = session.execute.bind(session);
          session.execute = (async (...query: Parameters<typeof execute>) => {
            readingRow = true;
            await rowHeld;
            return execute(...query);
          }) as typeof session.execute;
        }
        return outcome;
      },
    });
    const earlier = await idleGrant(grants);

    fake.accounts.TESTUSER = CHANGED_PASSWORD;
    profileRow({ PASSWORD_CHANGE_DATE: "2026-11-10 09:30:00.000000" });
    // The new sign-on is accepted and reads its row; meanwhile the earlier
    // grant's client refreshes, which sends the old password.
    const signingOn = signOnCode(grants, { password: CHANGED_PASSWORD });
    await until(() => readingRow);
    tokens(await refresh(grants, earlier.refreshToken));
    expect(signOns).toBe(3);
    releaseRow();
    const fresh = await signingOn;
    expect(logged("grant_ended")).toEqual([
      expect.objectContaining({
        grantId: earlier.grantId,
        reason: "profile_changed",
      }),
    ]);

    answerReconnect({ class: "rejected" });
    await until(() => logged("reconnect_rejected").length === 1);
    await settle();

    expect(grants.describeGrants()).toEqual([
      expect.objectContaining({ grantId: fresh.grantId }),
    ]);
    const { accessToken } = tokens(await exchange(grants, fresh.code));
    expect(await grants.authenticate(accessToken)).toMatchObject({
      grantId: fresh.grantId,
    });
  });

  it("counts rejected reconnects and rejected page sign-ons against one budget", async () => {
    fakeTimers();
    const grants = manager();
    const { refreshToken } = await idleGrant(grants);
    fake.accounts.TESTUSER = CHANGED_PASSWORD;
    const next = tokens(await refresh(grants, refreshToken));
    expect(await grants.authenticate(next.accessToken)).toBe("invalid_token");

    // One rejected reconnect, one rejected at the page: the budget of 2.
    expect(await signOn(grants)).toEqual({ ok: false, reason: "rejected" });
    expect(await signOn(grants, { password: CHANGED_PASSWORD })).toEqual({
      ok: false,
      reason: "blocked",
    });
    expect(rejectedAtFake()).toBe(2);
    expect(fake.signOns("TESTUSER")).toBe(3);

    expect(grants.unblock("TESTUSER")).toBe(true);
    expect((await signOn(grants, { password: CHANGED_PASSWORD })).ok).toBe(
      true,
    );
  });

  it("forwards no reconnect for a blocked profile, and keeps the grant", async () => {
    fakeTimers();
    const grants = manager();
    const { grantId, refreshToken } = await idleGrant(grants);
    await signOn(grants, { password: WRONG_PASSWORD });
    await signOn(grants, { password: WRONG_PASSWORD });
    expect(fake.signOns("TESTUSER")).toBe(3);

    const blocked = tokens(await refresh(grants, refreshToken));
    await settle();
    expect(fake.upgrades).toBe(3);
    expect(await grants.authenticate(blocked.accessToken)).toBe(
      "connection_closed",
    );
    expect(logged("reconnect_unavailable")).toEqual([
      expect.objectContaining({ grantId, reason: "blocked" }),
    ]);
    // The password decrypted for the attempt that was not made is gone.
    expect(results(unseal).every(allZero)).toBe(true);

    grants.unblock("TESTUSER");
    const next = tokens(await refresh(grants, blocked.refreshToken));
    expect(await grants.authenticate(next.accessToken)).toMatchObject({
      grantId,
    });
  });

  it("ends every grant of a profile that is disabled at reconnect, without counting", async () => {
    fakeTimers();
    const grants = manager();
    const { refreshToken } = await idleGrant(grants);
    await grant(grants);
    const failed = await failedReconnect(grants, refreshToken, "disabled");
    expect(failed.answer).toBe("invalid_token");
    expect(grants.status()).toMatchObject({ grants: 0, blockedProfiles: 0 });
  });

  it("treats a client that fails unexpectedly as unavailable", async () => {
    fakeTimers();
    const real = clientFor();
    let signOns = 0;
    const grants = manager({
      ...real,
      signOn: (...args) =>
        ++signOns === 1
          ? real.signOn(...args)
          : Promise.reject(new Error("unexpected")),
    });
    const { grantId, refreshToken } = await idleGrant(grants);
    const next = tokens(await refresh(grants, refreshToken));
    expect(await grants.authenticate(next.accessToken)).toBe(
      "connection_closed",
    );
    expect(logged("reconnect_unavailable")).toEqual([
      expect.objectContaining({ grantId, reason: "other" }),
    ]);
    expect(grants.status().grants).toBe(1);
  });

  it("starts no sign-on when the stored password does not open", async () => {
    fakeTimers();
    const grants = manager();
    const { grantId, refreshToken } = await idleGrant(grants);
    const sealed = vi.mocked(seal).mock.results[0]!.value as {
      ciphertext: Buffer;
    };
    sealed.ciphertext[0]! ^= 1;
    const next = tokens(await refresh(grants, refreshToken));
    expect(await grants.authenticate(next.accessToken)).toBe(
      "connection_closed",
    );
    await settle();
    expect(fake.upgrades).toBe(1);
    expect(logged("reconnect_unavailable")).toEqual([
      expect.objectContaining({ grantId, reason: "unsealing_failed" }),
    ]);
  });

  it("reconnects without asking Mapepire for anything but the upgrade", async () => {
    fakeTimers();
    const grants = manager();
    const { grantId, refreshToken } = await idleGrant(grants);
    const next = tokens(await refresh(grants, refreshToken));
    expect(await grants.authenticate(next.accessToken)).toMatchObject({
      grantId,
    });
    expect(fake.upgrades).toBe(2);
    expect(fake.httpRequests).toBe(0);
  });
});

describe("statements", () => {
  it("binds parameters and closes a cursor the one page left open", async () => {
    fake.statements.push({
      match: "FROM NUMBERS",
      reply: { rows: [{ N: 1 }, { N: 2 }, { N: 3 }, { N: 4 }, { N: 5 }] },
    });
    const grants = manager();
    const { grantId } = await grant(grants);
    const result = await grants.executeQuery(
      grantId,
      "SELECT N FROM NUMBERS WHERE N > ?",
      [0],
      undefined,
      2,
    );
    expect(result.data).toEqual([{ N: 1 }, { N: 2 }]);
    expect(fake.requests.slice(-2)).toMatchObject([
      { type: "prepare_sql_execute", parameters: [0], rows: 2 },
      { type: "sqlclose" },
    ]);
  });

  it("pages until the result is done", async () => {
    fake.statements.push({
      match: "FROM NUMBERS",
      reply: { rows: [{ N: 1 }, { N: 2 }, { N: 3 }, { N: 4 }] },
    });
    const grants = manager();
    const { grantId } = await grant(grants);
    const result = await grants.executeQueryWithPagination(
      grantId,
      "SELECT N FROM NUMBERS",
      undefined,
      undefined,
      3,
    );
    expect(result).toMatchObject({
      data: [{ N: 1 }, { N: 2 }, { N: 3 }, { N: 4 }],
      success: true,
      truncated: false,
      metadata: { column_count: 1 },
    });
    expect(fake.requests.slice(-2).map((request) => request.type)).toEqual([
      "sql",
      "sqlmore",
    ]);
  });

  it("stops at IBMI_PAGINATION_MAX_ROWS, flags the result and closes the cursor", async () => {
    fake.statements.push({
      match: "FROM NUMBERS",
      reply: { rows: Array.from({ length: 10 }, (_, n) => ({ N: n })) },
    });
    const grants = manager();
    const { grantId } = await grant(grants);
    const result = await grants.executeQueryWithPagination(
      grantId,
      "SELECT N FROM NUMBERS",
      undefined,
      undefined,
      3,
    );
    expect(result.truncated).toBe(true);
    expect(result.data).toEqual([{ N: 0 }, { N: 1 }, { N: 2 }, { N: 3 }]);
    expect(fake.requests.slice(-3).map((request) => request.type)).toEqual([
      "sql",
      "sqlmore",
      "sqlclose",
    ]);
  });

  it("reports a failed statement with the IBM i message and runs the next one", async () => {
    fake.statements.push({
      match: "NOSUCH",
      reply: { error: "[SQL0204] NOSUCH not found.", sqlState: "42704" },
    });
    const grants = manager();
    const { grantId } = await grant(grants);
    const error = await rejection(
      grants.executeQueryWithPagination(grantId, "SELECT * FROM NOSUCH"),
    );
    expect(error.code).toBe(JsonRpcErrorCode.DatabaseError);
    expect(error.message).toContain("SQL0204");
    expect((await grants.executeQuery(grantId, "VALUES 1")).success).toBe(true);
  });

  it("refuses a grant it does not hold", async () => {
    const error = await rejection(
      manager().executeQuery("no-such-grant", "VALUES 1"),
    );
    expect(error.code).toBe(JsonRpcErrorCode.Unauthorized);
  });

  it("runs one statement at a time per grant, with 8 waiting", async () => {
    fake.statements.push({ match: "SLOW", reply: "no_reply" });
    const grants = manager();
    const { grantId } = await grant(grants);
    const running = rejection(grants.executeQuery(grantId, "CALL SLOW()"));
    const waiting = Array.from({ length: STATEMENT_QUEUE_DEPTH }, (_, n) =>
      rejection(grants.executeQuery(grantId, `VALUES ${n}`)),
    );
    const refused = await rejection(grants.executeQuery(grantId, "VALUES 99"));
    expect(refused.code).toBe(JsonRpcErrorCode.RateLimited);

    await until(() => fake.requests.some((request) => request.type === "sql"));
    await settle();
    // Only the running statement was sent.
    expect(
      fake.requests.filter((request) => request.type === "sql"),
    ).toMatchObject([{ sql: "CALL SLOW()" }]);

    fake.drop();
    expect((await running).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    for (const queued of waiting) {
      expect((await queued).code).toBe(JsonRpcErrorCode.Unauthorized);
    }
  });

  it("abandons a statement that does not return, closes the socket and keeps the grant", async () => {
    fakeTimers();
    fake.statements.push({ match: "SLOW", reply: "no_reply" });
    const grants = manager();
    const { grantId, accessToken, refreshToken } = await grant(grants);
    const job = fake.connects[0]!.job!;
    const running = rejection(grants.executeQuery(grantId, "CALL SLOW()"));
    const queued = rejection(grants.executeQuery(grantId, "VALUES 1"));
    await until(() => fake.requests.some((request) => request.type === "sql"));
    await vi.advanceTimersByTimeAsync(STATEMENT_TIMEOUT_MS);

    const error = await running;
    // The statement behind it is refused, not sent on the closing socket.
    expect((await queued).code).toBe(JsonRpcErrorCode.Unauthorized);
    expect(error.code).toBe(JsonRpcErrorCode.Timeout);
    expect(error.message).toContain(`may still be running`);
    expect(error.message).toContain(job);
    await until(() => logged("statement_abandoned").length === 1);
    expect(logged("statement_abandoned")[0]).toMatchObject({ grantId, job });
    expect(logged("connection_closed")[0]).toMatchObject({
      reason: "abandoned",
    });
    expect(grants.status()).toMatchObject({ grants: 1, openConnections: 0 });
    expect(await grants.authenticate(accessToken)).toBe("connection_closed");

    const next = tokens(await refresh(grants, refreshToken));
    expect(await grants.authenticate(next.accessToken)).toMatchObject({
      grantId,
    });
    expect(grants.describeGrants()[0]!.jobName).not.toBe(job);
  });
});

describe("keep-alive", () => {
  it("starts one sweep timer, outside the caller's async context, that does not keep the process alive", async () => {
    const context = new AsyncLocalStorage<string>();
    const realSetInterval = setInterval;
    const created: Array<{ context: unknown; timer: NodeJS.Timeout }> = [];
    vi.spyOn(globalThis, "setInterval").mockImplementation(((
      ...args: Parameters<typeof setInterval>
    ) => {
      const timer = realSetInterval(...args);
      created.push({ context: context.getStore(), timer });
      return timer;
    }) as typeof setInterval);
    const grants = manager();
    context.run("request", () => grants.start());
    grants.start();
    expect(created).toHaveLength(1);
    expect(created[0]!.context).toBeUndefined();
    expect(created[0]!.timer.hasRef()).toBe(false);
  });

  it("closes the connection after three pings in a row without a pong, and keeps the grant", async () => {
    fakeTimers();
    const real = clientFor();
    const pongs = [false, false, true, false, false, false];
    const grants = manager({
      ...real,
      async signOn(...args) {
        const outcome = await real.signOn(...args);
        if (outcome.class === "ok") {
          outcome.session.ping = async () => pongs.shift() ?? true;
        }
        return outcome;
      },
    });
    grants.start();
    const { grantId } = await grant(grants);
    // One ping a minute.
    for (let minute = 1; minute <= 5; minute++) {
      await sweepAfter(MINUTE);
      expect(pongs).toHaveLength(6 - minute);
      // No second ping within the minute.
      await sweepAfter(MINUTE / 2 - 1);
      expect(pongs).toHaveLength(6 - minute);
      clock += 1 - MINUTE / 2;
    }
    await settle();
    expect(grants.status().openConnections).toBe(1);

    await sweepAfter(MINUTE);
    await until(() => fake.openSockets === 0);
    expect(grants.status()).toMatchObject({ grants: 1, openConnections: 0 });
    expect(logged("connection_closed")).toEqual([
      expect.objectContaining({ grantId, reason: "no_pong" }),
    ]);
  });

  it("closes the connection to a server that stopped answering", async () => {
    fakeTimers();
    const grants = manager();
    grants.start();
    const { accessToken } = await grant(grants);
    fake.stall();
    for (let minute = 1; minute <= 3; minute++) {
      expect(logged("connection_closed")).toEqual([]);
      await sweepAfter(MINUTE);
      // The ping goes unanswered.
      await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS);
    }
    expect(logged("connection_closed")).toEqual([
      expect.objectContaining({ reason: "no_pong" }),
    ]);
    expect(await grants.authenticate(accessToken)).toBe("connection_closed");
    expect(grants.status().grants).toBe(1);
  });
});

describe("caps", () => {
  it("ends the least recently used grant of a profile at its sixth sign-on", async () => {
    const grants = manager();
    const signedOn = [];
    for (let n = 0; n < 5; n++) {
      signedOn.push(await grant(grants));
      clock += 1000;
    }
    // The first grant is used again: the second is now the least recently used.
    await grants.authenticate(signedOn[0]!.accessToken);
    const sixth = await grant(grants);
    expect(await grants.authenticate(signedOn[1]!.accessToken)).toBe(
      "invalid_token",
    );
    for (const kept of [signedOn[0]!, signedOn[2]!, sixth]) {
      expect(await grants.authenticate(kept.accessToken)).toMatchObject({
        grantId: kept.grantId,
      });
    }
    expect(grants.status().grants).toBe(5);
    await until(() => fake.openSockets === 5);
    expect(logged("grant_ended")).toEqual([
      expect.objectContaining({
        grantId: signedOn[1]!.grantId,
        reason: "superseded",
      }),
    ]);
  });

  it("forwards no sign-on when the server holds its maximum of grants", async () => {
    const grants = manager();
    for (let n = 0; n < 5; n++) await grant(grants);
    await grant(grants, { profile: "otherusr" });
    expect(await signOn(grants, { profile: "thirdusr" })).toEqual({
      ok: false,
      reason: "at_capacity",
    });
    expect(fake.signOns("THIRDUSR")).toBe(0);
    // A profile at its own cap replaces one of its grants.
    expect((await signOn(grants)).ok).toBe(true);
    expect(grants.status().grants).toBe(6);
  });

  it("forwards no sign-on beyond OAUTH_MAX_CONNECTIONS", async () => {
    config.oauth.maxConnections = 1;
    const grants = manager();
    await grant(grants);
    expect(await signOn(grants, { profile: "otherusr" })).toEqual({
      ok: false,
      reason: "at_capacity",
    });
    expect(fake.signOns("OTHERUSR")).toBe(0);
  });

  it("stops counting a reconnect as a connection being opened once it has finished", async () => {
    fakeTimers();
    config.oauth.maxConnections = 1;
    const grants = manager();
    const { grantId, refreshToken } = await idleGrant(grants);
    const second = tokens(await refresh(grants, refreshToken));
    expect(await grants.authenticate(second.accessToken)).toMatchObject({
      grantId,
    });
    await sweepAfter(10 * MINUTE);
    await until(() => grants.status().openConnections === 0);
    const third = tokens(await refresh(grants, second.refreshToken));
    expect(await grants.authenticate(third.accessToken)).toMatchObject({
      grantId,
    });
  });

  it("answers a refresh that needs a connection beyond OAUTH_MAX_CONNECTIONS with busy, rotating nothing", async () => {
    fakeTimers();
    config.oauth.maxConnections = 1;
    const grants = manager();
    const { grantId, refreshToken } = await idleGrant(grants);
    const other = await grant(grants, { profile: "otherusr" });
    expect(await refresh(grants, refreshToken)).toEqual({
      ok: false,
      error: "rate_limited",
    });
    expect(fake.upgrades).toBe(2);

    await grants.revoke(Buffer.from(other.refreshToken));
    const next = tokens(await refresh(grants, refreshToken));
    expect(await grants.authenticate(next.accessToken)).toMatchObject({
      grantId,
    });
  });
});

describe("the end of a grant", () => {
  it("zero-fills the ciphertext, the wraps and the replay record on revoke", async () => {
    const grants = manager();
    const { grantId, refreshToken } = await grant(grants);
    tokens(await refresh(grants, refreshToken));
    const sealed = vi.mocked(seal).mock.results[0]!.value as {
      ciphertext: Buffer;
      key: Buffer;
    };
    const kept = [
      sealed.ciphertext,
      ...results(wrapKey),
      ...results(sealReplay),
    ];
    // Code wrap (already wiped), two refresh-token wraps, one replay record.
    expect(kept).toHaveLength(5);
    expect(kept.filter((buffer) => !allZero(buffer))).toHaveLength(4);
    expect(allZero(sealed.key)).toBe(true);

    expect(await grants.revokeByAdmin(grantId)).toBe(1);
    expect(kept.filter((buffer) => !allZero(buffer))).toEqual([]);
    await until(() => fake.openSockets === 0);
    expect(logged("grant_ended")).toEqual([
      expect.objectContaining({ grantId, reason: "admin" }),
    ]);
  });

  it("revokes by refresh token, and ignores a token it does not know", async () => {
    const grants = manager();
    const { grantId, accessToken, refreshToken } = await grant(grants);
    await grants.revoke(Buffer.from("A".repeat(43)));
    expect(grants.status().grants).toBe(1);
    await grants.revoke(Buffer.from(refreshToken));
    expect(await grants.authenticate(accessToken)).toBe("invalid_token");
    const error = await rejection(grants.executeQuery(grantId, "VALUES 1"));
    expect(error.code).toBe(JsonRpcErrorCode.Unauthorized);
    expect(error.message).toContain("has ended");
    await until(() => fake.openSockets === 0);
  });

  it("revokes every grant of a profile for the administrator", async () => {
    const grants = manager();
    await grant(grants);
    await grant(grants);
    const other = await grant(grants, { profile: "otherusr" });
    expect(await grants.revokeByAdmin("testuser")).toBe(2);
    expect(await grants.revokeByAdmin("testuser")).toBe(0);
    expect(grants.describeGrants()).toEqual([
      expect.objectContaining({ grantId: other.grantId }),
    ]);
    await until(() => fake.openSockets === 1);
  });

  it("shutdown ends every grant, closes every socket and stops the sweep", async () => {
    fakeTimers();
    const grants = manager();
    grants.start();
    const one = await grant(grants);
    await grant(grants, { profile: "otherusr" });
    expect(vi.getTimerCount()).toBe(1);

    await grants.shutdown();
    await until(() => fake.openSockets === 0);
    expect(vi.getTimerCount()).toBe(0);
    expect(
      fake.requests.filter((request) => request.type === "exit"),
    ).toHaveLength(2);
    expect(grants.status()).toMatchObject({ grants: 0, openConnections: 0 });
    expect(await grants.authenticate(one.accessToken)).toBe("invalid_token");
    expect(logged("grant_ended").map((entry) => entry.reason)).toEqual([
      "shutdown",
      "shutdown",
    ]);

    // Nothing is forwarded after shutdown.
    expect(await signOn(grants)).toEqual({ ok: false, reason: "at_capacity" });
    expect(fake.connects).toHaveLength(2);
  });
});

describe("shutdown while sign-ons are under way", () => {
  it("cuts a reconnect and a sign-on whose connect is not answered, and a sign-on that is reading its profile row", async () => {
    // Timers are faked and never advanced: no timeout closes a socket here.
    fakeTimers();
    const grants = manager();
    const { refreshToken } = await idleGrant(grants);
    fake.signOn.TESTUSER = "no_reply";
    fake.signOn.OTHERUSR = "no_reply";
    tokens(await refresh(grants, refreshToken));
    const unanswered = signOn(grants, { profile: "otherusr" });
    fake.statements.unshift({ match: "USER_INFO_BASIC", reply: "no_reply" });
    const readingRow = signOn(grants, { profile: "thirdusr" });
    await until(
      () =>
        fake.connects.length === 4 &&
        fake.requests.some(
          ({ profile, sql }) =>
            profile === "THIRDUSR" && String(sql).includes("USER_INFO_BASIC"),
        ),
    );
    expect(fake.openSockets).toBe(3);

    await grants.shutdown();

    expect(await unanswered).toEqual({ ok: false, reason: "unavailable" });
    expect(await readingRow).toEqual({ ok: false, reason: "unavailable" });
    await until(() => fake.openSockets === 0);
    expect(grants.status()).toMatchObject({ grants: 0, openConnections: 0 });
  });

  it("resolves only once the sockets it closes are closed", async () => {
    const real = clientFor();
    const closing: boolean[] = [];
    const grants = manager({
      ...real,
      async signOn(...args) {
        const outcome = await real.signOn(...args);
        if (outcome.class === "ok") {
          const { session } = outcome;
          const close = session.close.bind(session);
          session.close = async () => {
            const index = closing.push(true) - 1;
            await close();
            await settle();
            closing[index] = false;
          };
        }
        return outcome;
      },
    });
    await grant(grants);
    // Refused as privileged: its socket is closed without being waited for.
    profileRow({ SPECIAL_AUTHORITIES: "*ALLOBJ" });
    expect(await signOn(grants, { profile: "otherusr" })).toEqual({
      ok: false,
      reason: "privileged",
    });

    await grants.shutdown();

    expect(closing).toEqual([false, false]);
  });
});

describe("log lines", () => {
  it("carry a profile in clear only once it has signed on", async () => {
    const grants = manager();
    await signOn(grants, { profile: "otherusr", password: WRONG_PASSWORD });
    expect(logged("signon_rejected")).toEqual([
      expect.objectContaining({
        profileFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
        profileLength: 8,
        clientId: CLIENT_ID,
        destination: REDIRECT,
        address: ADDRESS,
      }),
    ]);
    expect(lines.filter((line) => /otherusr/i.test(line))).toEqual([]);

    await signOn(grants, { profile: "otherusr" });
    await signOn(grants, { profile: "otherusr", password: WRONG_PASSWORD });
    expect(logged("signon_rejected")[1]).toMatchObject({ profile: "OTHERUSR" });
  });

  it("carry a profile named in OAUTH_ALLOWED_PROFILES in clear", async () => {
    config.oauth.allowedProfiles = ["TESTUSER"];
    const grants = manager();
    await signOn(grants, { password: WRONG_PASSWORD });
    expect(logged("signon_rejected")).toEqual([
      expect.objectContaining({ profile: "TESTUSER" }),
    ]);
  });

  it("never carry a password, a code or a token", async () => {
    fakeTimers();
    const grants = manager();
    const { grantId, refreshToken } = await idleGrant(grants);
    const next = tokens(await refresh(grants, refreshToken));
    await grants.authenticate(next.accessToken);
    await grants.executeQuery(grantId, "VALUES 1");
    await signOn(grants, { profile: "otherusr", password: WRONG_PASSWORD });
    await grants.revoke(Buffer.from(next.refreshToken));

    expect(lines.length).toBeGreaterThanOrEqual(8);
    // 4 fixed secrets, 1 code, 2 token pairs.
    expect(secrets).toHaveLength(9);
    for (const secret of secrets) {
      expect(lines.filter((line) => line.includes(secret))).toEqual([]);
    }
    // What a line says about a token is 8 characters of its hash.
    expect(logged("token_refreshed")[0]!.tokenHash).toBe(
      createHash("sha256").update(refreshToken).digest("hex").slice(0, 8),
    );
  });
});

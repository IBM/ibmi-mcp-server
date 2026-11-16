/**
 * @fileoverview Tests for the grant store of the built-in OAuth
 * authorization server: the maps, the caps, and the rules of a grant's code
 * and tokens. The sealing is the real one; time is passed in.
 */

import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_GRANTS,
  type GrantRecord,
  type MapepireSession,
  type TokenEntry,
  type TokenPair,
} from "../../../src/ibmi-mcp-server/oauth/contracts.js";
import {
  createGrantStore,
  type GrantLifecycleStore,
  type NewGrant,
} from "../../../src/ibmi-mcp-server/oauth/grantStore.js";
import {
  hashSecret,
  seal,
  unseal,
  unwrapKey,
} from "../../../src/ibmi-mcp-server/oauth/sealing.js";

// The real sealing; `seal` and `unwrapKey` are wrapped only so a test can
// see the grant keys they handed to the store.
vi.mock("../../../src/ibmi-mcp-server/oauth/sealing.js", async (original) => {
  const actual =
    await original<
      typeof import("../../../src/ibmi-mcp-server/oauth/sealing.js")
    >();
  return {
    ...actual,
    seal: vi.fn(actual.seal),
    unwrapKey: vi.fn(actual.unwrapKey),
  };
});

const PASSWORD = "dummy-Pw-123";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const T0 = 1_800_000_000_000;
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
/** OAUTH_IDLE_CLOSE_MINUTES (10) plus 5 minutes. */
const ACCESS_TTL = 15 * MINUTE;

let store: GrantLifecycleStore;

beforeEach(() => {
  store = createGrantStore();
  vi.mocked(seal).mockClear();
  vi.mocked(unwrapKey).mockClear();
});

function newGrant(overrides: Partial<NewGrant> = {}): NewGrant {
  return {
    grantId: randomBytes(16).toString("base64url"),
    profile: "TESTUSER",
    clientId: "https://client.example/metadata.json",
    redirectUri: "http://127.0.0.1:33418/",
    signOnAddress: "127.0.0.1",
    createdAt: T0,
    expiresAt: T0 + 12 * HOUR,
    lastUsedAt: T0,
    session: null,
    ...overrides,
  };
}

/** A record for the map operations, with a stand-in ciphertext. */
function record(overrides: Partial<NewGrant> = {}): GrantRecord {
  return { ...newGrant(overrides), ciphertext: Buffer.alloc(40, 0xc1) };
}

/** A sign-on that succeeded at `now`. */
function signOn(
  overrides: Partial<NewGrant> = {},
  now = T0,
): { grant: GrantRecord; code: Buffer } {
  const created = store.createGrant(
    newGrant({ createdAt: now, lastUsedAt: now, ...overrides }),
    Buffer.from(PASSWORD),
    CHALLENGE,
    now,
  );
  if (!created) {
    throw new Error("store is full");
  }
  return created;
}

/** A sign-on and its code exchange, both at `now`. */
function signOnAndExchange(
  overrides: Partial<NewGrant> = {},
  now = T0,
): { grant: GrantRecord; code: Buffer; tokens: TokenPair } {
  const { grant, code } = signOn(overrides, now);
  return {
    grant,
    code,
    tokens: issuedBy(store.redeemCode(code, ACCESS_TTL, now)),
  };
}

/** The pair of a result that must carry one. */
function issuedBy(result: { status: string; tokens?: TokenPair }): TokenPair {
  if (!result.tokens) {
    throw new Error(`no tokens: ${result.status}`);
  }
  return result.tokens;
}

/** The live entry of a secret. */
function entryOf(secret: Buffer, now = T0): TokenEntry {
  const found = store.lookupToken(hashSecret(secret), now);
  if (found.status !== "live") {
    throw new Error(`not live: ${found.status}`);
  }
  return found.entry;
}

const isZero = (buffer: Buffer) => buffer.every((byte) => byte === 0);

describe("grants", () => {
  it("adds, finds and lists grants", () => {
    const first = record({ profile: "TESTUSER" });
    const second = record({ profile: "OTHERUSER" });

    expect(store.add(first)).toEqual({ added: true });
    expect(store.add(second)).toEqual({ added: true });

    expect(store.size).toBe(2);
    expect(store.get(first.grantId)).toBe(first);
    expect(store.get("no-such-grant")).toBeUndefined();
    expect(store.ofProfile("TESTUSER")).toEqual([first]);
    expect(store.ofProfile("NOBODY")).toEqual([]);
    expect(store.all()).toEqual([first, second]);
  });

  it("ends the least recently used grant of a profile that already has five", () => {
    const grants = [5, 3, 1, 4, 2].map((minutes) =>
      record({ lastUsedAt: T0 + minutes * MINUTE }),
    );
    const other = record({ profile: "OTHERUSER", lastUsedAt: T0 });
    for (const grant of [...grants, other]) {
      store.add(grant);
    }
    const leastRecentlyUsed = grants[2]!;
    const session = { jobName: "123456/QUSER/QZDASOINIT" } as MapepireSession;
    leastRecentlyUsed.session = session;
    const sixth = record();

    const result = store.add(sixth);

    expect(result).toEqual({ added: true, superseded: leastRecentlyUsed });
    expect(result.superseded).toBe(leastRecentlyUsed);
    expect(store.get(leastRecentlyUsed.grantId)).toBeUndefined();
    expect(isZero(leastRecentlyUsed.ciphertext)).toBe(true);
    // Closing the connection is the caller's part.
    expect(leastRecentlyUsed.session).toBe(session);
    expect(store.ofProfile("TESTUSER")).toHaveLength(5);
    expect(store.get(sixth.grantId)).toBe(sixth);
    expect(store.get(other.grantId)).toBe(other);
  });

  it("refuses a grant beyond 1,000 and changes nothing", () => {
    for (let i = 0; i < MAX_GRANTS; i++) {
      store.add(record({ profile: `USER${i}` }));
    }
    const before = store.all();
    const extra = record({ profile: "ONEMORE" });

    expect(store.add(extra)).toEqual({ added: false });

    expect(store.size).toBe(MAX_GRANTS);
    expect(store.all()).toEqual(before);
    expect(store.get(extra.grantId)).toBeUndefined();
    expect(isZero(extra.ciphertext)).toBe(false);
  });

  it("still supersedes within a profile when the store is full", () => {
    const mine = [1, 2, 3, 4, 5].map((minutes) =>
      record({ lastUsedAt: T0 + minutes * MINUTE }),
    );
    for (const grant of mine) {
      store.add(grant);
    }
    for (let i = mine.length; i < MAX_GRANTS; i++) {
      store.add(record({ profile: `USER${i}` }));
    }

    const result = store.add(record());

    expect(result.added).toBe(true);
    expect(result.superseded).toBe(mine[0]);
    expect(store.size).toBe(MAX_GRANTS);
  });

  it("creates no grant when the store is full, and keeps nothing of the sign-on", () => {
    for (let i = 0; i < MAX_GRANTS; i++) {
      store.add(record({ profile: `USER${i}` }));
    }
    const details = newGrant({ profile: "ONEMORE" });

    const created = store.createGrant(
      details,
      Buffer.from(PASSWORD),
      CHALLENGE,
      T0,
    );

    expect(created).toBeUndefined();
    expect(store.size).toBe(MAX_GRANTS);
    expect(store.get(details.grantId)).toBeUndefined();
    const sealed = vi.mocked(seal).mock.results[0]!.value as ReturnType<
      typeof seal
    >;
    expect(isZero(sealed.key)).toBe(true);
    expect(isZero(sealed.ciphertext)).toBe(true);
  });
});

describe("token index", () => {
  it("finds an entry until it expires", () => {
    const grant = record();
    store.add(grant);
    const entry: TokenEntry = {
      grantId: grant.grantId,
      kind: "at",
      expiresAt: T0 + MINUTE,
    };

    store.putToken("hash-1", entry);

    expect(store.lookupToken("hash-1", T0)).toEqual({ status: "live", entry });
    expect(store.lookupToken("hash-1", T0 + MINUTE - 1).status).toBe("live");
    expect(store.lookupToken("hash-1", T0 + MINUTE)).toEqual({
      status: "unknown",
    });
    expect(store.lookupToken("hash-2", T0)).toEqual({ status: "unknown" });
  });

  it("keeps no entry for a grant it does not hold", () => {
    store.putToken("hash-1", {
      grantId: "no-such-grant",
      kind: "at",
      expiresAt: T0 + MINUTE,
    });

    expect(store.lookupToken("hash-1", T0)).toEqual({ status: "unknown" });
  });

  it("retires a refresh token: wiped, gone, and remembered while its grant exists", () => {
    const grant = record();
    store.add(grant);
    const wrap = Buffer.alloc(60, 1);
    const replay = Buffer.alloc(115, 2);
    grant.previousRefreshHash = "hash-prev";
    store.putToken("hash-prev", {
      grantId: grant.grantId,
      kind: "rt_prev",
      expiresAt: T0 + HOUR,
      wrap,
      replay,
    });

    store.retireToken("hash-prev");

    expect(store.lookupToken("hash-prev", T0)).toEqual({
      status: "retired",
      grantId: grant.grantId,
    });
    expect(isZero(wrap)).toBe(true);
    expect(isZero(replay)).toBe(true);
    expect(grant.previousRefreshHash).toBeUndefined();

    store.remove(grant.grantId);

    expect(store.lookupToken("hash-prev", T0)).toEqual({ status: "unknown" });
  });

  it("treats a previous refresh token past its time as retired", () => {
    const grant = record();
    store.add(grant);
    const wrap = Buffer.alloc(60, 1);
    store.putToken("hash-prev", {
      grantId: grant.grantId,
      kind: "rt_prev",
      expiresAt: T0 + MINUTE,
      wrap,
    });

    expect(store.lookupToken("hash-prev", T0 + MINUTE)).toEqual({
      status: "retired",
      grantId: grant.grantId,
    });
    expect(isZero(wrap)).toBe(true);
    // And it stays retired, whatever the time.
    expect(store.lookupToken("hash-prev", T0).status).toBe("retired");
  });

  it("ignores retiring a hash it does not hold", () => {
    store.retireToken("no-such-hash");

    expect(store.lookupToken("no-such-hash", T0)).toEqual({
      status: "unknown",
    });
  });
});

describe("sign-on", () => {
  it("keeps the password only as ciphertext and issues one code that lives 60 seconds", () => {
    const password = Buffer.from(PASSWORD);
    const details = newGrant();

    const created = store.createGrant(details, password, CHALLENGE, T0);

    const { grant, code } = created!;
    expect(created!.superseded).toBeUndefined();
    expect(store.get(details.grantId)).toBe(grant);
    expect(grant).toMatchObject(details);
    expect(grant.ciphertext).toHaveLength(12 + PASSWORD.length + 16);
    expect(grant.ciphertext.includes(password)).toBe(false);
    expect(grant.refreshHash).toBeUndefined();
    // The caller's buffer is read, not wiped: that is the caller's part.
    expect(password.toString("latin1")).toBe(PASSWORD);

    expect(code.toString("latin1")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const entry = entryOf(code);
    expect(entry).toEqual({
      grantId: grant.grantId,
      kind: "code",
      expiresAt: T0 + MINUTE,
      wrap: expect.any(Buffer),
      codeChallenge: CHALLENGE,
    });
    expect(store.lookupToken(hashSecret(code), T0 + MINUTE).status).toBe(
      "unknown",
    );
  });

  it("supersedes the least recently used grant of the profile at the sixth sign-on", () => {
    const grants = [1, 2, 3, 4, 5].map(
      (minutes) => signOn({ lastUsedAt: T0 + minutes * MINUTE }).grant,
    );
    const ciphertext = grants[0]!.ciphertext;

    const created = store.createGrant(
      newGrant(),
      Buffer.from(PASSWORD),
      CHALLENGE,
      T0 + 10 * MINUTE,
    );

    expect(created?.superseded).toBe(grants[0]);
    expect(isZero(ciphertext)).toBe(true);
    expect(store.ofProfile("TESTUSER")).toHaveLength(5);
  });

  it("zero-fills the grant key once the code holds its wrap", () => {
    signOn();

    const sealed = vi.mocked(seal).mock.results[0]!.value as ReturnType<
      typeof seal
    >;
    expect(sealed.key).toHaveLength(32);
    expect(isZero(sealed.key)).toBe(true);
  });

  it("cannot produce the password from what it holds; the code can", () => {
    const { grant, code } = signOn();
    const { grantId, ciphertext } = grant;
    const hash = hashSecret(code);
    const wrap = entryOf(code).wrap!;

    // Everything the server holds: the ciphertext, the wrap, the hash.
    const held = [
      ciphertext,
      wrap,
      wrap.subarray(12, 44),
      wrap.subarray(0, 32),
      Buffer.from(hash, "hex"),
      Buffer.from(hash, "ascii"),
      Buffer.from(grantId),
    ];
    for (const candidate of held) {
      expect(unwrapKey(wrap, candidate, grantId)).toBeUndefined();
      expect(unseal(ciphertext, candidate, grantId)).toBeUndefined();
    }

    const key = unwrapKey(wrap, code, grantId)!;
    expect(unseal(ciphertext, key, grantId)?.toString("latin1")).toBe(PASSWORD);
  });
});

describe("code exchange", () => {
  it("issues the first pair and moves the key wrap from the code to the refresh token", () => {
    const { grant, code } = signOn();
    const { grantId, ciphertext } = grant;
    const codeEntry = entryOf(code);
    const codeWrap = codeEntry.wrap!;
    const now = T0 + 5 * SECOND;

    const result = store.redeemCode(code, ACCESS_TTL, now);

    expect(result.status).toBe("issued");
    const { accessToken, refreshToken } = issuedBy(result);
    expect(result).toMatchObject({ grantId });
    expect(accessToken.toString("latin1")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(refreshToken.toString("latin1")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(accessToken.equals(refreshToken)).toBe(false);

    expect(entryOf(accessToken, now)).toEqual({
      grantId,
      kind: "at",
      expiresAt: now + ACCESS_TTL,
    });
    const refreshEntry = entryOf(refreshToken, now);
    expect(refreshEntry).toEqual({
      grantId,
      kind: "rt",
      expiresAt: grant.expiresAt,
      wrap: expect.any(Buffer),
    });
    expect(grant.refreshHash).toBe(hashSecret(refreshToken));
    expect(grant.previousRefreshHash).toBeUndefined();

    // The code's wrap is wiped and gone; the code opens nothing any more.
    expect(isZero(codeWrap)).toBe(true);
    expect(codeEntry.wrap).toBeUndefined();
    expect(codeEntry.redeemed).toBe(true);
    expect(unwrapKey(refreshEntry.wrap!, code, grantId)).toBeUndefined();
    // The access token carries no key; the refresh token does.
    expect(unwrapKey(refreshEntry.wrap!, accessToken, grantId)).toBeUndefined();
    const key = unwrapKey(refreshEntry.wrap!, refreshToken, grantId)!;
    expect(unseal(ciphertext, key, grantId)?.toString("latin1")).toBe(PASSWORD);
  });

  it("zero-fills the grant key once the refresh token holds its wrap", () => {
    const { code } = signOn();
    vi.mocked(unwrapKey).mockClear();

    store.redeemCode(code, ACCESS_TTL, T0);

    const keys = vi
      .mocked(unwrapKey)
      .mock.results.map((r) => r.value as Buffer);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toHaveLength(32);
    expect(isZero(keys[0]!)).toBe(true);
  });

  it("reports a second presentation inside the code's lifetime as replay and issues nothing", () => {
    const { grant, code } = signOn();
    const first = issuedBy(store.redeemCode(code, ACCESS_TTL, T0));

    const second = store.redeemCode(code, ACCESS_TTL, T0 + 59 * SECOND);

    expect(second).toEqual({ status: "replay", grantId: grant.grantId });
    // Ending the grant is the caller's part; nothing changed here.
    expect(grant.refreshHash).toBe(hashSecret(first.refreshToken));
    expect(
      store.useAccessToken(hashSecret(first.accessToken), T0),
    ).toBeDefined();
  });

  it("does not know a code after 60 seconds, redeemed or not", () => {
    const redeemed = signOn();
    store.redeemCode(redeemed.code, ACCESS_TTL, T0);
    const unredeemed = signOn();

    expect(store.redeemCode(redeemed.code, ACCESS_TTL, T0 + MINUTE)).toEqual({
      status: "unknown",
    });
    expect(store.redeemCode(unredeemed.code, ACCESS_TTL, T0 + MINUTE)).toEqual({
      status: "unknown",
    });
    expect(unredeemed.grant.refreshHash).toBeUndefined();
  });

  it("does not take a token, or anything else, for a code", () => {
    const { tokens } = signOnAndExchange();

    for (const notACode of [
      tokens.accessToken,
      tokens.refreshToken,
      Buffer.from("not-a-code"),
      Buffer.alloc(0),
    ]) {
      expect(store.redeemCode(notACode, ACCESS_TTL, T0)).toEqual({
        status: "unknown",
      });
    }
  });

  it("never lets an access token outlive its grant", () => {
    const { grant, code } = signOn({ expiresAt: T0 + 10 * MINUTE });

    const { accessToken } = issuedBy(store.redeemCode(code, ACCESS_TTL, T0));

    expect(entryOf(accessToken).expiresAt).toBe(grant.expiresAt);
  });
});

describe("access tokens", () => {
  it("resolves to the grant until the token expires, and notes the first use only", () => {
    const { grant, tokens } = signOnAndExchange();
    const hash = hashSecret(tokens.accessToken);

    expect(store.useAccessToken(hash, T0 + MINUTE)).toEqual({
      grant,
      expiresAt: T0 + ACCESS_TTL,
    });
    expect(store.useAccessToken(hash, T0 + ACCESS_TTL - 1)?.grant).toBe(grant);
    expect(entryOf(tokens.accessToken).firstUsedAt).toBe(T0 + MINUTE);
    expect(store.useAccessToken(hash, T0 + ACCESS_TTL)).toBeUndefined();
  });

  it("does not take a refresh token, a code or an unknown hash", () => {
    const { code, tokens } = signOnAndExchange();
    const other = signOn();

    expect(
      store.useAccessToken(hashSecret(tokens.refreshToken), T0),
    ).toBeUndefined();
    expect(store.useAccessToken(hashSecret(code), T0)).toBeUndefined();
    expect(store.useAccessToken(hashSecret(other.code), T0)).toBeUndefined();
    expect(store.useAccessToken("no-such-hash", T0)).toBeUndefined();
  });
});

describe("refresh", () => {
  it("rotates the current refresh token and moves the key wrap to its successor", () => {
    const { grant, tokens: first } = signOnAndExchange();
    const { grantId, ciphertext } = grant;
    const firstEntry = entryOf(first.refreshToken);
    const now = T0 + 20 * MINUTE;

    const result = store.rotate(first.refreshToken, ACCESS_TTL, now);

    expect(result.status).toBe("rotated");
    expect(result).toMatchObject({ grantId });
    const second = issuedBy(result);
    expect(second.accessToken.equals(first.accessToken)).toBe(false);
    expect(second.refreshToken.equals(first.refreshToken)).toBe(false);
    expect(entryOf(second.accessToken, now)).toEqual({
      grantId,
      kind: "at",
      expiresAt: now + ACCESS_TTL,
    });
    const secondEntry = entryOf(second.refreshToken, now);
    expect(secondEntry).toEqual({
      grantId,
      kind: "rt",
      expiresAt: grant.expiresAt,
      wrap: expect.any(Buffer),
    });
    expect(grant.refreshHash).toBe(hashSecret(second.refreshToken));
    expect(grant.previousRefreshHash).toBe(hashSecret(first.refreshToken));

    // The presented token is now the previous one: it keeps its wrap and
    // gets the replay record.
    expect(entryOf(first.refreshToken, now)).toBe(firstEntry);
    expect(firstEntry).toMatchObject({ kind: "rt_prev", replays: 0 });
    expect(firstEntry.replay).toBeInstanceOf(Buffer);
    for (const refreshToken of [first.refreshToken, second.refreshToken]) {
      const key = unwrapKey(
        entryOf(refreshToken, now).wrap!,
        refreshToken,
        grantId,
      )!;
      expect(unseal(ciphertext, key, grantId)?.toString("latin1")).toBe(
        PASSWORD,
      );
    }
  });

  it("zero-fills the grant key after a rotation", () => {
    const { tokens } = signOnAndExchange();
    vi.mocked(unwrapKey).mockClear();

    store.rotate(tokens.refreshToken, ACCESS_TTL, T0);

    const keys = vi
      .mocked(unwrapKey)
      .mock.results.map((r) => r.value as Buffer);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toHaveLength(32);
    expect(isZero(keys[0]!)).toBe(true);
  });

  it("does not replace access tokens: each is good until it expires", () => {
    const { grant, tokens: first } = signOnAndExchange();
    const now = T0 + 10 * MINUTE;

    const second = issuedBy(store.rotate(first.refreshToken, ACCESS_TTL, now));

    expect(
      store.useAccessToken(hashSecret(first.accessToken), now)?.grant,
    ).toBe(grant);
    expect(
      store.useAccessToken(hashSecret(second.accessToken), now)?.grant,
    ).toBe(grant);
    expect(
      store.useAccessToken(hashSecret(first.accessToken), T0 + ACCESS_TTL),
    ).toBeUndefined();
  });

  it("answers the previous refresh token with the same pair, three times at most, and never rotates it", () => {
    const { grant, tokens: first } = signOnAndExchange();
    const second = issuedBy(store.rotate(first.refreshToken, ACCESS_TTL, T0));
    const currentHash = grant.refreshHash;

    for (let replay = 1; replay <= 3; replay++) {
      const result = store.rotate(first.refreshToken, ACCESS_TTL, T0 + replay);

      expect(result.status).toBe("replayed");
      expect(result).toMatchObject({ grantId: grant.grantId });
      expect(issuedBy(result)).toEqual(second);
      expect(issuedBy(result).accessToken).not.toBe(second.accessToken);
      expect(entryOf(first.refreshToken).replays).toBe(replay);
    }
    expect(store.rotate(first.refreshToken, ACCESS_TTL, T0 + 4)).toEqual({
      status: "replay_limit",
      grantId: grant.grantId,
    });

    // No replay issued anything new, and the grant is as it was.
    expect(grant.refreshHash).toBe(currentHash);
    expect(grant.previousRefreshHash).toBe(hashSecret(first.refreshToken));
    expect(store.get(grant.grantId)).toBe(grant);
    expect(store.rotate(second.refreshToken, ACCESS_TTL, T0 + 5).status).toBe(
      "rotated",
    );
  });

  it("retires the previous refresh token when its successor is first presented", () => {
    const { grant, tokens: first } = signOnAndExchange();
    const second = issuedBy(store.rotate(first.refreshToken, ACCESS_TTL, T0));
    const { wrap, replay } = entryOf(first.refreshToken);

    const third = store.rotate(second.refreshToken, ACCESS_TTL, T0 + SECOND);

    expect(third.status).toBe("rotated");
    expect(isZero(wrap!)).toBe(true);
    expect(isZero(replay!)).toBe(true);
    expect(grant.previousRefreshHash).toBe(hashSecret(second.refreshToken));
    expect(
      store.rotate(first.refreshToken, ACCESS_TTL, T0 + 2 * SECOND),
    ).toEqual({ status: "reuse", grantId: grant.grantId });
    // The token that was just rotated out still replays.
    expect(
      store.rotate(second.refreshToken, ACCESS_TTL, T0 + 2 * SECOND).status,
    ).toBe("replayed");
  });

  it("retires the previous refresh token 60 seconds after the successor access token is first used", () => {
    const { grant, tokens: first } = signOnAndExchange();
    const second = issuedBy(store.rotate(first.refreshToken, ACCESS_TTL, T0));
    const { wrap, replay } = entryOf(first.refreshToken);
    const firstUse = T0 + 5 * MINUTE;

    // Unused, the successor leaves the previous token replayable.
    expect(store.rotate(first.refreshToken, ACCESS_TTL, firstUse).status).toBe(
      "replayed",
    );
    store.useAccessToken(hashSecret(second.accessToken), firstUse);
    // A later use does not move the time.
    store.useAccessToken(
      hashSecret(second.accessToken),
      firstUse + 30 * SECOND,
    );

    expect(
      store.rotate(first.refreshToken, ACCESS_TTL, firstUse + MINUTE - 1)
        .status,
    ).toBe("replayed");
    expect(isZero(wrap!)).toBe(false);
    expect(
      store.rotate(first.refreshToken, ACCESS_TTL, firstUse + MINUTE),
    ).toEqual({ status: "reuse", grantId: grant.grantId });
    expect(isZero(wrap!)).toBe(true);
    expect(isZero(replay!)).toBe(true);
    expect(grant.previousRefreshHash).toBeUndefined();
    // The current token is untouched by that.
    expect(
      store.rotate(second.refreshToken, ACCESS_TTL, firstUse + MINUTE).status,
    ).toBe("rotated");
  });

  it("does not start that minute when an older access token is used", () => {
    const { tokens: first } = signOnAndExchange();
    store.rotate(first.refreshToken, ACCESS_TTL, T0);

    store.useAccessToken(hashSecret(first.accessToken), T0 + SECOND);

    expect(
      store.rotate(first.refreshToken, ACCESS_TTL, T0 + 5 * MINUTE).status,
    ).toBe("replayed");
  });

  it("reports a retired refresh token as reuse for as long as its grant exists", () => {
    const { grant, tokens: first } = signOnAndExchange();
    const second = issuedBy(store.rotate(first.refreshToken, ACCESS_TTL, T0));
    const third = issuedBy(store.rotate(second.refreshToken, ACCESS_TTL, T0));

    expect(store.rotate(first.refreshToken, ACCESS_TTL, T0 + 6 * HOUR)).toEqual(
      {
        status: "reuse",
        grantId: grant.grantId,
      },
    );
    // Reporting changes nothing: ending the grant is the caller's part.
    expect(store.get(grant.grantId)).toBe(grant);
    expect(grant.refreshHash).toBe(hashSecret(third.refreshToken));

    store.remove(grant.grantId);

    expect(store.rotate(first.refreshToken, ACCESS_TTL, T0)).toEqual({
      status: "unknown",
    });
  });

  it("allows 12 rotations of a grant in 5 minutes and refuses the next", () => {
    const { grant, tokens } = signOnAndExchange();
    const other = signOnAndExchange({ profile: "OTHERUSER" });
    let current = tokens.refreshToken;
    for (let rotation = 0; rotation < 12; rotation++) {
      current = issuedBy(
        store.rotate(current, ACCESS_TTL, T0 + rotation * SECOND),
      ).refreshToken;
    }
    const hashBefore = grant.refreshHash;

    expect(store.rotate(current, ACCESS_TTL, T0 + 12 * SECOND)).toEqual({
      status: "rate_limited",
      grantId: grant.grantId,
    });
    expect(store.rotate(current, ACCESS_TTL, T0 + 5 * MINUTE - 1).status).toBe(
      "rate_limited",
    );

    // Nothing was issued, the token is still the current one, and another
    // grant is not held back.
    expect(grant.refreshHash).toBe(hashBefore);
    expect(entryOf(current).kind).toBe("rt");
    expect(
      store.rotate(other.tokens.refreshToken, ACCESS_TTL, T0 + 12 * SECOND)
        .status,
    ).toBe("rotated");
    // Five minutes after the first rotation there is room for one more.
    expect(store.rotate(current, ACCESS_TTL, T0 + 5 * MINUTE).status).toBe(
      "rotated",
    );
  });

  it("does not take an access token, a code or anything else for a refresh token", () => {
    const { tokens } = signOnAndExchange();
    const other = signOn();

    for (const notARefreshToken of [
      tokens.accessToken,
      other.code,
      Buffer.from("not-a-token"),
      Buffer.alloc(0),
    ]) {
      expect(store.rotate(notARefreshToken, ACCESS_TTL, T0)).toEqual({
        status: "unknown",
      });
    }
  });

  it("does not know a refresh token once its grant is past its end", () => {
    const { grant, tokens } = signOnAndExchange();

    expect(
      store.rotate(tokens.refreshToken, ACCESS_TTL, grant.expiresAt),
    ).toEqual({ status: "unknown" });
  });
});

describe("what is stored", () => {
  it("holds no code or token, only hashes", () => {
    const { grant, code, tokens: first } = signOnAndExchange();
    const second = issuedBy(store.rotate(first.refreshToken, ACCESS_TTL, T0));
    const secrets = [code, ...Object.values(first), ...Object.values(second)];
    const stored: unknown[] = [
      grant,
      ...secrets.map((secret) => entryOf(secret)),
    ];
    const strings: string[] = [];
    const buffers: Buffer[] = [];
    for (const object of stored) {
      for (const value of Object.values(object as object)) {
        if (typeof value === "string") {
          strings.push(value);
        } else if (Buffer.isBuffer(value)) {
          buffers.push(value);
        }
      }
    }
    expect(buffers).toHaveLength(4); // ciphertext, two wraps, replay record

    for (const secret of secrets) {
      const text = secret.toString("latin1");
      expect(strings.some((value) => value.includes(text))).toBe(false);
      expect(buffers.some((value) => value.includes(secret))).toBe(false);
    }
  });
});

describe("ending a grant", () => {
  it("zero-fills the ciphertext, wraps and replay record and forgets every code and token", () => {
    const session = { jobName: "123456/QUSER/QZDASOINIT" } as MapepireSession;
    const { grant, code, tokens: first } = signOnAndExchange({ session });
    const second = issuedBy(store.rotate(first.refreshToken, ACCESS_TTL, T0));
    const third = issuedBy(store.rotate(second.refreshToken, ACCESS_TTL, T0));
    const other = signOnAndExchange({ profile: "OTHERUSER" });
    const { ciphertext } = grant;
    const previous = entryOf(second.refreshToken);
    const current = entryOf(third.refreshToken);
    const buffers = [
      ciphertext,
      previous.wrap!,
      previous.replay!,
      current.wrap!,
    ];
    expect(buffers.some(isZero)).toBe(false);

    const removed = store.remove(grant.grantId);

    expect(removed).toBe(grant);
    expect(removed?.session).toBe(session);
    expect(buffers.every(isZero)).toBe(true);
    expect(grant.refreshHash).toBeUndefined();
    expect(grant.previousRefreshHash).toBeUndefined();
    expect(store.get(grant.grantId)).toBeUndefined();
    expect(store.size).toBe(1);
    for (const secret of [
      code,
      ...Object.values(first),
      ...Object.values(second),
      ...Object.values(third),
    ]) {
      const hash = hashSecret(secret);
      expect(store.lookupToken(hash, T0)).toEqual({ status: "unknown" });
      expect(store.useAccessToken(hash, T0)).toBeUndefined();
      expect(store.rotate(secret, ACCESS_TTL, T0)).toEqual({
        status: "unknown",
      });
      expect(store.redeemCode(secret, ACCESS_TTL, T0)).toEqual({
        status: "unknown",
      });
    }
    // The refresh token that held the key opens nothing now.
    expect(
      unwrapKey(current.wrap!, third.refreshToken, grant.grantId),
    ).toBeUndefined();

    // Another grant is untouched.
    expect(
      store.useAccessToken(hashSecret(other.tokens.accessToken), T0)?.grant,
    ).toBe(other.grant);
    expect(isZero(other.grant.ciphertext)).toBe(false);
    expect(store.remove(grant.grantId)).toBeUndefined();
  });
});

describe("sweep", () => {
  it("names a grant whose code expired without being exchanged, and removes nothing itself", () => {
    const abandoned = signOn();
    const exchanged = signOnAndExchange({ profile: "OTHERUSER" });
    const wrap = entryOf(abandoned.code).wrap!;

    expect(store.sweep(T0 + MINUTE - 1)).toEqual([]);
    expect(store.sweep(T0 + MINUTE)).toEqual([abandoned.grant.grantId]);

    expect(isZero(wrap)).toBe(true);
    expect(store.get(abandoned.grant.grantId)).toBe(abandoned.grant);
    expect(isZero(abandoned.grant.ciphertext)).toBe(false);
    expect(store.get(exchanged.grant.grantId)).toBe(exchanged.grant);
    // Both code entries are gone, so the next sweep has nothing to name.
    expect(store.sweep(T0 + MINUTE)).toEqual([]);
  });

  it("names a grant past its end, once, however many of its entries expired", () => {
    const short = signOnAndExchange({ expiresAt: T0 + HOUR });
    const long = signOnAndExchange({ profile: "OTHERUSER" });

    expect(store.sweep(T0 + HOUR - 1)).toEqual([]);
    expect(store.sweep(T0 + HOUR)).toEqual([short.grant.grantId]);
    expect(store.size).toBe(2);
    expect(store.get(long.grant.grantId)).toBe(long.grant);
  });

  it("drops expired access tokens and keeps the rest", () => {
    const { grant, tokens: first } = signOnAndExchange();
    const second = issuedBy(
      store.rotate(first.refreshToken, ACCESS_TTL, T0 + 10 * MINUTE),
    );
    const firstEntry = entryOf(first.accessToken);
    const sweptAt = T0 + ACCESS_TTL;

    expect(store.sweep(sweptAt)).toEqual([]);

    // Gone from the index, not merely past its time: giving the entry more
    // time does not bring it back.
    firstEntry.expiresAt = sweptAt + HOUR;
    expect(store.lookupToken(hashSecret(first.accessToken), sweptAt)).toEqual({
      status: "unknown",
    });
    expect(
      store.useAccessToken(hashSecret(second.accessToken), sweptAt)?.grant,
    ).toBe(grant);
    expect(entryOf(second.refreshToken, sweptAt).kind).toBe("rt");
  });

  it("retires a previous refresh token whose time has passed", () => {
    const { grant, tokens: first } = signOnAndExchange();
    const second = issuedBy(store.rotate(first.refreshToken, ACCESS_TTL, T0));
    const { wrap, replay } = entryOf(first.refreshToken);
    store.useAccessToken(hashSecret(second.accessToken), T0);

    expect(store.sweep(T0 + MINUTE - 1)).toEqual([]);
    expect(isZero(wrap!)).toBe(false);
    // The code entry of this grant expires at the same moment; it was
    // exchanged, so the grant is not named.
    expect(store.sweep(T0 + MINUTE)).toEqual([]);

    expect(isZero(wrap!)).toBe(true);
    expect(isZero(replay!)).toBe(true);
    expect(grant.previousRefreshHash).toBeUndefined();
    // Retired by the sweep, not by this lookup: the time given is early.
    expect(store.lookupToken(hashSecret(first.refreshToken), T0)).toEqual({
      status: "retired",
      grantId: grant.grantId,
    });
  });
});

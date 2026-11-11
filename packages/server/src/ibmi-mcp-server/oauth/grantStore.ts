/**
 * @fileoverview The grants of the built-in OAuth authorization server and
 * the index of their codes and tokens (`GrantStore` of contracts.ts), with
 * the rules of a grant's secrets on top: one authorization code, used once;
 * refresh rotation with a replay record; when a rotated-out refresh token is
 * retired.
 *
 * Process memory only: plain maps, no I/O, no timers, no clock (every
 * function that depends on the time takes it as `now`). A code or token is
 * never stored, only its SHA-256. The grant key exists here only between an
 * unwrap and the next wrap and is zero-filled before the function returns.
 * @module src/ibmi-mcp-server/oauth/grantStore
 */

import {
  AUTHORIZATION_CODE_TTL_MS,
  MAX_GRANTS,
  MAX_GRANTS_PER_PROFILE,
  REFRESH_REPLAY_LIMIT,
  REFRESH_RETIRE_AFTER_USE_MS,
  REFRESH_ROTATION_LIMIT,
  type GrantId,
  type GrantRecord,
  type GrantStore,
  type TokenEntry,
  type TokenLookup,
  type TokenPair,
} from "./contracts.js";
import {
  hashSecret,
  newSecret,
  openReplay,
  seal,
  sealReplay,
  unwrapKey,
  wrapKey,
  zeroFill,
} from "./sealing.js";

/** What `createGrant` is given besides the password. */
export type NewGrant = Omit<
  GrantRecord,
  "ciphertext" | "refreshHash" | "previousRefreshHash"
>;

/** What presenting an authorization code led to. */
export type CodeRedemption =
  /** First presentation. The caller sends the pair, then zero-fills it. */
  | { status: "issued"; grantId: GrantId; tokens: TokenPair }
  /** Presented before, and not yet expired: the caller ends the grant. */
  | { status: "replay"; grantId: GrantId }
  /** Not a code, or expired. */
  | { status: "unknown" };

/** What presenting a refresh token led to. */
export type RefreshRotation =
  /** The current token: a new pair. The caller sends it, then zero-fills it. */
  | { status: "rotated"; grantId: GrantId; tokens: TokenPair }
  /** The previous token: the pair its rotation produced, again. */
  | { status: "replayed"; grantId: GrantId; tokens: TokenPair }
  /** A retired token: the caller ends the grant. */
  | { status: "reuse"; grantId: GrantId }
  /** `REFRESH_ROTATION_LIMIT` reached. Nothing was issued. */
  | { status: "rate_limited"; grantId: GrantId }
  /** The previous token, already replayed `REFRESH_REPLAY_LIMIT` times. */
  | { status: "replay_limit"; grantId: GrantId }
  /** Not a refresh token, or of no grant. */
  | { status: "unknown" };

/** The store, and the rules of a grant's code and tokens. */
export interface GrantLifecycleStore extends GrantStore {
  /**
   * Seals the password, adds the grant (as `add` does) and issues its
   * authorization code, which holds the only wrap of the grant key.
   *
   * @param password - Read, never kept: the caller zero-fills it.
   * @param codeChallenge - The PKCE S256 challenge of the sign-on.
   * @returns The code, for the caller to send and zero-fill; `undefined`,
   *   with nothing kept, when the store is full.
   */
  createGrant(
    grant: NewGrant,
    password: Buffer,
    codeChallenge: string,
    now: number,
  ): { grant: GrantRecord; code: Buffer; superseded?: GrantRecord } | undefined;
  /**
   * Exchanges an authorization code for the grant's first token pair and
   * moves the wrap of the grant key from the code to the refresh token. The
   * caller checks PKCE, client, redirect and address before (with
   * `lookupToken`).
   *
   * @param accessTokenTtlMs - Lifetime of the access token.
   */
  redeemCode(
    code: Buffer,
    accessTokenTtlMs: number,
    now: number,
  ): CodeRedemption;
  /**
   * Answers a refresh token.
   *
   * - The current one rotates: a new pair, the wrap of the grant key moved
   *   to the new refresh token. The presented token becomes the previous
   *   one and keeps its wrap, with a replay record of the new pair. At most
   *   `REFRESH_ROTATION_LIMIT` rotations per grant.
   * - The previous one gets the same pair again, up to
   *   `REFRESH_REPLAY_LIMIT` times. It never rotates.
   * - The previous one is retired when its successor is first presented
   *   here, or `REFRESH_RETIRE_AFTER_USE_MS` after the successor access
   *   token is first used (`useAccessToken`).
   *
   * @param accessTokenTtlMs - Lifetime of a new access token.
   */
  rotate(
    refreshToken: Buffer,
    accessTokenTtlMs: number,
    now: number,
  ): RefreshRotation;
  /**
   * Resolves an access token by its hash and notes its first use. Access
   * tokens are not replaced by a rotation: each is good until it expires.
   *
   * @returns The grant and when the token expires; `undefined` when it is
   *   not a live access token.
   */
  useAccessToken(
    hash: string,
    now: number,
  ): { grant: GrantRecord; expiresAt: number } | undefined;
}

/** A grant and what the store keeps about its tokens. */
interface StoredGrant {
  grant: GrantRecord;
  /** Hashes of its entries in the token index. */
  hashes: Set<string>;
  /** Hashes of its retired refresh tokens. */
  retired: Set<string>;
  /** Times of its rotations inside `REFRESH_ROTATION_LIMIT.windowMs`. */
  rotations: number[];
  /** Hash of the access token issued by its latest rotation. */
  successorAccessHash?: string;
}

/** Creates an empty store. */
export function createGrantStore(): GrantLifecycleStore {
  const grants = new Map<GrantId, StoredGrant>();
  const tokens = new Map<string, TokenEntry>();
  const retired = new Map<string, GrantId>();

  function all(): GrantRecord[] {
    return [...grants.values()].map((stored) => stored.grant);
  }

  function ofProfile(profile: string): GrantRecord[] {
    return all().filter((grant) => grant.profile === profile);
  }

  function dropToken(hash: string): TokenEntry | undefined {
    const entry = tokens.get(hash);
    if (entry) {
      zeroFill(entry.wrap, entry.replay);
      tokens.delete(hash);
      grants.get(entry.grantId)?.hashes.delete(hash);
    }
    return entry;
  }

  function remove(grantId: GrantId): GrantRecord | undefined {
    const stored = grants.get(grantId);
    if (!stored) {
      return undefined;
    }
    for (const hash of [...stored.hashes]) {
      dropToken(hash);
    }
    for (const hash of stored.retired) {
      retired.delete(hash);
    }
    grants.delete(grantId);
    const { grant } = stored;
    zeroFill(grant.ciphertext);
    grant.refreshHash = undefined;
    grant.previousRefreshHash = undefined;
    return grant;
  }

  function add(grant: GrantRecord): {
    added: boolean;
    superseded?: GrantRecord;
  } {
    const sameProfile = ofProfile(grant.profile);
    let superseded: GrantRecord | undefined;
    if (sameProfile.length >= MAX_GRANTS_PER_PROFILE) {
      const leastRecentlyUsed = sameProfile.reduce((oldest, candidate) =>
        candidate.lastUsedAt < oldest.lastUsedAt ? candidate : oldest,
      );
      superseded = remove(leastRecentlyUsed.grantId);
    } else if (grants.size >= MAX_GRANTS) {
      return { added: false };
    }
    grants.set(grant.grantId, {
      grant,
      hashes: new Set(),
      retired: new Set(),
      rotations: [],
    });
    return { added: true, superseded };
  }

  function putToken(hash: string, entry: TokenEntry): void {
    const stored = grants.get(entry.grantId);
    if (stored) {
      tokens.set(hash, entry);
      stored.hashes.add(hash);
    }
  }

  function retireToken(hash: string): void {
    const entry = dropToken(hash);
    const stored = entry && grants.get(entry.grantId);
    if (!stored) {
      return;
    }
    stored.retired.add(hash);
    retired.set(hash, stored.grant.grantId);
    if (stored.grant.previousRefreshHash === hash) {
      stored.grant.previousRefreshHash = undefined;
    }
  }

  function lookupToken(hash: string, now: number): TokenLookup {
    const entry = tokens.get(hash);
    if (entry && now < entry.expiresAt) {
      return { status: "live", entry };
    }
    if (entry?.kind === "rt_prev") {
      retireToken(hash);
    }
    const grantId = retired.get(hash);
    return grantId === undefined
      ? { status: "unknown" }
      : { status: "retired", grantId };
  }

  function sweep(now: number): GrantId[] {
    const ended = new Set<GrantId>();
    for (const [hash, entry] of tokens) {
      if (now < entry.expiresAt) {
        continue;
      }
      if (entry.kind === "rt_prev") {
        retireToken(hash);
        continue;
      }
      if (entry.kind === "code" && !entry.redeemed) {
        ended.add(entry.grantId);
      }
      dropToken(hash);
    }
    for (const { grant } of grants.values()) {
      if (now >= grant.expiresAt) {
        ended.add(grant.grantId);
      }
    }
    return [...ended];
  }

  /**
   * Issues a pair for a grant whose key the caller has just unwrapped, and
   * wraps the key under the new refresh token.
   */
  function issueTokens(
    stored: StoredGrant,
    key: Buffer,
    accessTokenTtlMs: number,
    now: number,
  ): TokenPair {
    const { grant } = stored;
    const tokenPair = { accessToken: newSecret(), refreshToken: newSecret() };
    const accessHash = hashSecret(tokenPair.accessToken);
    const refreshHash = hashSecret(tokenPair.refreshToken);
    putToken(accessHash, {
      grantId: grant.grantId,
      kind: "at",
      expiresAt: Math.min(now + accessTokenTtlMs, grant.expiresAt),
    });
    putToken(refreshHash, {
      grantId: grant.grantId,
      kind: "rt",
      expiresAt: grant.expiresAt,
      wrap: wrapKey(key, tokenPair.refreshToken, grant.grantId),
    });
    grant.refreshHash = refreshHash;
    stored.successorAccessHash = accessHash;
    return tokenPair;
  }

  function createGrant(
    details: NewGrant,
    password: Buffer,
    codeChallenge: string,
    now: number,
  ):
    | { grant: GrantRecord; code: Buffer; superseded?: GrantRecord }
    | undefined {
    const { ciphertext, key } = seal(password, details.grantId);
    const grant: GrantRecord = { ...details, ciphertext };
    const { added, superseded } = add(grant);
    if (!added) {
      zeroFill(key, ciphertext);
      return undefined;
    }
    const code = newSecret();
    putToken(hashSecret(code), {
      grantId: grant.grantId,
      kind: "code",
      expiresAt: now + AUTHORIZATION_CODE_TTL_MS,
      wrap: wrapKey(key, code, grant.grantId),
      codeChallenge,
    });
    zeroFill(key);
    return { grant, code, superseded };
  }

  function redeemCode(
    code: Buffer,
    accessTokenTtlMs: number,
    now: number,
  ): CodeRedemption {
    const found = lookupToken(hashSecret(code), now);
    if (found.status !== "live" || found.entry.kind !== "code") {
      return { status: "unknown" };
    }
    const { entry } = found;
    const { grantId } = entry;
    if (entry.redeemed) {
      return { status: "replay", grantId };
    }
    const stored = grants.get(grantId);
    const key = stored && entry.wrap && unwrapKey(entry.wrap, code, grantId);
    if (!key) {
      return { status: "unknown" };
    }
    entry.redeemed = true;
    zeroFill(entry.wrap);
    entry.wrap = undefined;
    const tokenPair = issueTokens(stored, key, accessTokenTtlMs, now);
    zeroFill(key);
    return { status: "issued", grantId, tokens: tokenPair };
  }

  function rotate(
    refreshToken: Buffer,
    accessTokenTtlMs: number,
    now: number,
  ): RefreshRotation {
    const hash = hashSecret(refreshToken);
    const found = lookupToken(hash, now);
    if (found.status === "retired") {
      return { status: "reuse", grantId: found.grantId };
    }
    const entry = found.status === "live" ? found.entry : undefined;
    const stored = entry && grants.get(entry.grantId);
    if (!entry || !stored) {
      return { status: "unknown" };
    }
    const { grant } = stored;
    const { grantId } = grant;

    if (entry.kind === "rt_prev") {
      const replays = entry.replays ?? 0;
      if (replays >= REFRESH_REPLAY_LIMIT) {
        return { status: "replay_limit", grantId };
      }
      const tokenPair =
        entry.replay && openReplay(entry.replay, refreshToken, grantId);
      if (!tokenPair) {
        return { status: "unknown" };
      }
      entry.replays = replays + 1;
      return { status: "replayed", grantId, tokens: tokenPair };
    }
    if (entry.kind !== "rt") {
      return { status: "unknown" };
    }

    // The client holds the successor of the previous token: retire that one.
    if (grant.previousRefreshHash !== undefined) {
      retireToken(grant.previousRefreshHash);
    }
    stored.rotations = stored.rotations.filter(
      (at) => now - at < REFRESH_ROTATION_LIMIT.windowMs,
    );
    if (stored.rotations.length >= REFRESH_ROTATION_LIMIT.count) {
      return { status: "rate_limited", grantId };
    }
    const key = entry.wrap && unwrapKey(entry.wrap, refreshToken, grantId);
    if (!key) {
      return { status: "unknown" };
    }
    const tokenPair = issueTokens(stored, key, accessTokenTtlMs, now);
    zeroFill(key);
    entry.kind = "rt_prev";
    entry.replay = sealReplay(tokenPair, refreshToken, grantId);
    entry.replays = 0;
    grant.previousRefreshHash = hash;
    stored.rotations.push(now);
    return { status: "rotated", grantId, tokens: tokenPair };
  }

  function useAccessToken(
    hash: string,
    now: number,
  ): { grant: GrantRecord; expiresAt: number } | undefined {
    const found = lookupToken(hash, now);
    const entry = found.status === "live" ? found.entry : undefined;
    const stored = entry && grants.get(entry.grantId);
    if (!entry || !stored || entry.kind !== "at") {
      return undefined;
    }
    entry.firstUsedAt ??= now;
    const { grant } = stored;
    const previous =
      stored.successorAccessHash === hash &&
      grant.previousRefreshHash !== undefined
        ? tokens.get(grant.previousRefreshHash)
        : undefined;
    if (previous) {
      // The client has the successor pair: the previous refresh token is
      // retired once this passes.
      previous.expiresAt = Math.min(
        previous.expiresAt,
        entry.firstUsedAt + REFRESH_RETIRE_AFTER_USE_MS,
      );
    }
    return { grant, expiresAt: entry.expiresAt };
  }

  return {
    get size() {
      return grants.size;
    },
    add,
    get: (grantId) => grants.get(grantId)?.grant,
    ofProfile,
    all,
    remove,
    putToken,
    lookupToken,
    retireToken,
    sweep,
    createGrant,
    redeemCode,
    rotate,
    useAccessToken,
  };
}

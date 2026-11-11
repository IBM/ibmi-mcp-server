/**
 * @fileoverview The grant manager of the built-in OAuth sign-on
 * (`GrantManager` of contracts.ts): the one facade over the Mapepire
 * sessions, the sealing envelope, the grant store and the sign-on policy.
 *
 * A grant is one sign-on with an IBM i profile. Its Mapepire connection is
 * opened with the typed password, closed when idle, and reopened only inside
 * a refresh that follows a request refused because it was closed: the
 * presented refresh token unwraps the key of the sealed password. Nothing is
 * written to disk.
 *
 * Rules kept here:
 * - No string is made of a password, and every password Buffer this module
 *   is given or decrypts is zero-filled before the function that holds it
 *   settles.
 * - The sign-on path creates no closure over its request; reconnects and the
 *   sweep run in an async scope made when the manager is created, not in the
 *   context of the request that started them.
 * - `endGrant` is the single way a grant ends.
 * - A log line carries a profile in clear only once it has signed on in this
 *   process (or is named in `OAUTH_ALLOWED_PROFILES`), and never a password,
 *   code, token or anything Mapepire answered to a sign-on.
 * @module src/ibmi-mcp-server/oauth/grantManager
 */

import { AsyncResource } from "node:async_hooks";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { BindingValue, QueryResult } from "@ibm/mapepire-js";
import {
  config,
  DEFAULT_PAGE_SIZE,
  MAX_PAGINATION_ROWS,
} from "@/config/index.js";
import { isLoopbackAddress } from "@/mcp-server/transports/http/clientAddress.js";
import { JsonRpcErrorCode, McpError } from "@/types-global/errors.js";
import { logger } from "@/utils/internal/logger.js";
import {
  requestContextService,
  type RequestContext,
} from "@/utils/internal/requestContext.js";
import { isLoopbackRedirect } from "./clients.js";
import {
  ACCESS_TOKEN_EXTRA_MS,
  MAX_GRANTS,
  MAX_GRANTS_PER_PROFILE,
  MAX_MISSED_PONGS,
  PING_INTERVAL_MS,
  RECONNECT_BACKOFF_MS,
  RECONNECT_WAIT_MS,
  STATEMENT_QUEUE_DEPTH,
  SWEEP_INTERVAL_MS,
  type AuthRefusal,
  type CodeExchangeRequest,
  type CreateGrantManager,
  type GrantId,
  type GrantIdentity,
  type GrantRecord,
  type MapepireSession,
  type PaginatedQueryResult,
  type RefreshRequest,
  type SignOnOutcome,
  type SignOnRefusal,
  type SignOnRequest,
  type SignOnResult,
  type TokenPair,
  type TokenResult,
} from "./contracts.js";
import { checkCredentials, isProfileAllowed } from "./credentialSyntax.js";
import { createGrantStore } from "./grantStore.js";
import { hashSecret, unseal, unwrapKey, zeroFill } from "./sealing.js";
import { createSignOnThrottle } from "./throttle.js";

/**
 * One row, read for the signed-on profile itself. Two rows are asked for so
 * that the fetch comes up short and leaves no cursor open.
 */
const PROFILE_QUERY =
  "SELECT STATUS, PASSWORD_CHANGE_DATE, SPECIAL_AUTHORITIES FROM QSYS2.USER_INFO_BASIC WHERE AUTHORIZATION_NAME = ?";
/**
 * Reconnects of one profile answered OTHER or TIMEOUT, with no success
 * between, that end its grants.
 */
const MAX_FAILED_RECONNECTS = 2;
const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const INVALID_GRANT: TokenResult = { ok: false, error: "invalid_grant" };
const RATE_LIMITED: TokenResult = { ok: false, error: "rate_limited" };

/** Why a grant ended; `reason` of the `grant_ended` log line. */
type EndReason =
  | "revoked"
  | "admin"
  | "superseded"
  | "expired"
  | "code_expired"
  | "code_replay"
  | "refresh_reuse"
  | "signon_source_mismatch"
  | "reconnect_rejected"
  | "reconnect_not_permitted"
  | "reconnect_failed"
  | "profile_disabled"
  | "profile_changed"
  | "shutdown";

/** What the manager keeps about a grant besides its record. */
interface GrantState {
  /** Statements running or waiting on the grant's connection. */
  statements: number;
  /** Settles when the last statement queued so far has finished. */
  lastStatement: Promise<void>;
  /** The reconnect in flight. It never rejects. */
  reconnect?: Promise<void>;
  /**
   * A request was refused `connection_closed` since the connection closed:
   * the next refresh that can reopens it. Without one, a refresh signs
   * nothing on, so a client that only refreshes keeps no connection open.
   */
  reopenAsked: boolean;
  /** No reconnect is started before this time. */
  retryAfter: number;
  lastPingAt: number;
  /** Pings in a row that got no pong. */
  missedPongs: number;
}

/** A profile's row in QSYS2.USER_INFO_BASIC. */
interface ProfileInfo {
  status?: string;
  passwordChangeDate?: string;
  specialAuthorities: string;
}

/** Reads the profile's own row; `undefined` when it cannot be read. */
async function readProfile(
  session: MapepireSession,
  profile: string,
): Promise<ProfileInfo | undefined> {
  try {
    const result = await session.execute<Record<string, unknown>>(
      PROFILE_QUERY,
      [profile],
      2,
    );
    const row = result.data?.[0];
    if (!row) {
      return undefined;
    }
    const { STATUS, PASSWORD_CHANGE_DATE, SPECIAL_AUTHORITIES } = row;
    return {
      status: typeof STATUS === "string" ? STATUS : undefined,
      passwordChangeDate:
        PASSWORD_CHANGE_DATE === null || PASSWORD_CHANGE_DATE === undefined
          ? undefined
          : String(PASSWORD_CHANGE_DATE),
      // Null when the profile has no special authority.
      specialAuthorities:
        typeof SPECIAL_AUTHORITIES === "string" ? SPECIAL_AUTHORITIES : "",
    };
  } catch {
    return undefined;
  }
}

/** PKCE S256: whether the verifier hashes to the challenge of the sign-on. */
function pkceMatches(verifier: string, challenge: string | undefined): boolean {
  if (challenge === undefined || !PKCE_VERIFIER.test(verifier)) {
    return false;
  }
  const computed = Buffer.from(
    createHash("sha256").update(verifier, "ascii").digest("base64url"),
  );
  const expected = Buffer.from(challenge);
  return (
    computed.length === expected.length && timingSafeEqual(computed, expected)
  );
}

/** Resolves when `promise` settles or `ms` have passed, whichever is first. */
function settledWithin(promise: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    void promise.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Creates the grant manager. Opens nothing until `start` or a sign-on. */
export const createGrantManager: CreateGrantManager = ({
  mapepire,
  now = Date.now,
}) => {
  const store = createGrantStore();
  const throttle = createSignOnThrottle(config.oauth.signOnMaxFailures);
  const states = new Map<GrantId, GrantState>();
  /** Profiles that have signed on in this process: logged in clear. */
  const signedOn = new Set<string>();
  /**
   * Per profile, the reconnects answered OTHER or TIMEOUT since its last
   * sign-on that worked. Per profile, not per grant: every grant of a
   * profile may hold the same stale password, and each such answer may be a
   * failed sign-on on the IBM i.
   */
  const failedReconnects = new Map<string, number>();
  /** Sessions that are signed on and not yet a grant's. */
  const admitting = new Set<MapepireSession>();
  /** Sign-ons, reconnects and closing sockets: `shutdown` waits for them. */
  const underWay = new Set<Promise<unknown>>();
  // Reconnects and the sweep run here: an open socket and a timer keep the
  // async context they were created in alive.
  const scope = new AsyncResource("GrantManager");
  /** Sign-ons and reconnects whose connection is not yet a grant's. */
  let connecting = 0;
  let sweepTimer: NodeJS.Timeout | undefined;
  let stopped = false;

  // --- Log lines ------------------------------------------------------------

  function audit(
    level: "info" | "warning" | "error",
    event: string,
    fields: Record<string, unknown>,
  ): void {
    logger[level](
      {
        ...requestContextService.createRequestContext({
          operation: "OAuthGrant",
        }),
        event,
        ...fields,
      },
      event,
    );
  }

  /** The profile as a log line may carry it. */
  function who(profile: string): Record<string, unknown> {
    return signedOn.has(profile) ||
      config.oauth.allowedProfiles.includes(profile)
      ? { profile }
      : {
          profileFingerprint: throttle.fingerprint(profile),
          profileLength: profile.length,
        };
  }

  function about(grant: GrantRecord): Record<string, unknown> {
    return {
      profile: grant.profile,
      clientId: grant.clientId,
      destination: grant.redirectUri,
      address: grant.signOnAddress,
      grantId: grant.grantId,
      job: grant.session?.jobName,
    };
  }

  function refuse(
    event: string,
    reason: SignOnRefusal,
    fields: Record<string, unknown>,
  ): SignOnResult {
    audit("warning", event, { ...fields, reason });
    return { ok: false, reason };
  }

  // --- Connections and the end of a grant -----------------------------------

  /** Keeps `promise` in `underWay` until it settles. */
  function tracked<T>(promise: Promise<T>): Promise<T> {
    underWay.add(promise);
    void promise.finally(() => underWay.delete(promise));
    return promise;
  }

  /** Closes a session nothing waits for. */
  function closeSession(session: MapepireSession): void {
    void tracked(session.close());
  }

  function openConnections(): number {
    return store.all().filter((grant) => grant.session?.isOpen).length;
  }

  function accessTokenTtlMs(): number {
    return config.oauth.idleCloseMinutes * 60_000 + ACCESS_TOKEN_EXTRA_MS;
  }

  /** Follows a grant's connection: one that is lost leaves the grant without one. */
  function watch(grantId: GrantId, session: MapepireSession): void {
    session.onClose((reason) => {
      const grant = store.get(grantId);
      if (grant?.session !== session) {
        return;
      }
      grant.session = null;
      const fields = { ...about(grant), job: session.jobName };
      audit("warning", "connection_closed", { ...fields, reason });
      if (reason === "abandoned") {
        audit("warning", "statement_abandoned", fields);
      }
    });
  }

  /** Closes a grant's connection and keeps the grant. */
  function closeConnection(
    grant: GrantRecord,
    reason: "idle" | "no_pong",
  ): Promise<void> {
    const { session } = grant;
    if (!session) {
      return Promise.resolve();
    }
    audit("info", "connection_closed", { ...about(grant), reason });
    grant.session = null;
    return tracked(session.close());
  }

  /** What follows a grant's removal from the store. */
  function discard(grant: GrantRecord, reason: EndReason): Promise<void> {
    states.delete(grant.grantId);
    if (store.ofProfile(grant.profile).length === 0) {
      failedReconnects.delete(grant.profile);
    }
    audit("info", "grant_ended", { ...about(grant), reason });
    const { session } = grant;
    grant.session = null;
    return session ? tracked(session.close()) : Promise.resolve();
  }

  /**
   * The single way a grant ends: its ciphertext, wraps and replay record are
   * zero-filled, its token hashes deleted and its IBM i job closed.
   */
  function endGrant(grantId: GrantId, reason: EndReason): Promise<void> {
    const grant = store.remove(grantId);
    return grant ? discard(grant, reason) : Promise.resolve();
  }

  /**
   * Ends the grants of a profile whose sealed password is not known to be
   * newer than the one sealed while `passwordChangeDate` was the profile's.
   * Without a date on either side nothing is known, and the grant ends.
   */
  function endGrantsSealedBy(
    profile: string,
    passwordChangeDate: string | undefined,
    reason: EndReason,
  ): void {
    for (const grant of store.ofProfile(profile)) {
      if (
        passwordChangeDate === undefined ||
        grant.passwordChangeDate === undefined ||
        grant.passwordChangeDate === passwordChangeDate
      ) {
        void endGrant(grant.grantId, reason);
      }
    }
  }

  // --- Sign-on --------------------------------------------------------------

  /** A signed-on session becomes a grant, unless the profile is privileged. */
  async function admit(
    request: SignOnRequest,
    profile: string,
    grantId: GrantId,
    session: MapepireSession,
  ): Promise<SignOnResult> {
    const { clientId, redirectUri, address } = request;
    const fields = {
      profile,
      clientId,
      destination: redirectUri,
      address,
      grantId,
      job: session.jobName,
    };
    signedOn.add(profile);
    failedReconnects.delete(profile);

    let info: ProfileInfo | undefined;
    if (!stopped) {
      admitting.add(session);
      info = await readProfile(session, profile);
      admitting.delete(session);
    }
    if (!session.isOpen || stopped) {
      closeSession(session);
      return refuse("signon_unavailable", "unavailable", fields);
    }
    // An unreadable row is treated as a privileged profile.
    const privileged =
      !info || /\*(ALLOBJ|SECADM)(?![A-Z])/.test(info.specialAuthorities);
    if (privileged && !config.oauth.allowPrivilegedProfiles) {
      closeSession(session);
      return refuse("signon_refused_privileged", "privileged", fields);
    }

    const at = now();
    const created = store.createGrant(
      {
        grantId,
        profile,
        clientId,
        redirectUri,
        signOnAddress: address,
        createdAt: at,
        expiresAt: at + config.oauth.grantMaxHours * 3_600_000,
        lastUsedAt: at,
        session,
        passwordChangeDate: info?.passwordChangeDate,
      },
      request.password,
      request.codeChallenge,
      at,
    );
    if (!created) {
      closeSession(session);
      return refuse("signon_refused", "at_capacity", fields);
    }
    if (created.superseded) {
      void discard(created.superseded, "superseded");
    }
    states.set(grantId, {
      statements: 0,
      lastStatement: Promise.resolve(),
      reopenAsked: false,
      retryAfter: 0,
      lastPingAt: at,
      missedPongs: 0,
    });
    watch(grantId, session);
    // The password was changed since an earlier sign-on of the profile: what
    // that one sealed is stale, and would cost a rejected sign-on, and this
    // grant with it, at its next reconnect.
    for (const earlier of store.ofProfile(profile)) {
      if (
        info?.passwordChangeDate !== undefined &&
        earlier.passwordChangeDate !== undefined &&
        earlier.passwordChangeDate !== info.passwordChangeDate
      ) {
        void endGrant(earlier.grantId, "profile_changed");
      }
    }

    const code = created.code.toString("latin1");
    audit("info", "signon_ok", {
      ...fields,
      tokenHash: hashSecret(created.code).slice(0, 8),
    });
    zeroFill(created.code);
    return { ok: true, code, grantId };
  }

  async function attemptSignOn(request: SignOnRequest): Promise<SignOnResult> {
    const origin = {
      clientId: request.clientId,
      destination: request.redirectUri,
      address: request.address,
    };
    // The order is: profile filter, equal fields, throttle, syntax. The
    // syntax is judged first only to know what it will say.
    const checked = checkCredentials(request.profile, request.password);
    const profile = checked.ok
      ? checked.profile
      : request.profile.toString("latin1").toUpperCase();
    if (!isProfileAllowed(profile, config.oauth.allowedProfiles)) {
      return refuse("signon_refused", "profile_not_allowed", {
        ...origin,
        ...who(profile),
      });
    }
    // Nothing typed is logged on a syntax refusal: the profile field may
    // hold a mistyped password.
    if (!checked.ok && checked.reason === "password_is_profile") {
      return refuse("signon_refused_syntax", checked.reason, origin);
    }

    const decision = throttle.begin(profile, now(), signedOn.has(profile));
    if (decision !== "ok") {
      return refuse(
        decision === "blocked" ? "signon_blocked" : "signon_refused",
        decision,
        { ...origin, ...who(profile) },
      );
    }
    const grantId = randomBytes(16).toString("base64url");
    let outcome: SignOnOutcome = { class: "pre" };
    connecting++;
    try {
      try {
        if (!checked.ok) {
          return refuse("signon_refused_syntax", checked.reason, origin);
        }
        if (
          stopped ||
          // This sign-on is one of `connecting`.
          openConnections() + connecting > config.oauth.maxConnections ||
          (store.size >= MAX_GRANTS &&
            store.ofProfile(profile).length < MAX_GRANTS_PER_PROFILE)
        ) {
          return refuse("signon_refused", "at_capacity", origin);
        }
        outcome = await mapepire.signOn(profile, request.password, grantId);
      } finally {
        throttle.end(profile, outcome, now());
      }
      if (outcome.class === "ok") {
        return await admit(request, profile, grantId, outcome.session);
      }
      const fields = { ...origin, ...who(profile), grantId };
      switch (outcome.class) {
        case "mapepire":
          return refuse("signon_refused", "not_permitted", fields);
        case "rejected":
          return outcome.detail === "expired"
            ? refuse("signon_expired", "password_expired", fields)
            : outcome.detail === "disabled"
              ? refuse("signon_disabled", "profile_disabled", fields)
              : refuse("signon_rejected", "rejected", fields);
        case "timeout":
          return refuse("signon_timeout", "unavailable", fields);
        default:
          return refuse("signon_unavailable", "unavailable", fields);
      }
    } finally {
      connecting--;
    }
  }

  async function signOn(request: SignOnRequest): Promise<SignOnResult> {
    try {
      return await attemptSignOn(request);
    } catch {
      return refuse("signon_unavailable", "unavailable", {
        clientId: request.clientId,
        destination: request.redirectUri,
        address: request.address,
      });
    } finally {
      zeroFill(request.password);
    }
  }

  // --- Tokens ---------------------------------------------------------------

  function issued(tokens: TokenPair, at: number): TokenResult {
    const found = store.lookupToken(hashSecret(tokens.accessToken), at);
    return {
      ok: true,
      ...tokens,
      expiresInSeconds:
        found.status === "live"
          ? Math.floor((found.entry.expiresAt - at) / 1000)
          : 0,
    };
  }

  async function exchangeCode(
    request: CodeExchangeRequest,
  ): Promise<TokenResult> {
    const at = now();
    const hash = hashSecret(request.code);
    const found = store.lookupToken(hash, at);
    const entry =
      found.status === "live" && found.entry.kind === "code"
        ? found.entry
        : undefined;
    const grant = entry && store.get(entry.grantId);
    if (!entry || !grant) {
      return INVALID_GRANT;
    }
    const { address } = request;
    if (entry.redeemed) {
      void endGrant(grant.grantId, "code_replay");
      return INVALID_GRANT;
    }
    if (
      request.clientId !== grant.clientId ||
      (request.redirectUri !== undefined &&
        request.redirectUri !== grant.redirectUri) ||
      !pkceMatches(request.codeVerifier, entry.codeChallenge)
    ) {
      return INVALID_GRANT;
    }
    const fields = { ...about(grant), address, tokenHash: hash.slice(0, 8) };
    if (
      isLoopbackRedirect(grant.redirectUri) &&
      address !== grant.signOnAddress &&
      !(isLoopbackAddress(address) && isLoopbackAddress(grant.signOnAddress))
    ) {
      audit("warning", "signon_source_mismatch", {
        ...fields,
        signOnAddress: grant.signOnAddress,
        binding: config.oauth.codeAddressBinding,
      });
      if (config.oauth.codeAddressBinding === "strict") {
        void endGrant(grant.grantId, "signon_source_mismatch");
        return INVALID_GRANT;
      }
    }
    const redemption = store.redeemCode(request.code, accessTokenTtlMs(), at);
    if (redemption.status !== "issued") {
      return INVALID_GRANT;
    }
    audit("info", "code_exchanged", fields);
    return issued(redemption.tokens, at);
  }

  /** What a reconnect's one sign-on attempt led to. */
  function reconnected(
    grant: GrantRecord,
    state: GrantState,
    outcome: SignOnOutcome,
  ): void {
    const live = store.get(grant.grantId) === grant;
    const fields = about(grant);
    switch (outcome.class) {
      case "ok":
        failedReconnects.delete(grant.profile);
        if (!live) {
          closeSession(outcome.session);
          return;
        }
        grant.session = outcome.session;
        state.retryAfter = 0;
        // A request refused while this connection was opening asked for
        // it, not for the next one: after the next close, only a new
        // refusal reopens.
        state.reopenAsked = false;
        state.missedPongs = 0;
        state.lastPingAt = now();
        // A reopened connection gets a whole idle period: the grant's last
        // use is at least that old when its connection was closed as idle.
        grant.lastUsedAt = now();
        watch(grant.grantId, outcome.session);
        audit("info", "reconnect_ok", {
          ...fields,
          job: outcome.session.jobName,
        });
        return;
      case "rejected":
        // The stored password is stale for every grant of the profile that
        // sealed the same one: they all end here, so it costs one rejected
        // sign-on in total.
        audit("warning", "reconnect_rejected", {
          ...fields,
          detail: outcome.detail,
        });
        endGrantsSealedBy(
          grant.profile,
          grant.passwordChangeDate,
          "reconnect_rejected",
        );
        return;
      case "mapepire":
        audit("warning", "reconnect_unavailable", {
          ...fields,
          reason: "not_permitted",
        });
        void endGrant(grant.grantId, "reconnect_not_permitted");
        return;
      case "pre":
        audit("warning", "reconnect_unavailable", { ...fields, reason: "pre" });
        state.retryAfter = now() + RECONNECT_BACKOFF_MS.pre;
        return;
      default:
        audit("warning", "reconnect_unavailable", {
          ...fields,
          reason: outcome.class,
        });
        countFailedReconnect(grant, state);
    }
  }

  /**
   * A reconnect was forwarded and its result is not known: the stored
   * password may be why. The grants of the profile that sealed the same
   * password send it `MAX_FAILED_RECONNECTS` times between them, then end.
   */
  function countFailedReconnect(grant: GrantRecord, state: GrantState): void {
    const failed = (failedReconnects.get(grant.profile) ?? 0) + 1;
    if (failed >= MAX_FAILED_RECONNECTS) {
      failedReconnects.delete(grant.profile);
      endGrantsSealedBy(
        grant.profile,
        grant.passwordChangeDate,
        "reconnect_failed",
      );
    } else if (store.ofProfile(grant.profile).length > 0) {
      failedReconnects.set(grant.profile, failed);
      state.retryAfter = now() + RECONNECT_BACKOFF_MS.other;
    }
  }

  /** One sign-on attempt with the stored password. Never rejects. */
  async function reconnect(
    grant: GrantRecord,
    state: GrantState,
    password: Buffer,
  ): Promise<void> {
    let outcome: SignOnOutcome = { class: "pre" };
    try {
      outcome = await mapepire.signOn(grant.profile, password, grant.grantId);
    } catch {
      outcome = { class: "other" };
    } finally {
      zeroFill(password);
      throttle.end(grant.profile, outcome, now());
      connecting--;
      state.reconnect = undefined;
    }
    reconnected(grant, state, outcome);
  }

  /**
   * Starts the one reconnect of a grant without a connection: the presented
   * refresh token unwraps the grant key, which decrypts the password for one
   * sign-on. Returns at once.
   */
  function startReconnect(
    grant: GrantRecord,
    state: GrantState,
    refreshToken: Buffer,
    hash: string,
    at: number,
  ): void {
    const found = store.lookupToken(hash, at);
    const wrap = found.status === "live" ? found.entry.wrap : undefined;
    const key = wrap && unwrapKey(wrap, refreshToken, grant.grantId);
    const password = key && unseal(grant.ciphertext, key, grant.grantId);
    zeroFill(key);
    if (!password) {
      audit("error", "reconnect_unavailable", {
        ...about(grant),
        reason: "unsealing_failed",
      });
      return;
    }
    // A grant's profile has signed on in this process.
    const decision = throttle.begin(grant.profile, at, true);
    if (decision !== "ok") {
      zeroFill(password);
      audit("warning", "reconnect_unavailable", {
        ...about(grant),
        reason: decision,
      });
      return;
    }
    connecting++;
    state.reconnect = tracked(
      scope.runInAsyncScope(reconnect, undefined, grant, state, password),
    );
  }

  /**
   * Re-reads the profile's row on the grant's open connection: a profile no
   * longer enabled ends the grant, a changed password ends every grant of
   * the profile that was sealed before the change (their sealed passwords
   * are stale). It is the server's own statement and not a use of the
   * connection: a client that only refreshes is still closed as idle. Never
   * rejects.
   */
  async function probe(grant: GrantRecord): Promise<void> {
    let info: ProfileInfo | undefined;
    try {
      info = await runStatement(
        grant.grantId,
        undefined,
        (session) => readProfile(session, grant.profile),
        false,
      );
    } catch {
      return;
    }
    if (!info || store.get(grant.grantId) !== grant) {
      return;
    }
    if (info.status !== undefined && info.status !== "*ENABLED") {
      void endGrant(grant.grantId, "profile_disabled");
    } else if (
      info.passwordChangeDate !== undefined &&
      grant.passwordChangeDate !== undefined &&
      info.passwordChangeDate !== grant.passwordChangeDate
    ) {
      endGrantsSealedBy(
        grant.profile,
        grant.passwordChangeDate,
        "profile_changed",
      );
    }
  }

  async function refresh(request: RefreshRequest): Promise<TokenResult> {
    const { refreshToken } = request;
    const at = now();
    const hash = hashSecret(refreshToken);
    const found = store.lookupToken(hash, at);
    if (found.status === "retired") {
      void endGrant(found.grantId, "refresh_reuse");
      return INVALID_GRANT;
    }
    const grant =
      found.status === "live" ? store.get(found.entry.grantId) : undefined;
    const state = grant && states.get(grant.grantId);
    if (!grant || !state || grant.clientId !== request.clientId) {
      return INVALID_GRANT;
    }
    const fields = {
      ...about(grant),
      address: request.address,
      tokenHash: hash.slice(0, 8),
    };
    const open = grant.session?.isOpen === true;
    const reopen =
      !open && state.reopenAsked && !state.reconnect && at >= state.retryAfter;
    if (
      reopen &&
      openConnections() + connecting >= config.oauth.maxConnections
    ) {
      // Busy: nothing is rotated, the client retries.
      audit("warning", "reconnect_unavailable", {
        ...fields,
        reason: "at_capacity",
      });
      return RATE_LIMITED;
    }

    const rotation = store.rotate(refreshToken, accessTokenTtlMs(), at);
    switch (rotation.status) {
      case "rotated":
        audit("info", "token_refreshed", fields);
        break;
      case "replayed":
        audit("info", "refresh_replayed", fields);
        break;
      case "reuse":
        void endGrant(grant.grantId, "refresh_reuse");
        return INVALID_GRANT;
      case "rate_limited":
        return RATE_LIMITED;
      default:
        return INVALID_GRANT;
    }
    if (reopen) {
      state.reopenAsked = false;
      startReconnect(grant, state, refreshToken, hash, at);
    } else if (open && rotation.status === "rotated") {
      void probe(grant);
    }
    return issued(rotation.tokens, at);
  }

  async function revoke(token: Buffer): Promise<void> {
    const found = store.lookupToken(hashSecret(token), now());
    if (found.status === "live") {
      await endGrant(found.entry.grantId, "revoked");
    }
  }

  async function authenticate(
    bearer: string,
  ): Promise<GrantIdentity | AuthRefusal> {
    // Hashed as a string: a Buffer made of it would be a copy in the shared
    // Buffer pool, where nothing wipes it.
    const used = store.useAccessToken(hashSecret(bearer), now());
    if (!used) {
      return "invalid_token";
    }
    const { grant } = used;
    const state = states.get(grant.grantId);
    if (!grant.session?.isOpen && state?.reconnect) {
      await settledWithin(state.reconnect, RECONNECT_WAIT_MS);
    }
    if (store.get(grant.grantId) !== grant) {
      return "invalid_token";
    }
    if (!grant.session?.isOpen) {
      if (state) {
        state.reopenAsked = true;
      }
      return "connection_closed";
    }
    grant.lastUsedAt = now();
    return {
      profile: grant.profile,
      grantId: grant.grantId,
      clientId: grant.clientId,
      expiresAt: Math.floor(used.expiresAt / 1000),
    };
  }

  // --- Statements -----------------------------------------------------------

  /**
   * Runs `task` on the grant's connection, after the statements queued
   * before it.
   *
   * @param use - Whether it counts as a use of the connection, which
   *   postpones its idle close.
   */
  async function runStatement<T>(
    grantId: GrantId,
    context: RequestContext | undefined,
    task: (session: MapepireSession) => Promise<T>,
    use = true,
  ): Promise<T> {
    const state = states.get(grantId);
    if (!state) {
      throw new McpError(
        JsonRpcErrorCode.Unauthorized,
        "This sign-on has ended. Sign on again.",
      );
    }
    if (state.statements > STATEMENT_QUEUE_DEPTH) {
      throw new McpError(
        JsonRpcErrorCode.RateLimited,
        `${STATEMENT_QUEUE_DEPTH} statements are already waiting on this IBM i connection. Retry when they have finished.`,
      );
    }
    state.statements++;
    const previous = state.lastStatement;
    let finished!: () => void;
    state.lastStatement = new Promise((resolve) => (finished = resolve));
    try {
      await previous;
      const session = store.get(grantId)?.session;
      if (!session?.isOpen) {
        throw new McpError(
          JsonRpcErrorCode.Unauthorized,
          "The IBM i connection of this sign-on is closed. Refresh the access token and retry.",
        );
      }
      logger.debug(
        { ...context, grantId, job: session.jobName },
        "Running a statement on the grant's connection",
      );
      return await task(session);
    } finally {
      state.statements--;
      const grant = store.get(grantId);
      if (grant && use) {
        grant.lastUsedAt = now();
      }
      finished();
    }
  }

  function executeQuery<T = unknown>(
    grantId: GrantId,
    query: string,
    params?: BindingValue[],
    context?: RequestContext,
    rowsToFetch?: number,
  ): Promise<QueryResult<T>> {
    return runStatement(grantId, context, async (session) => {
      const result = await session.execute<T>(query, params, rowsToFetch);
      if (!result.is_done) {
        await session.closeStatement(result.id);
      }
      return result;
    });
  }

  function executeQueryWithPagination(
    grantId: GrantId,
    query: string,
    params?: BindingValue[],
    context?: RequestContext,
    fetchSize: number = DEFAULT_PAGE_SIZE,
  ): Promise<PaginatedQueryResult> {
    return runStatement(grantId, context, async (session) => {
      const first = await session.execute(query, params, fetchSize);
      const data = [...(first.data ?? [])];
      let result = first;
      try {
        while (!result.is_done && data.length < MAX_PAGINATION_ROWS) {
          result = await session.fetchMore(first.id, fetchSize);
          data.push(...(result.data ?? []));
        }
      } finally {
        if (!result.is_done) {
          await session.closeStatement(first.id);
        }
      }
      const truncated = !result.is_done || data.length > MAX_PAGINATION_ROWS;
      data.length = Math.min(data.length, MAX_PAGINATION_ROWS);
      return {
        data,
        success: result.success,
        sql_rc: result.sql_rc,
        execution_time: result.execution_time,
        metadata: first.metadata,
        truncated,
      };
    });
  }

  // --- Sweep ----------------------------------------------------------------

  /** Three pings in a row without a pong close the connection; the grant stays. */
  async function ping(
    grant: GrantRecord,
    state: GrantState,
    session: MapepireSession,
  ): Promise<void> {
    if (await session.ping()) {
      state.missedPongs = 0;
    } else if (
      grant.session === session &&
      ++state.missedPongs >= MAX_MISSED_PONGS
    ) {
      void closeConnection(grant, "no_pong");
    }
  }

  /** Ends what has expired, closes idle connections and pings the others. */
  function sweep(): void {
    const at = now();
    for (const grantId of store.sweep(at)) {
      const grant = store.get(grantId);
      void endGrant(
        grantId,
        grant && at >= grant.expiresAt ? "expired" : "code_expired",
      );
    }
    const idleMs = config.oauth.idleCloseMinutes * 60_000;
    for (const grant of store.all()) {
      const state = states.get(grant.grantId);
      const { session } = grant;
      if (!state || !session?.isOpen) {
        continue;
      }
      if (state.statements === 0 && at - grant.lastUsedAt >= idleMs) {
        void closeConnection(grant, "idle");
      } else if (at - state.lastPingAt >= PING_INTERVAL_MS) {
        state.lastPingAt = at;
        void ping(grant, state, session);
      }
    }
  }

  function startSweep(): NodeJS.Timeout {
    return setInterval(sweep, SWEEP_INTERVAL_MS).unref();
  }

  return {
    start() {
      sweepTimer ??= scope.runInAsyncScope(startSweep);
    },
    signOn: (request) => tracked(signOn(request)),
    exchangeCode,
    refresh,
    revoke,
    authenticate,
    executeQuery,
    executeQueryWithPagination,
    status: () => ({
      grants: store.size,
      openConnections: openConnections(),
      maxConnections: config.oauth.maxConnections,
      blockedProfiles: throttle.blocked,
    }),
    describeGrants: () =>
      store.all().map((grant) => ({
        grantId: grant.grantId,
        profile: grant.profile,
        clientId: grant.clientId,
        jobName: grant.session?.isOpen ? grant.session.jobName : undefined,
        createdAt: grant.createdAt,
        lastUsedAt: grant.lastUsedAt,
        expiresAt: grant.expiresAt,
      })),
    unblock(profile) {
      const unblocked = throttle.unblock(profile);
      if (unblocked) {
        audit("warning", "profile_unblocked", who(profile.toUpperCase()));
      }
      return unblocked;
    },
    async revokeByAdmin(target) {
      const byId = store.get(target);
      const grants = byId ? [byId] : store.ofProfile(target.toUpperCase());
      await Promise.all(
        grants.map((grant) => endGrant(grant.grantId, "admin")),
      );
      return grants.length;
    },
    async shutdown() {
      stopped = true;
      clearInterval(sweepTimer);
      // A sign-on or a reconnect whose connect is not answered holds a
      // socket that belongs to no grant yet.
      mapepire.abort();
      for (const session of admitting) {
        closeSession(session);
      }
      for (const grant of store.all()) {
        void endGrant(grant.grantId, "shutdown");
      }
      // Each ends soon after its socket has closed, and may start a close.
      while (underWay.size > 0) {
        await Promise.all(underWay);
      }
    },
  };
};

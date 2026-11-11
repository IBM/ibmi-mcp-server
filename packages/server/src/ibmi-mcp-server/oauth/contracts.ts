/**
 * @fileoverview Shared contracts of the built-in OAuth authorization server
 * (`MCP_AUTH_MODE=oauth` without `OAUTH_ISSUER_URL`): users sign on with
 * their IBM i profile and SQL runs on a Mapepire connection signed on as that
 * profile.
 *
 * Types and constants only. Each `*Api` interface and `Create*` type names
 * the exports of one module; the module exports each member under the same
 * name. Settings come from `config.oauth` (src/config/index.ts); every
 * function that depends on the time takes it as `now` (milliseconds since
 * the epoch).
 *
 * Secrets (password, grant key, authorization code and tokens as received
 * from a client) are `Buffer`s from `SealingApi.secretBuffer`, never strings,
 * and are zero-filled by whoever allocated them. None of them, and nothing
 * Mapepire answers to a sign-on, may appear in a log line, an error message
 * or a thrown error.
 *
 * Tests drive these modules against an in-process fake Mapepire server:
 * packages/server/tests/ibmi-mcp-server/oauth/fakeMapepire.ts.
 * @module src/ibmi-mcp-server/oauth/contracts
 */

import type {
  BindingValue,
  JDBCOptions,
  QueryMetaData,
  QueryResult,
} from "@ibm/mapepire-js";
import type { Hono } from "hono";
import type { HonoNodeBindings } from "@/mcp-server/transports/http/httpTypes.js";
import type { RequestContext } from "@/utils/internal/requestContext.js";
import type { SqlToolSecurityConfig } from "../schemas/index.js";

// ---------------------------------------------------------------------------
// Fixed values. Deliberately not settings.
// ---------------------------------------------------------------------------

/** Random bytes in an authorization code, access token or refresh token. */
export const TOKEN_BYTES = 32;
/** An authorization code is single-use and lives this long. */
export const AUTHORIZATION_CODE_TTL_MS = 60_000;
/**
 * An access token lives `OAUTH_IDLE_CLOSE_MINUTES` plus this, so a client
 * that refreshes by the clock does so before its first request after an idle
 * close.
 */
export const ACCESS_TOKEN_EXTRA_MS = 5 * 60_000;
/** How long the sign-in page's signed login request stays valid. */
export const LOGIN_REQUEST_TTL_MS = 10 * 60_000;
/** Times a previous refresh token may be answered with the same successor pair. */
export const REFRESH_REPLAY_LIMIT = 3;
/** A previous refresh token is retired this long after its successor access token is first used. */
export const REFRESH_RETIRE_AFTER_USE_MS = 60_000;
/** Most refresh rotations of one grant per window; beyond it the answer is 429. */
export const REFRESH_ROTATION_LIMIT = { count: 12, windowMs: 5 * 60_000 };

/** Grants per profile; one more ends the least recently used one. */
export const MAX_GRANTS_PER_PROFILE = 5;
/** Grants in total; at the limit no sign-on is forwarded. */
export const MAX_GRANTS = 1_000;
/** Statements of one grant waiting behind the one that is running. */
export const STATEMENT_QUEUE_DEPTH = 8;
/** A statement request unanswered for this long is abandoned and its socket closed. */
export const STATEMENT_TIMEOUT_MS = 120_000;
/** How long a request waits for a reconnect that is already in flight. */
export const RECONNECT_WAIT_MS = 25_000;
/** Earliest next reconnect after one that failed, by outcome class. */
export const RECONNECT_BACKOFF_MS = { pre: 15_000, other: 60_000 };

/** WebSocket handshake timeout of a sign-on. */
export const HANDSHAKE_TIMEOUT_MS = 10_000;
/** How long a sign-on waits for Mapepire's reply to `connect`. */
export const CONNECT_REPLY_TIMEOUT_MS = 20_000;
/** Sign-ons in flight across all profiles (one per profile). */
export const MAX_SIGNONS_IN_FLIGHT = 4;
/** Interval of WebSocket pings on an open grant socket. */
export const PING_INTERVAL_MS = 60_000;
/** Consecutive unanswered pings after which the socket is closed. */
export const MAX_MISSED_PONGS = 3;
/** A closing socket is terminated when it has not closed after this long. */
export const SOCKET_TERMINATE_AFTER_MS = 2_000;
/** Interval of the grant manager's sweep (expiry, idle close, pings). */
export const SWEEP_INTERVAL_MS = 30_000;

/** OTHER and TIMEOUT sign-on results that pause a profile, and for how long. */
export const SOFT_BUDGET = {
  failures: 2,
  windowMs: 30 * 60_000,
  pauseMs: 30 * 60_000,
};
/** Profiles the throttle tracks at once. */
export const THROTTLE_MAX_PROFILES = 10_000;

/** Prefix of a `client_id` issued by `POST /oauth/register`. */
export const SELF_CLIENT_ID_PREFIX = "self.";
/** Longest `client_id` accepted, in bytes. */
export const MAX_CLIENT_ID_BYTES = 1024;
/** Most redirect URIs one registration keeps. */
export const MAX_CLIENT_REDIRECT_URIS = 5;

/**
 * Paths of the authorization server. `/oauth/*` are served under the path of
 * the issuer (`config.oauth.issuer`); the metadata is at the RFC 8414
 * path-inserted location, so with issuer `https://h/ibmi`:
 *
 * - `GET  /.well-known/oauth-authorization-server/ibmi`
 * - `GET  /ibmi/oauth/authorize`, `POST /ibmi/oauth/authorize`
 * - `POST /ibmi/oauth/token`
 * - `POST /ibmi/oauth/revoke`
 * - `POST /ibmi/oauth/register`
 *
 * and with issuer `https://h` the same without `/ibmi`.
 */
export const OAUTH_PATHS = {
  metadata: "/.well-known/oauth-authorization-server",
  authorize: "/oauth/authorize",
  token: "/oauth/token",
  revoke: "/oauth/revoke",
  register: "/oauth/register",
} as const;

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

/**
 * Identifies one sign-on: 16 random bytes, base64url. Not a secret. It is in
 * log lines, in `AuthInfo`, and in the IBM i job's client application name
 * (`ibmi-mcp/<grantId>`).
 */
export type GrantId = string;

/**
 * What `executeQueryWithPagination` of the connection pools returns; the
 * grant manager and the query router return the same.
 */
export interface PaginatedQueryResult {
  data: unknown[];
  success: boolean;
  sql_rc?: unknown;
  execution_time?: number;
  metadata?: QueryMetaData;
  /** Whether the result stopped at `IBMI_PAGINATION_MAX_ROWS`. */
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// a. Mapepire session client: oauth/mapepireSession.ts
// ---------------------------------------------------------------------------

/** How the Mapepire server's certificate is verified. */
export type MapepireTrust =
  /** `DB2i_SERVER_CERT_FILE`: this exact certificate, host name not checked. */
  | { kind: "pin"; pem: Buffer }
  /** `DB2i_CA_FILE`: a CA bundle, host name checked. */
  | { kind: "ca"; pem: Buffer }
  /** Node's trust store, host name checked. */
  | { kind: "default" }
  /** `DB2i_IGNORE_UNAUTHORIZED=true`: neither certificate nor host name is checked. */
  | { kind: "unverified" };

/** The one Mapepire server grant connections go to. From configuration only. */
export interface MapepireTarget {
  host: string;
  port: number;
  trust: MapepireTrust;
  /** `DB2i_JDBC_OPTIONS`, already checked against the allowlist. */
  jdbcOptions?: JDBCOptions;
}

/** Why a session's socket is no longer open. */
export type SessionCloseReason =
  /** `close()` was called. */
  | "closed"
  /** The peer closed it, or it failed. */
  | "lost"
  /** A statement request went unanswered for `STATEMENT_TIMEOUT_MS`. */
  | "abandoned";

/**
 * One open Mapepire WebSocket signed on as one profile, and the only thing
 * that ever holds that socket. It keeps no user name and no password, and can
 * send only: `sql`, `prepare_sql_execute`, `sqlmore`, `sqlclose`, `exit` and
 * WebSocket pings.
 *
 * It does not queue: the grant manager runs one statement at a time on it.
 */
export interface MapepireSession {
  /** The IBM i job the connect reply named, e.g. `123456/QUSER/QZDASOINIT`. */
  readonly jobName: string;
  /** Whether the socket is open. */
  readonly isOpen: boolean;
  /**
   * Runs a statement and resolves to its first page, in the shape the tools
   * consume from the pools today. When `is_done` is false the cursor stays
   * open under `id`: fetch from it with `fetchMore`, then `closeStatement`.
   *
   * @param rowsToFetch - Rows in this page. Default: Mapepire's own (100).
   * @throws {McpError} `DatabaseError` with the IBM i message when the
   *   statement fails; `Timeout` naming the job when it is abandoned (the
   *   socket is then closed with reason `abandoned`); `ServiceUnavailable`
   *   when the socket is not open or is lost before the reply.
   */
  execute<T = unknown>(
    sql: string,
    params?: BindingValue[],
    rowsToFetch?: number,
  ): Promise<QueryResult<T>>;
  /**
   * The next page of a statement `execute` left open.
   *
   * @param statementId - `id` of the result `execute` resolved to.
   * @throws {McpError} As `execute`.
   */
  fetchMore<T = unknown>(
    statementId: string,
    rowsToFetch?: number,
  ): Promise<QueryResult<T>>;
  /** Releases a statement's cursor. Never rejects. */
  closeStatement(statementId: string): Promise<void>;
  /**
   * Sends a WebSocket ping. Resolves to whether the pong arrived within
   * `HANDSHAKE_TIMEOUT_MS`. Never rejects.
   */
  ping(): Promise<boolean>;
  /**
   * Sends `exit` and closes the socket, terminating it after
   * `SOCKET_TERMINATE_AFTER_MS`. Resolves when it is closed. Idempotent;
   * never rejects.
   */
  close(): Promise<void>;
  /**
   * Registers the one listener told that the socket is no longer open.
   * Called once per session, whatever the reason. A later call replaces the
   * listener.
   */
  onClose(listener: (reason: SessionCloseReason) => void): void;
}

/** Why a rejected sign-on was rejected, where an English JVM says so. */
export type RejectionDetail = "expired" | "disabled";

/**
 * The result of one sign-on attempt. The classes are structural: Mapepire's
 * text is matched in memory only and is never logged, returned or thrown.
 */
export type SignOnOutcome =
  /** Signed on. The session's socket is open. */
  | { class: "ok"; session: MapepireSession }
  /** No WebSocket opened (TCP, TLS, pin, upgrade): no sign-on happened. */
  | { class: "pre" }
  /** Mapepire itself refused before any IBM i sign-on. */
  | { class: "mapepire" }
  /** The IBM i rejected the sign-on. Counts against the hard budget unless `detail` is set. */
  | { class: "rejected"; detail?: RejectionDetail }
  /** The socket opened and an error came back that matches no pattern. */
  | { class: "other" }
  /** The socket opened and no reply came within `CONNECT_REPLY_TIMEOUT_MS`. */
  | { class: "timeout" };

/** `SignOnOutcome["class"]`. */
export type SignOnClass = SignOnOutcome["class"];

/** The client for grant connections. Never mapepire-js. */
export interface MapepireClient {
  /**
   * Signs on: exactly one WebSocket connect to the target, carrying the
   * credentials in the upgrade request, and one `connect` request with
   * `application: "ibmi-mcp/<grantId>"` and, as its properties,
   * `prompt=false` followed by the target's JDBC options. One call is one
   * IBM i sign-on attempt; nothing is retried. The Mapepire version is never
   * asked for.
   *
   * @param profile - Upper-case profile name that passed the syntax check.
   * @param password - Read, never kept, never modified: the caller zero-fills it.
   * @returns The outcome. Never rejects.
   */
  signOn(
    profile: string,
    password: Buffer,
    grantId: GrantId,
  ): Promise<SignOnOutcome>;
  /**
   * Cuts the socket of every sign-on that has not finished; each then
   * resolves `pre` or `other`. For shutdown.
   */
  abort(): void;
}

/** `createMapepireClient` of oauth/mapepireSession.ts. Opens nothing. */
export type CreateMapepireClient = (target: MapepireTarget) => MapepireClient;

// ---------------------------------------------------------------------------
// b. Sealing: oauth/sealing.ts
// ---------------------------------------------------------------------------

/** An access token and a refresh token, each as the bytes a client is sent. */
export interface TokenPair {
  accessToken: Buffer;
  refreshToken: Buffer;
}

/**
 * The envelope that keeps a password as ciphertext the server cannot open
 * alone. node:crypto only. Every `Buffer` returned is from `secretBuffer`
 * and the caller's to zero-fill; no input is modified or kept. A "secret" is an
 * authorization code or a token as its base64url text in ASCII bytes, which
 * is what clients present.
 */
export interface SealingApi {
  /**
   * A Buffer for a secret: unpooled (`Buffer.allocUnsafeSlow`) and, whatever
   * its length, with its bytes outside the V8 heap, so that zero-filling it
   * wipes the only copy. Its content is not initialised.
   */
  secretBuffer(bytes: number): Buffer;
  /**
   * A new authorization code, access token or refresh token: `TOKEN_BYTES`
   * random bytes, base64url without padding, as ASCII bytes.
   */
  newSecret(): Buffer;
  /**
   * Hex SHA-256 of a secret: the only form in which one is stored. A string
   * (the bearer of a request header) is hashed as its Latin-1 bytes.
   */
  hashSecret(secret: Buffer | string): string;
  /**
   * Encrypts the password under a new random 32-byte key: AES-256-GCM,
   * random 12-byte nonce, additional data `pw|<grantId>`.
   */
  seal(password: Buffer, grantId: GrantId): { ciphertext: Buffer; key: Buffer };
  /** The password, or `undefined` when the key or grant does not match. */
  unseal(ciphertext: Buffer, key: Buffer, grantId: GrantId): Buffer | undefined;
  /**
   * Encrypts the grant key under HKDF-SHA256(secret, salt `grantId`, info
   * `wrap`) with AES-256-GCM.
   */
  wrapKey(key: Buffer, secret: Buffer, grantId: GrantId): Buffer;
  /** The grant key, or `undefined` when the secret or grant does not match. */
  unwrapKey(wrap: Buffer, secret: Buffer, grantId: GrantId): Buffer | undefined;
  /**
   * The replay record of a rotation: the successor pair encrypted under
   * HKDF-SHA256(previous refresh token, salt `grantId`, info `replay`).
   */
  sealReplay(
    successor: TokenPair,
    previousRefreshToken: Buffer,
    grantId: GrantId,
  ): Buffer;
  /** The successor pair, or `undefined` when the token or grant does not match. */
  openReplay(
    record: Buffer,
    previousRefreshToken: Buffer,
    grantId: GrantId,
  ): TokenPair | undefined;
  /** Overwrites each buffer with zeros. */
  zeroFill(...buffers: Array<Buffer | undefined>): void;
}

// ---------------------------------------------------------------------------
// c. Grant store: oauth/grantStore.ts
// ---------------------------------------------------------------------------

/**
 * One sign-on. Held in process memory only. The store owns the map; the
 * grant manager mutates the fields that are not `readonly`.
 */
export interface GrantRecord {
  readonly grantId: GrantId;
  /** Upper-case profile. In clear here because it has signed on. */
  readonly profile: string;
  readonly clientId: string;
  readonly redirectUri: string;
  /** Client address of the sign-on, normalised. */
  readonly signOnAddress: string;
  readonly createdAt: number;
  /** Absolute end: `createdAt` + `OAUTH_GRANT_MAX_HOURS`. */
  readonly expiresAt: number;
  /** Last request on the MCP endpoint, sign-on or reconnect. Decides idle close and which grant is superseded. */
  lastUsedAt: number;
  /** The sealed password. Zero-filled when the grant is removed. */
  ciphertext: Buffer;
  /** The open connection, or `null` between an idle close and the next refresh. */
  session: MapepireSession | null;
  /** `PASSWORD_CHANGE_DATE` of the profile as read at sign-on: of the password that is sealed. */
  passwordChangeDate?: string;
  /** Hash of the current refresh token, once the code is exchanged. */
  refreshHash?: string;
  /** Hash of the previous refresh token, until it is retired. */
  previousRefreshHash?: string;
}

/** What a stored secret is. */
export type TokenKind = "code" | "at" | "rt" | "rt_prev";

/** One entry of the token index, keyed by `SealingApi.hashSecret`. Mutable. */
export interface TokenEntry {
  grantId: GrantId;
  kind: TokenKind;
  expiresAt: number;
  /** `code`, `rt`, `rt_prev`: the grant key wrapped under this secret. */
  wrap?: Buffer;
  /** `rt_prev`: the replay record of the rotation that replaced it. */
  replay?: Buffer;
  /** `rt_prev`: times the replay record has been returned. */
  replays?: number;
  /** `code`: the PKCE S256 challenge. */
  codeChallenge?: string;
  /**
   * `code`: set when it is exchanged. The entry stays until it expires so
   * that a second presentation is recognised.
   */
  redeemed?: boolean;
  /** `at`: when it was first used on the MCP endpoint. */
  firstUsedAt?: number;
}

/** What a presented secret turned out to be. */
export type TokenLookup =
  | { status: "live"; entry: TokenEntry }
  /** A refresh token of a live grant that was rotated out. */
  | { status: "retired"; grantId: GrantId }
  /** Never issued, expired, or of a grant that has ended. */
  | { status: "unknown" };

/**
 * The grants and the token index. Plain maps; no I/O, no timers, no clock.
 *
 * These are the primitives. The rules of a grant's life (the single-use
 * code, refresh rotation with its replay record, rate cap and retirement)
 * are the methods `createGrantStore` adds on top: `GrantLifecycleStore` of
 * oauth/grantStore.ts. The grant manager calls those, never `putToken`.
 */
export interface GrantStore {
  /** Number of grants. */
  readonly size: number;
  /**
   * Adds a grant. When its profile already has `MAX_GRANTS_PER_PROFILE`, the
   * least recently used of them is removed first (as `remove` does) and
   * returned as `superseded` for the caller to close and audit.
   *
   * @returns `added: false`, and nothing changed, when the store holds
   *   `MAX_GRANTS` and nothing was superseded.
   */
  add(grant: GrantRecord): { added: boolean; superseded?: GrantRecord };
  get(grantId: GrantId): GrantRecord | undefined;
  /** The grants of one profile. */
  ofProfile(profile: string): GrantRecord[];
  all(): GrantRecord[];
  /**
   * Removes a grant, every token entry of it and its retired hashes, and
   * zero-fills its ciphertext, wraps and replay record. The record is
   * returned with `session` untouched: closing it is the caller's part.
   */
  remove(grantId: GrantId): GrantRecord | undefined;
  /** Adds or replaces a token entry. */
  putToken(hash: string, entry: TokenEntry): void;
  /**
   * Looks a secret's hash up. An entry past `expiresAt` is not live; a
   * previous refresh token past it is retired by the lookup.
   */
  lookupToken(hash: string, now: number): TokenLookup;
  /**
   * Removes a refresh token entry, zero-fills its wrap and replay record,
   * and remembers the hash as retired for as long as its grant exists.
   */
  retireToken(hash: string): void;
  /**
   * Drops expired token entries (an expired `rt_prev` is retired) and
   * returns the grants the caller must end: those past `expiresAt` and
   * those whose authorization code expired without being exchanged. It
   * removes no grant itself.
   */
  sweep(now: number): GrantId[];
}

/** `createGrantStore` of oauth/grantStore.ts; it returns a `GrantLifecycleStore`. */
export type CreateGrantStore = () => GrantStore;

// ---------------------------------------------------------------------------
// d. Policy: oauth/throttle.ts, oauth/clients.ts, oauth/credentialSyntax.ts
// ---------------------------------------------------------------------------

/** Whether a sign-on for a profile may be forwarded to the IBM i now. */
export type ThrottleDecision =
  | "ok"
  /**
   * With no success between: `OAUTH_SIGNON_MAX_FAILURES` rejections, or twice
   * that many sign-ons that were rejected or whose result is not known. Until
   * unblocked or restarted.
   */
  | "blocked"
  /** `SOFT_BUDGET` used up: for `SOFT_BUDGET.pauseMs`. */
  | "paused"
  /** A sign-on for this profile, or `MAX_SIGNONS_IN_FLIGHT` in all, is in flight. */
  | "busy";

/**
 * Per-profile sign-on budgets, shared by the sign-in page and reconnects.
 * State is keyed by `fingerprint`, never by the profile as typed, and capped
 * at `THROTTLE_MAX_PROFILES` entries: at the cap only a profile that holds
 * nothing countable is forgotten, and when there is none only a profile that
 * has signed on in this process gets an entry beyond the cap.
 */
export interface SignOnThrottle {
  /**
   * HMAC-SHA256 of the profile under a random per-process key, hex. What log
   * lines carry for a profile that has not signed on.
   */
  fingerprint(profile: string): string;
  /**
   * Asks for the profile's one sign-on slot. `ok` takes it, and must be
   * followed by exactly one `end`.
   *
   * @param signedOn - Whether the profile has signed on in this process: it
   *   is then never refused `busy` for want of room in the table.
   */
  begin(profile: string, now: number, signedOn?: boolean): ThrottleDecision;
  /**
   * Gives the slot back and counts the outcome: `ok` clears the hard counts;
   * `rejected` without `detail` adds to the rejections (no time refill);
   * `other` and `timeout` (the sign-on was forwarded and its result is not
   * known) add to the soft budget and, with no time refill, to the sign-ons
   * that block at twice `OAUTH_SIGNON_MAX_FAILURES`; `pre`, `mapepire` and
   * `rejected` with a `detail` count nothing.
   */
  end(
    profile: string,
    outcome: { class: SignOnClass; detail?: RejectionDetail },
    now: number,
  ): void;
  /**
   * Clears a blocked profile's hard counts, its soft failures and its pause.
   * Returns whether it was blocked.
   */
  unblock(profile: string): boolean;
  /** Number of profiles that are blocked. */
  readonly blocked: number;
}

/** `createSignOnThrottle` of oauth/throttle.ts. */
export type CreateSignOnThrottle = (maxFailures: number) => SignOnThrottle;

/** Why typed credentials are not forwarded. Nothing typed is logged. */
export type CredentialRefusal =
  | "profile_syntax"
  | "password_syntax"
  | "password_is_profile";

/** `checkCredentials` and `isProfileAllowed` of oauth/credentialSyntax.ts. */
export interface CredentialSyntaxApi {
  /**
   * Checks the form fields as bytes, without making a string of the
   * password.
   *
   * - Profile: upper-cased, then `^[A-Z0-9#$_]{1,10}$`, not starting with a
   *   digit (jt400 would sign on as `Q` plus the digits).
   * - Password: 1 to 128 bytes, each 0x20 to 0x7E, no `;`, no `"`, no
   *   trailing `\`, no leading or trailing space. These rules stop
   *   injection into the JDBC URL Mapepire builds. Also no `:` and no `%`
   *   (mapepire-server before 2.3.6 would sign on with a different
   *   password) and no leading `*` (a special value to jt400).
   * - A password equal to the profile, ignoring case, is refused.
   *
   * @returns The upper-case profile, or the first rule that failed.
   */
  checkCredentials(
    profile: Buffer,
    password: Buffer,
  ): { ok: true; profile: string } | { ok: false; reason: CredentialRefusal };
  /**
   * `OAUTH_ALLOWED_PROFILES`: with an empty list, every profile not starting
   * with `Q`; otherwise only profiles the list names exactly or by a
   * `PREFIX*` entry.
   *
   * @param allowedProfiles - `config.oauth.allowedProfiles`.
   */
  isProfileAllowed(
    profile: string,
    allowedProfiles: readonly string[],
  ): boolean;
}

/** Where an authorization code may be sent: `config.oauth`. */
export interface RedirectPolicy {
  /** `OAUTH_ALLOW_LOOPBACK_REDIRECTS`. */
  allowLoopbackRedirects: boolean;
  /** `OAUTH_REDIRECT_URIS`. */
  redirectUris: readonly string[];
}

/**
 * A public client, known only by what its `client_id` says. Never fetched,
 * never stored, never verified: the sign-in page shows it as unverified.
 */
export type OAuthClient =
  /** `self.<base64url of {name, redirect_uris}>`, from registration. */
  | { kind: "self"; clientId: string; name?: string; redirectUris: string[] }
  /** Any `https://` URL (Client ID Metadata Document style). */
  | { kind: "url"; clientId: string };

/** The RFC 7591 response to a registration. */
export interface ClientRegistration {
  client_id: string;
  client_name?: string;
  /** The requested URIs that are allowed destinations. */
  redirect_uris: string[];
  token_endpoint_auth_method: "none";
  grant_types: ["authorization_code", "refresh_token"];
  response_types: ["code"];
}

/**
 * `parseClientId`, `isLoopbackRedirect`, `isRedirectAllowed` and
 * `registerClient` of oauth/clients.ts. The module also exports
 * `describeClient`: what the sign-in page shows of a client.
 */
export interface ClientsApi {
  /** Reads a `client_id` in one of the two accepted forms. */
  parseClientId(clientId: string): OAuthClient | undefined;
  /**
   * Whether a URI is a loopback destination: scheme `http`, host exactly
   * `localhost`, `127.0.0.1` or `[::1]`, any port, any path, no userinfo, no
   * fragment.
   */
  isLoopbackRedirect(redirectUri: string): boolean;
  /**
   * The destination rule, on parsed URL components: the URI is a loopback
   * destination and those are allowed, or it is exactly an entry of
   * `OAUTH_REDIRECT_URIS`. For a `self` client it must also be one of the
   * URIs in its id (a loopback URI matches whatever the port).
   */
  isRedirectAllowed(
    client: OAuthClient,
    redirectUri: string,
    policy: RedirectPolicy,
  ): boolean;
  /**
   * Handles a `POST /oauth/register` body: keeps the redirect URIs that are
   * allowed destinations (at most `MAX_CLIENT_REDIRECT_URIS`), drops the
   * rest and returns the reduced list under a `self.` client id.
   *
   * @returns `invalid_redirect_uri` when none survives,
   *   `invalid_client_metadata` when the body is not a registration or the
   *   id would exceed `MAX_CLIENT_ID_BYTES`.
   */
  registerClient(
    metadata: unknown,
    policy: RedirectPolicy,
  ):
    | ClientRegistration
    | { error: "invalid_redirect_uri" | "invalid_client_metadata" };
}

// ---------------------------------------------------------------------------
// e. Grant manager: oauth/grantManager.ts
// ---------------------------------------------------------------------------

/** The sign-in form, after the route's own checks. */
export interface SignOnRequest {
  /** The profile field as typed, percent-decoded. */
  profile: Buffer;
  /** The password field, percent-decoded. The caller zero-fills it. */
  password: Buffer;
  /** Validated by the route with `ClientsApi`. */
  clientId: string;
  redirectUri: string;
  /** PKCE S256 challenge: `^[A-Za-z0-9_-]{43}$`. */
  codeChallenge: string;
  /** From `verifiedClientAddress`, inside `OAUTH_SIGNON_ALLOWED_CIDRS`. */
  address: string;
}

/** Why a sign-on produced no authorization code. Each has its own page text. */
export type SignOnRefusal =
  /** Profile or password has a shape that cannot sign on. Nothing counted. */
  | CredentialRefusal
  | "profile_not_allowed"
  /** The throttle: see `ThrottleDecision`. */
  | "blocked"
  | "paused"
  | "busy"
  /** `MAX_GRANTS` or `OAUTH_MAX_CONNECTIONS` reached. */
  | "at_capacity"
  /** `pre`, `other` or `timeout`. */
  | "unavailable"
  /** `mapepire`: the profile is not permitted through Mapepire. */
  | "not_permitted"
  /** `rejected`: sign-on not accepted. */
  | "rejected"
  | "password_expired"
  | "profile_disabled"
  /** Holds *ALLOBJ or *SECADM (or that could not be read) and `OAUTH_ALLOW_PRIVILEGED_PROFILES` is off. */
  | "privileged";

/** What the sign-in route does next. */
export type SignOnResult =
  /** Redirect to the client with this code (base64url text). */
  | { ok: true; code: string; grantId: GrantId }
  | { ok: false; reason: SignOnRefusal };

/** `grant_type=authorization_code` at the token endpoint. */
export interface CodeExchangeRequest {
  /** The code as received. The caller zero-fills it. */
  code: Buffer;
  codeVerifier: string;
  clientId: string;
  /**
   * When the client sent one, it must be the redirect URI of the sign-on.
   * A client that follows OAuth 2.1 sends none: PKCE took its place.
   */
  redirectUri?: string;
  /** From `verifiedClientAddress`. */
  address: string;
}

/** `grant_type=refresh_token` at the token endpoint. */
export interface RefreshRequest {
  /** The refresh token as received. The caller zero-fills it. */
  refreshToken: Buffer;
  clientId: string;
  /** From `verifiedClientAddress`. */
  address: string;
}

/** The answer of the token endpoint. */
export type TokenResult =
  /** The caller writes both tokens to the response as bytes, then zero-fills them. */
  | ({ ok: true; expiresInSeconds: number } & TokenPair)
  /** `invalid_grant` is HTTP 400; `rate_limited` is HTTP 429. */
  | { ok: false; error: "invalid_grant" | "rate_limited" };

/** Who an access token speaks for. */
export interface GrantIdentity {
  profile: string;
  grantId: GrantId;
  clientId: string;
  /** When the access token expires, in seconds since the epoch. */
  expiresAt: number;
}

/**
 * Why an access token is refused. Both are a 401 `invalid_token`;
 * `connection_closed` carries the error description
 * `CONNECTION_CLOSED_DESCRIPTION`, on which a client refreshes.
 */
export type AuthRefusal = "invalid_token" | "connection_closed";

/** `error_description` of the 401 that asks a client to refresh. */
export const CONNECTION_CLOSED_DESCRIPTION = "connection closed, refresh";

/**
 * What the resource-server strategy puts in `AuthInfo` for a grant:
 * `token: GRANT_TOKEN_PREFIX + grantId` (never the bearer), `clientId`, and
 * this as `extra`. The query router reads `extra.grantId`.
 */
export interface GrantAuthExtra {
  /** The profile. */
  subject: string;
  grantId: GrantId;
}

/** Prefix of `AuthInfo.token` for a grant. */
export const GRANT_TOKEN_PREFIX = "grant:";

/** Counts for `/healthz` and the admin socket. Names no profile. */
export interface GrantManagerStatus {
  grants: number;
  openConnections: number;
  /** `OAUTH_MAX_CONNECTIONS`. */
  maxConnections: number;
  blockedProfiles: number;
}

/** One grant as the admin socket's `status` lists it. */
export interface GrantSummary {
  grantId: GrantId;
  profile: string;
  clientId: string;
  /** The IBM i job while a connection is open. */
  jobName?: string;
  createdAt: number;
  lastUsedAt: number;
  expiresAt: number;
}

/**
 * The one facade over sessions, sealing, the store and the policy. The
 * sign-in and token routes, the resource-server strategy, the query router
 * and the admin socket call nothing else.
 */
export interface GrantManager {
  /**
   * Starts the sweep timer; contacts nothing. Sockets, listeners and timers
   * are created in an async scope of the manager's own, never in a
   * request's.
   */
  start(): void;
  /**
   * Handles a submitted sign-in form: credential syntax, profile filter,
   * throttle, then exactly one `MapepireClient.signOn`. On
   * success it checks the profile's special authorities, seals the password,
   * stores the grant (superseding at the per-profile cap) and issues the
   * code. Never rejects.
   */
  signOn(request: SignOnRequest): Promise<SignOnResult>;
  /**
   * Redeems a code once: PKCE, client, redirect URI when sent, and (for a loopback
   * redirect, per `OAUTH_CODE_ADDRESS_BINDING`) the address. A code
   * presented twice ends its grant. No IBM i contact. Never rejects.
   */
  exchangeCode(request: CodeExchangeRequest): Promise<TokenResult>;
  /**
   * Rotates the refresh token, or replays the successor pair for the
   * previous one; a retired one ends its grant. Reopens the grant's
   * connection when it has none and `authenticate` answered
   * `connection_closed` since it closed, without delaying the answer.
   * Never rejects.
   */
  refresh(request: RefreshRequest): Promise<TokenResult>;
  /**
   * RFC 7009: ends the grant an access or refresh token belongs to. An
   * unknown token is not an error. The caller zero-fills `token`.
   */
  revoke(token: Buffer): Promise<void>;
  /**
   * Resolves an access token from the `Authorization` header. Waits up to
   * `RECONNECT_WAIT_MS` for a reconnect in flight. `connection_closed` lets
   * the grant's next refresh reconnect. Never rejects.
   */
  authenticate(bearer: string): Promise<GrantIdentity | AuthRefusal>;
  /**
   * `executeQuery` of the pools, on the grant's connection. One statement
   * at a time per grant, `STATEMENT_QUEUE_DEPTH` waiting.
   *
   * @throws {McpError} `Unauthorized` when the grant does not exist or has
   *   no open connection; otherwise as `MapepireSession.execute`.
   */
  executeQuery<T = unknown>(
    grantId: GrantId,
    query: string,
    params?: BindingValue[],
    context?: RequestContext,
    rowsToFetch?: number,
  ): Promise<QueryResult<T>>;
  /**
   * `executeQueryWithPagination` of the pools, on the grant's connection:
   * fetches until done or `IBMI_PAGINATION_MAX_ROWS`.
   *
   * @throws {McpError} As `executeQuery`.
   */
  executeQueryWithPagination(
    grantId: GrantId,
    query: string,
    params?: BindingValue[],
    context?: RequestContext,
    fetchSize?: number,
  ): Promise<PaginatedQueryResult>;
  status(): GrantManagerStatus;
  /** Admin socket `status`: every grant. */
  describeGrants(): GrantSummary[];
  /** Admin socket `unblock <profile>`. Returns whether it was blocked. */
  unblock(profile: string): boolean;
  /**
   * Admin socket `revoke <profile|grantId>`. Returns the number of grants
   * ended.
   */
  revokeByAdmin(target: string): Promise<number>;
  /**
   * Stops the sweep timer, ends every grant and cuts every sign-on and
   * reconnect under way. Resolves when every socket is closed.
   */
  shutdown(): Promise<void>;
}

/**
 * `createGrantManager` of oauth/grantManager.ts. The rest comes from
 * `config.oauth`.
 */
export type CreateGrantManager = (dependencies: {
  mapepire: MapepireClient;
  /** Default: `Date.now`. */
  now?: () => number;
}) => GrantManager;

// ---------------------------------------------------------------------------
// f. Authorization server app: oauth/authorizationServer.ts
// ---------------------------------------------------------------------------

/** The routes of the built-in authorization server. */
export interface AuthorizationServer {
  /**
   * Serves the paths below and nothing else. The HTTP transport mounts it
   * on its own app with `app.route("/", ...)`, after Host validation, CORS
   * and the per-address rate limit. `hono/secure-headers` must not cover
   * `paths.authorize`: the page sets its own headers.
   */
  app: Hono<{ Bindings: HonoNodeBindings }>;
  /** The full path of each `OAUTH_PATHS` entry for `config.oauth.issuer`. */
  paths: Record<keyof typeof OAUTH_PATHS, string>;
}

/**
 * `createAuthorizationServer` of oauth/authorizationServer.ts. Reads
 * `config` (issuer, resource URL, redirect policy, allowed sign-on
 * addresses, the IBM i host shown on the page).
 */
export type CreateAuthorizationServer = (
  grants: GrantManager,
) => AuthorizationServer;

// ---------------------------------------------------------------------------
// g. Query routing: services/queryRouter.ts
// ---------------------------------------------------------------------------

/** What a routed statement needs besides its SQL. */
export interface QueryRouteOptions {
  /**
   * The YAML source a tool names. Built-in tools pass none and run on the
   * `DB2i_*` service pool. Ignored in built-in OAuth mode: there is one IBM
   * i, and the caller's own connection to it.
   */
  source?: string;
  /** Validated against the statement before it runs, in every mode. */
  securityConfig?: SqlToolSecurityConfig;
  /** Rows per fetch: the one page of `executeQuery`, each page of the paginated form. */
  rowsToFetch?: number;
}

/** The part of the grant manager the query router calls. */
export type GrantQueryExecutor = Pick<
  GrantManager,
  "executeQuery" | "executeQueryWithPagination"
>;

/**
 * The one place a tool's SQL leaves from. Every built-in tool and the YAML
 * tool factory call these instead of `IBMiConnectionPool`, `SourceManager`
 * or `AuthenticatedPoolManager`.
 *
 * - Built-in OAuth mode (`config.oauth.builtin`): the grant in the auth
 *   context (`AuthInfo.extra.grantId`) on the registered executor. Without a
 *   grant, or without an executor, it throws `McpError` `Unauthorized`;
 *   it never falls back to a pool.
 * - Otherwise, as today: the caller's authenticated pool when the auth
 *   context carries an IBM i token, else the named source, else the
 *   `DB2i_*` service pool.
 */
export interface QueryRouterApi {
  executeQuery<T = unknown>(
    query: string,
    params?: BindingValue[],
    context?: RequestContext,
    options?: QueryRouteOptions,
  ): Promise<QueryResult<T>>;
  executeQueryWithPagination(
    query: string,
    params?: BindingValue[],
    context?: RequestContext,
    options?: QueryRouteOptions,
  ): Promise<PaginatedQueryResult>;
  /** Registers the grant manager at startup; `undefined` removes it. */
  setGrantQueryExecutor(executor: GrantQueryExecutor | undefined): void;
}

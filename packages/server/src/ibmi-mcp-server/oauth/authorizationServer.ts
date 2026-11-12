/**
 * @fileoverview The routes of the built-in OAuth 2.1 authorization server
 * (`AuthorizationServer` of contracts.ts): metadata, the sign-in page, the
 * token endpoint, revocation and client registration. Public clients only; no
 * cookie and no session. Everything about a sign-on is decided by the grant
 * manager; these routes check where a request comes from and what it asks
 * for, and turn the manager's answers into pages, redirects and JSON.
 *
 * Rules kept here:
 * - A body that can hold a password, an authorization code or a token is
 *   read as bytes into an unpooled Buffer and parsed there, into Buffers
 *   from `secretBuffer`. No string is made of a password, or of a code or a
 *   refresh token a client presents, and each Buffer is zero-filled in a
 *   `finally` block. The token response is built in an unpooled Buffer that
 *   is zero-filled once Node.js has written it.
 * - The code the grant manager issues is a string only while the redirect
 *   that carries it is built: nothing here keeps the sign-on's result, and a
 *   repeated form submission is answered without the code.
 * - No function between reading such a body and the grant manager creates a
 *   closure, and nothing here uses AsyncLocalStorage: either would keep the
 *   bytes reachable after the request.
 * - No body is logged, and nothing typed into the form is put back into a
 *   page.
 * @module src/ibmi-mcp-server/oauth/authorizationServer
 */

import {
  createHmac,
  createSecretKey,
  randomBytes,
  timingSafeEqual,
  type KeyObject,
} from "node:crypto";
import { Hono, type Context } from "hono";
import { config } from "@/config/index.js";
import {
  cidrMatcher,
  verifiedClientAddress,
  type AddressMatcher,
} from "@/mcp-server/transports/http/clientAddress.js";
import type { HonoNodeBindings } from "@/mcp-server/transports/http/httpTypes.js";
import { JsonRpcErrorCode, McpError } from "@/types-global/errors.js";
import { logger } from "@/utils/internal/logger.js";
import { requestContextService } from "@/utils/internal/requestContext.js";
import {
  createClientDocumentReader,
  fetchClientDocument,
} from "./clientMetadata.js";
import {
  describeClient,
  isLoopbackRedirect,
  isRedirectAllowed,
  parseClientId,
  registerClient,
} from "./clients.js";
import {
  LOGIN_REQUEST_TTL_MS,
  OAUTH_PATHS,
  SOFT_BUDGET,
  type CreateAuthorizationServer,
  type GrantManager,
  type OAuthClient,
  type SignOnRefusal,
  type SignOnResult,
  type TokenPair,
  type TokenResult,
} from "./contracts.js";
import { secretBuffer, zeroFill } from "./sealing.js";
import {
  completedPage,
  messagePage,
  pageHeaders,
  redirectPage,
  signInPage,
} from "./signInPage.js";

type AppContext = Context<{ Bindings: HonoNodeBindings }>;

/** Longest request body read, in bytes. */
const MAX_BODY_BYTES = 64 * 1024;
/** Longest `state` carried through a sign-on. */
const MAX_STATE_LENGTH = 2048;
const CODE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
/** Seconds a client is asked to wait when the token endpoint answers 429. */
const RETRY_AFTER_SECONDS = 5;
/**
 * How long after a sign-on's result is known a second submission of the same
 * sign-in form is answered by it (without its code).
 */
const REPEAT_ANSWER_MS = 5_000;

const SIGN_IN_FIELDS = ["login_request", "profile", "password"];
const TOKEN_FIELDS = [
  "grant_type",
  "code",
  "code_verifier",
  "client_id",
  "redirect_uri",
  "refresh_token",
  "resource",
];
const REVOKE_FIELDS = ["token"];

/** What the sign-in page says for each refused sign-on. Fixed text only. */
const SIGN_ON_MESSAGES: Record<SignOnRefusal, string> = {
  profile_syntax:
    "That is not a user profile name this server can sign on: 1 to 10 characters, letters, digits, #, $ and _ only, and not starting with a digit. Type national characters as # and $. Nothing was sent to the IBM i.",
  password_syntax:
    "This password cannot be used through this server: it must be 1 to 128 printable ASCII characters, without a colon, a percent sign, a semicolon, a double quote, an asterisk at the start, a backslash at the end, or a space at either end. Nothing was sent to the IBM i.",
  profile_not_allowed:
    "This user profile is not permitted to sign on through this server.",
  blocked:
    "Sign-on for this user profile is blocked on this server after sign-on attempts that were rejected or not answered. The IBM i profile is not disabled by this block. Sign on at a 5250 session first, then ask the operator of this server to unblock the profile.",
  paused: `Sign-on for this user profile is paused on this server because the IBM i did not answer earlier attempts. Try again in ${SOFT_BUDGET.pauseMs / 60_000} minutes.`,
  busy: "Another sign-on is in progress. Wait a moment, then try again.",
  at_capacity:
    "This server has reached its limit of sign-ons or IBM i connections, or is shutting down. Try again later.",
  unavailable: "The IBM i system is unavailable. Try again later.",
  not_permitted:
    "This user profile is not permitted to connect through Mapepire on the IBM i.",
  rejected: "Sign-on not accepted.",
  password_expired:
    "The password of this user profile is expired. Change it at a 5250 session, then sign on here.",
  profile_disabled: "This user profile is disabled. Ask your administrator.",
  privileged:
    "This user profile holds *ALLOBJ or *SECADM special authority, or its authorities could not be read. This server does not sign on such profiles: the Mapepire server keeps the password of a profile while it is connected.",
};

/** What a sign-in page was shown for; signed into the page's hidden field. */
interface LoginRequest {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  nonce: string;
  expiresAt: number;
}

/** A sign-in form that was submitted. */
interface Submission {
  /** When its login request expires: it is forgotten then. */
  expiresAt: number;
  /** The client address it was submitted from. */
  address: string;
  /** Its sign-on, while that runs. */
  pending?: Promise<SignOnResult>;
  /**
   * What its sign-on led to, without the code: for `REPEAT_ANSWER_MS` after
   * it became known.
   */
  settled?: "ok" | SignOnRefusal;
  /** When that became known. */
  settledAt?: number;
}

/** What the routes share. Holds no request and no secret but the signing key. */
interface Server {
  grants: GrantManager;
  issuer: string;
  /** Origin of the issuer: what `Origin` of a submitted sign-in form must be. */
  origin: string;
  paths: Record<keyof typeof OAUTH_PATHS, string>;
  /** The IBM i system shown on the sign-in page. */
  system: string;
  /** `OAUTH_SIGNON_ALLOWED_CIDRS`. */
  signOnAllowed: AddressMatcher;
  /** Signs login requests. Random, never configured, lost at exit. */
  key: KeyObject;
  /** The login requests already submitted, by nonce. */
  submitted: Map<string, Submission>;
  /** Completes a URL client with the redirect URIs of its document. */
  readClientDocument: ReturnType<typeof createClientDocumentReader>;
}

function audit(event: string, fields: Record<string, unknown>): void {
  logger.warning(
    {
      ...requestContextService.createRequestContext({
        operation: "OAuthAuthorizationServer",
      }),
      event,
      ...fields,
    },
    event,
  );
}

// --- Bodies as bytes --------------------------------------------------------

/**
 * Reads a request body into one unpooled Buffer, which the caller
 * zero-fills.
 *
 * @returns `undefined` when the body is longer than `MAX_BODY_BYTES` or
 *   cannot be read.
 */
async function readBody(c: AppContext): Promise<Buffer | undefined> {
  // Zero-filled first: uninitialised memory can hold what an earlier request
  // left in freed memory, and only this request's bytes are wiped below.
  const body = Buffer.allocUnsafeSlow(MAX_BODY_BYTES).fill(0);
  let length = 0;
  try {
    const reader = c.req.raw.body?.getReader();
    for (;;) {
      const chunk = await reader?.read();
      if (!chunk || chunk.done) {
        return body.subarray(0, length);
      }
      const fits = length + chunk.value.length <= MAX_BODY_BYTES;
      if (fits) {
        body.set(chunk.value, length);
        length += chunk.value.length;
      }
      chunk.value.fill(0);
      if (!fits) {
        break;
      }
    }
  } catch {
    // Answered as a body that cannot be read.
  }
  zeroFill(body.subarray(0, length));
  return undefined;
}

/** The value of a hexadecimal digit, or -1. */
function hexValue(byte: number | undefined): number {
  if (byte === undefined) return -1;
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  const letter = byte | 0x20;
  return letter >= 0x61 && letter <= 0x66 ? letter - 0x57 : -1;
}

/**
 * Decodes a name or a value of a form body (`+` and percent-encoding) into
 * a Buffer of its own; `undefined` when the encoding is broken.
 */
function decodeFormBytes(encoded: Buffer): Buffer | undefined {
  const decoded = secretBuffer(encoded.length);
  let length = 0;
  for (let index = 0; index < encoded.length; index++) {
    let byte = encoded[index]!;
    if (byte === 0x2b) {
      byte = 0x20;
    } else if (byte === 0x25) {
      const high = hexValue(encoded[index + 1]);
      const low = hexValue(encoded[index + 2]);
      if (high < 0 || low < 0) {
        zeroFill(decoded.subarray(0, length));
        return undefined;
      }
      byte = high * 16 + low;
      index += 2;
    }
    decoded[length++] = byte;
  }
  return decoded.subarray(0, length);
}

/**
 * Parses an `application/x-www-form-urlencoded` body in Buffers: the decoded
 * value of each of `names` that is present, for the caller to zero-fill.
 * Other fields are skipped undecoded.
 *
 * @returns `undefined` when the encoding is broken or one of `names` is
 *   there twice.
 */
function parseForm(
  body: Buffer,
  names: readonly string[],
): Map<string, Buffer> | undefined {
  const fields = new Map<string, Buffer>();
  let start = 0;
  while (start < body.length) {
    let end = body.indexOf(0x26, start);
    if (end === -1) {
      end = body.length;
    }
    const pair = body.subarray(start, end);
    start = end + 1;
    const equals = pair.indexOf(0x3d);
    const name = decodeFormBytes(
      equals === -1 ? pair : pair.subarray(0, equals),
    );
    let wanted: string | undefined;
    for (const candidate of names) {
      if (name?.equals(Buffer.from(candidate))) {
        wanted = candidate;
      }
    }
    zeroFill(name);
    if (name && wanted === undefined) {
      continue;
    }
    // Refused: a name that does not decode, and a wanted field that has no
    // value, is there twice, or whose value does not decode.
    const value =
      wanted === undefined || equals === -1 || fields.has(wanted)
        ? undefined
        : decodeFormBytes(pair.subarray(equals + 1));
    if (wanted === undefined || !value) {
      zeroFill(...fields.values());
      return undefined;
    }
    fields.set(wanted, value);
  }
  return fields;
}

/**
 * The wanted fields of a form body. The body's own Buffer is zero-filled
 * before this returns; the values are the caller's to zero-fill.
 */
async function readForm(
  c: AppContext,
  names: readonly string[],
): Promise<Map<string, Buffer> | undefined> {
  const body = await readBody(c);
  if (!body) {
    return undefined;
  }
  try {
    return parseForm(body, names);
  } finally {
    zeroFill(body);
  }
}

// --- The sign-in page -------------------------------------------------------

/** Signs what a sign-in page is shown for, with a new nonce and expiry. */
function signLoginRequest(
  key: KeyObject,
  request: Omit<LoginRequest, "nonce" | "expiresAt">,
): string {
  const login: LoginRequest = {
    ...request,
    nonce: randomBytes(16).toString("base64url"),
    expiresAt: Date.now() + LOGIN_REQUEST_TTL_MS,
  };
  const payload = Buffer.from(JSON.stringify(login)).toString("base64url");
  return `${payload}.${createHmac("sha256", key).update(payload).digest("base64url")}`;
}

/**
 * The login request of a submitted form, when this process signed it and it
 * has not expired.
 */
function openLoginRequest(
  server: Server,
  signed: string,
): LoginRequest | undefined {
  const [payload = "", signature = ""] = signed.split(".");
  const expected = createHmac("sha256", server.key).update(payload).digest();
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return undefined;
  }
  const login = JSON.parse(
    Buffer.from(payload, "base64url").toString(),
  ) as LoginRequest;
  return Date.now() < login.expiresAt ? login : undefined;
}

/**
 * Notes that a login request is submitted. One login request starts one
 * sign-on at most.
 *
 * @returns The submission to record the sign-on in. For a login request
 *   submitted before: `repeat`, the earlier submission whose answer this one
 *   gets (the form was sent twice from one address, as a double click does,
 *   and the first sign-on is under way or its result less than
 *   `REPEAT_ANSWER_MS` old), or `undefined` when it gets none.
 */
function submission(
  server: Server,
  login: LoginRequest,
  address: string,
): Submission | { repeat: Submission } | undefined {
  const now = Date.now();
  for (const [nonce, earlier] of server.submitted) {
    if (now >= earlier.expiresAt) {
      server.submitted.delete(nonce);
    }
  }
  const earlier = server.submitted.get(login.nonce);
  if (earlier) {
    const answered =
      earlier.pending !== undefined ||
      (earlier.settledAt !== undefined &&
        now - earlier.settledAt < REPEAT_ANSWER_MS);
    return answered && earlier.address === address
      ? { repeat: earlier }
      : undefined;
  }
  const first: Submission = { expiresAt: login.expiresAt, address };
  server.submitted.set(login.nonce, first);
  return first;
}

/**
 * Records what a submission's sign-on led to, and forgets it after
 * `REPEAT_ANSWER_MS`. The login request stays used until it expires.
 */
function settle(submitted: Submission, result: SignOnResult): void {
  submitted.pending = undefined;
  submitted.settled = result.ok ? "ok" : result.reason;
  submitted.settledAt = Date.now();
  setTimeout(() => {
    submitted.settled = undefined;
    submitted.settledAt = undefined;
  }, REPEAT_ANSWER_MS).unref();
}

function messageResponse(
  c: AppContext,
  status: 400 | 403,
  message: string,
): Response {
  return c.html(messagePage(message), status, pageHeaders());
}

/**
 * The client address of a sign-in request, or the page that refuses it: the
 * forwarding headers must agree with `MCP_TRUSTED_PROXIES`, and the address
 * must be inside `OAUTH_SIGNON_ALLOWED_CIDRS`.
 */
function signInAddress(c: AppContext, server: Server): string | Response {
  const verified = verifiedClientAddress(c);
  if ("refused" in verified) {
    audit("signon_refused", { reason: verified.refused });
    return messageResponse(
      c,
      403,
      "This server cannot tell where your request comes from: the proxy in front of it does not match its MCP_TRUSTED_PROXIES setting. Tell the operator of this server.",
    );
  }
  if (!server.signOnAllowed(verified.address)) {
    audit("signon_refused", {
      reason: "address_not_allowed",
      address: verified.address,
    });
    return messageResponse(
      c,
      403,
      "Sign-on is not available from your network address.",
    );
  }
  return verified.address;
}

function signInResponse(
  c: AppContext,
  server: Server,
  client: OAuthClient,
  request: Omit<LoginRequest, "nonce" | "expiresAt">,
  message?: string,
): Response {
  return c.html(
    signInPage({
      system: server.system,
      action: server.paths.authorize,
      loginRequest: signLoginRequest(server.key, request),
      client: describeClient(client, request.redirectUri),
      loopback: isLoopbackRedirect(request.redirectUri),
      message,
    }),
    200,
    pageHeaders(request.redirectUri),
  );
}

/** A URL as it is compared: parsed, without a trailing slash. */
function canonicalUrl(url: string | undefined): string | undefined {
  return url !== undefined && URL.canParse(url)
    ? new URL(url).href.replace(/\/$/, "")
    : undefined;
}

/**
 * What is wrong with an authorization request whose client and redirect URI
 * are valid, as the `error` its client is sent; `undefined` when nothing is.
 * `scope` and `prompt` are ignored.
 */
function authorizationError(c: AppContext): string | undefined {
  const responseType = c.req.query("response_type");
  if (responseType !== undefined && responseType !== "code") {
    return "unsupported_response_type";
  }
  if (
    responseType === undefined ||
    !CODE_CHALLENGE.test(c.req.query("code_challenge") ?? "") ||
    c.req.query("code_challenge_method") !== "S256" ||
    (c.req.query("state") ?? "").length > MAX_STATE_LENGTH
  ) {
    return "invalid_request";
  }
  const resource = c.req.query("resource");
  return resource !== undefined &&
    canonicalUrl(resource) !== canonicalUrl(config.mcpResourceUrl)
    ? "invalid_target"
    : undefined;
}

/**
 * The redirect back to the client, built from the parsed URI so that the
 * browser goes exactly where the destination rule looked.
 */
function clientRedirect(
  server: Server,
  redirectUri: string,
  result: { code: string } | { error: string },
  state: string | undefined,
): URL {
  const target = new URL(redirectUri);
  for (const [name, value] of Object.entries(result)) {
    target.searchParams.set(name, value);
  }
  if (state !== undefined) {
    target.searchParams.set("state", state);
  }
  target.searchParams.set("iss", server.issuer);
  return target;
}

/**
 * The client a `client_id` names. A URL client comes with the redirect URIs
 * of its metadata document.
 *
 * @returns `undefined` for an id this server does not accept; an `Error` that
 *   says why when the document of a URL client cannot be used.
 */
async function loadClient(
  server: Server,
  clientId: string,
): Promise<OAuthClient | Error | undefined> {
  const client = parseClientId(clientId, config.oauth);
  if (client?.kind !== "url") {
    return client;
  }
  try {
    return await server.readClientDocument(client);
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

async function getAuthorize(c: AppContext, server: Server): Promise<Response> {
  const address = signInAddress(c, server);
  if (typeof address !== "string") {
    return address;
  }
  // Until the client and its redirect URI are known to be valid, an error is
  // shown here and nothing is sent anywhere.
  const clientId = c.req.query("client_id") ?? "";
  const client = await loadClient(server, clientId);
  if (!client) {
    return messageResponse(
      c,
      400,
      `The application that sent you here is not known to this server. Its client_id is "${clientId}", which is neither registered here nor ${
        config.oauth.clientMetadataDocuments
          ? "the https URL of a client metadata document"
          : "a URL this server reads: OAUTH_CLIENT_METADATA_DOCUMENTS is false"
      }.`,
    );
  }
  if (client instanceof Error) {
    audit("signon_refused", {
      reason: "client_document_unusable",
      address,
      clientId,
      detail: client.message,
    });
    return messageResponse(
      c,
      400,
      `This server could not use the client metadata document of the application that sent you here, at "${clientId}": ${client.message}.`,
    );
  }
  const redirectUri = c.req.query("redirect_uri") ?? "";
  if (!isRedirectAllowed(client, redirectUri, config.oauth)) {
    return messageResponse(
      c,
      400,
      `The application asked for the sign-on result to be sent to "${redirectUri}", which this server does not allow. Allowed are loopback addresses, and the addresses the operator of this server listed in OAUTH_REDIRECT_URIS; the address must also be one the application registered.`,
    );
  }
  const given = c.req.query("state");
  const state =
    given !== undefined && given.length <= MAX_STATE_LENGTH ? given : undefined;
  const error = authorizationError(c);
  if (error !== undefined) {
    return c.body(null, 302, {
      ...pageHeaders(),
      Location: clientRedirect(server, redirectUri, { error }, state).href,
    });
  }
  return signInResponse(c, server, client, {
    clientId,
    redirectUri,
    // `authorizationError` has checked it.
    codeChallenge: c.req.query("code_challenge")!,
    state,
  });
}

/**
 * The submitted sign-in form. Before anything reaches the IBM i: where the
 * request comes from, that the form was served by this server (`Origin`),
 * that its login request is one of ours, unexpired and not used before, and
 * that its client and redirect URI are still allowed.
 */
async function postAuthorize(c: AppContext, server: Server): Promise<Response> {
  const address = signInAddress(c, server);
  if (typeof address !== "string") {
    return address;
  }
  if (c.req.header("origin") !== server.origin) {
    audit("signon_refused", { reason: "origin_mismatch", address });
    return messageResponse(
      c,
      403,
      "The sign-in form was not sent from this server's own page.",
    );
  }
  const fields = await readForm(c, SIGN_IN_FIELDS);
  try {
    const signed = fields?.get("login_request");
    const profile = fields?.get("profile");
    const password = fields?.get("password");
    if (!signed || !profile || !password) {
      return messageResponse(
        c,
        400,
        "The sign-in form is incomplete or could not be read. Start again from your application.",
      );
    }
    const login = openLoginRequest(server, signed.toString("latin1"));
    // Before `submission`: a second submission of the form must find the
    // sign-on the first started, so nothing may wait between the two.
    const client = login && (await loadClient(server, login.clientId));
    const submitted = login && submission(server, login, address);
    if (!login || !submitted) {
      audit("signon_refused", { reason: "login_request_invalid", address });
      return messageResponse(
        c,
        400,
        "This sign-in page has expired or was already used. Start again from your application.",
      );
    }
    if (
      !client ||
      client instanceof Error ||
      !isRedirectAllowed(client, login.redirectUri, config.oauth)
    ) {
      audit("signon_refused", { reason: "client_not_allowed", address });
      return messageResponse(
        c,
        400,
        "The application that sent you here is no longer allowed. Start again from your application.",
      );
    }
    let result: SignOnResult;
    if ("repeat" in submitted) {
      // A browser shows the answer to the last submission of a form and
      // drops the earlier one: this one gets the answer of the sign-on the
      // first started. What it carries is not looked at. Once that sign-on
      // has answered, its code is no longer kept, and a repeat is told so.
      const { pending, settled } = submitted.repeat;
      if (pending) {
        result = await pending;
      } else if (settled === "ok") {
        return c.html(completedPage(), 200, pageHeaders());
      } else {
        result = { ok: false, reason: settled! };
      }
    } else {
      submitted.pending = server.grants.signOn({
        profile,
        password,
        clientId: login.clientId,
        redirectUri: login.redirectUri,
        codeChallenge: login.codeChallenge,
        address,
      });
      result = await submitted.pending;
      settle(submitted, result);
    }
    if (!result.ok) {
      return signInResponse(
        c,
        server,
        client,
        login,
        SIGN_ON_MESSAGES[result.reason],
      );
    }
    const target = clientRedirect(
      server,
      login.redirectUri,
      { code: result.code },
      login.state,
    );
    // A 303 is part of the form submission, so the page's `form-action`
    // policy has to name its target. An https client gets a page that
    // redirects instead, which is a navigation of its own; so does an IPv6
    // loopback destination, which no policy can name (see `pageHeaders`).
    return target.protocol === "https:" || target.hostname.startsWith("[")
      ? c.html(redirectPage(target.href), 200, pageHeaders())
      : c.body(null, 303, { ...pageHeaders(), Location: target.href });
  } finally {
    if (fields) {
      zeroFill(...fields.values());
    }
  }
}

// --- Token endpoint, revocation, registration -------------------------------

/** An RFC 6749 error response. */
function oauthError(
  c: AppContext,
  status: 400 | 429,
  error: string,
  description: string,
  headers: Record<string, string> = {},
): Response {
  // The error code and the fixed description only: never a field's value.
  audit("oauth_error", {
    path: c.req.path,
    status,
    error,
    errorDescription: description,
  });
  return c.json({ error, error_description: description }, status, {
    "Cache-Control": "no-store",
    ...headers,
  });
}

/** The token response as bytes: the tokens do not become strings here. */
function tokenResponseBody(
  tokens: TokenPair,
  expiresIn: number,
): Buffer<ArrayBuffer> {
  const parts = [
    Buffer.from('{"access_token":"'),
    tokens.accessToken,
    // The one scope there is: every sign-on gets a refresh token.
    Buffer.from(
      `","token_type":"Bearer","expires_in":${expiresIn},"scope":"offline_access","refresh_token":"`,
    ),
    tokens.refreshToken,
    Buffer.from('"}'),
  ];
  let length = 0;
  for (const part of parts) {
    length += part.length;
  }
  const body = Buffer.allocUnsafeSlow(length);
  let offset = 0;
  for (const part of parts) {
    offset += part.copy(body, offset);
  }
  return body;
}

/**
 * The token response body as a stream of the one Buffer, zero-filled once
 * Node.js has written it. A stream, not the Buffer: a middleware that adds
 * a header after the route (hono/cors adds `Vary`) makes Hono rebuild the
 * Response, which copies a Buffer body into bytes nothing wipes but hands a
 * stream on as it is, so the chunk Node.js writes is this Buffer. A response
 * that closed while the grant manager answered (the client went away) is
 * never written: the Buffer is zero-filled at once. Without a Node.js
 * response (a request made in process) nothing is wiped.
 */
function zeroFilledWhenWritten(
  c: AppContext,
  body: Buffer,
): ReadableStream<Uint8Array> {
  const outgoing = c.env.outgoing;
  if (outgoing?.destroyed) {
    zeroFill(body);
  } else {
    outgoing?.once("close", () => zeroFill(body));
  }
  return new ReadableStream({
    start(controller) {
      controller.enqueue(body);
      controller.close();
    },
  });
}

/** The grant manager's answer for the form's grant type; a `Response` for a request it never saw. */
async function tokenResult(
  c: AppContext,
  grants: GrantManager,
  fields: Map<string, Buffer>,
  address: string,
): Promise<TokenResult | Response> {
  const grantType = fields.get("grant_type")?.toString();
  if (grantType === undefined) {
    return oauthError(c, 400, "invalid_request", "grant_type is required.");
  }
  if (grantType !== "authorization_code" && grantType !== "refresh_token") {
    return oauthError(
      c,
      400,
      "unsupported_grant_type",
      "Supported grant types: authorization_code, refresh_token.",
    );
  }
  const clientId = fields.get("client_id")?.toString();
  if (clientId === undefined || !parseClientId(clientId, config.oauth)) {
    return oauthError(
      c,
      400,
      "invalid_client",
      "client_id must be one this server registered, or the https URL of a client metadata document where this server reads them.",
    );
  }
  const resource = fields.get("resource")?.toString();
  if (
    resource !== undefined &&
    canonicalUrl(resource) !== canonicalUrl(config.mcpResourceUrl)
  ) {
    return oauthError(
      c,
      400,
      "invalid_target",
      "resource must be the URL of this server's MCP endpoint.",
    );
  }
  if (grantType === "refresh_token") {
    const refreshToken = fields.get("refresh_token");
    return refreshToken
      ? grants.refresh({ refreshToken, clientId, address })
      : oauthError(c, 400, "invalid_request", "refresh_token is required.");
  }
  const code = fields.get("code");
  const codeVerifier = fields.get("code_verifier")?.toString();
  return code && codeVerifier !== undefined
    ? grants.exchangeCode({
        code,
        codeVerifier,
        clientId,
        // A client that follows OAuth 2.1 sends none: PKCE took its place.
        redirectUri: fields.get("redirect_uri")?.toString(),
        address,
      })
    : oauthError(
        c,
        400,
        "invalid_request",
        "code and code_verifier are required.",
      );
}

async function postToken(c: AppContext, server: Server): Promise<Response> {
  const verified = verifiedClientAddress(c);
  if ("refused" in verified) {
    audit("token_refused", { reason: verified.refused });
    return oauthError(
      c,
      400,
      "invalid_request",
      "The proxy in front of this server does not match its MCP_TRUSTED_PROXIES setting.",
    );
  }
  const fields = await readForm(c, TOKEN_FIELDS);
  if (!fields) {
    return oauthError(
      c,
      400,
      "invalid_request",
      `The body must be a form of at most ${MAX_BODY_BYTES} bytes that has each parameter once.`,
    );
  }
  try {
    const result = await tokenResult(
      c,
      server.grants,
      fields,
      verified.address,
    );
    if (result instanceof Response) {
      return result;
    }
    if (!result.ok) {
      return result.error === "rate_limited"
        ? oauthError(
            c,
            429,
            "temporarily_unavailable",
            "The server is busy, or this sign-on refreshed too often. Retry shortly.",
            { "Retry-After": String(RETRY_AFTER_SECONDS) },
          )
        : oauthError(
            c,
            400,
            "invalid_grant",
            "The code or refresh token is not valid for this client.",
          );
    }
    try {
      const body = tokenResponseBody(result, result.expiresInSeconds);
      return c.body(zeroFilledWhenWritten(c, body), 200, {
        "Content-Type": "application/json",
        "Content-Length": String(body.length),
        "Cache-Control": "no-store",
      });
    } finally {
      zeroFill(result.accessToken, result.refreshToken);
    }
  } finally {
    zeroFill(...fields.values());
  }
}

/** RFC 7009: a token this server does not know is not an error. */
async function postRevoke(c: AppContext, server: Server): Promise<Response> {
  const token = (await readForm(c, REVOKE_FIELDS))?.get("token");
  if (!token) {
    return oauthError(c, 400, "invalid_request", "token is required.");
  }
  try {
    await server.grants.revoke(token);
  } finally {
    zeroFill(token);
  }
  return c.body(null, 200, { "Cache-Control": "no-store" });
}

/** RFC 7591. Nothing is stored: the client id encodes the registration. */
async function postRegister(c: AppContext): Promise<Response> {
  const body = await readBody(c);
  let metadata: unknown;
  try {
    metadata = JSON.parse(body?.toString() ?? "");
  } catch {
    // Not JSON: answered as invalid client metadata.
  }
  const registration = registerClient(metadata, config.oauth);
  return "error" in registration
    ? oauthError(
        c,
        400,
        registration.error,
        registration.error === "invalid_redirect_uri"
          ? "None of the redirect_uris is allowed here. Allowed are loopback http URIs, and the URIs the operator of this server listed in OAUTH_REDIRECT_URIS."
          : "The body must be JSON with a redirect_uris array, and small enough for its client_id.",
      )
    : c.json(registration, 201, { "Cache-Control": "no-store" });
}

/**
 * Creates the routes of the built-in authorization server for
 * `config.oauth.issuer`.
 *
 * @throws {McpError} `ConfigurationError` when the server is not in built-in
 *   OAuth mode.
 */
export const createAuthorizationServer: CreateAuthorizationServer = (
  grants,
  fetchDocument = fetchClientDocument,
) => {
  const { issuer } = config.oauth;
  if (!issuer) {
    throw new McpError(
      JsonRpcErrorCode.ConfigurationError,
      "The built-in authorization server needs MCP_AUTH_MODE=oauth without OAUTH_ISSUER_URL, and MCP_RESOURCE_URL.",
    );
  }
  const issuerPath = new URL(issuer).pathname.replace(/\/$/, "");
  const paths = {
    // RFC 8414: the well-known part goes before the issuer's path.
    metadata: OAUTH_PATHS.metadata + issuerPath,
    authorize: issuerPath + OAUTH_PATHS.authorize,
    token: issuerPath + OAUTH_PATHS.token,
    revoke: issuerPath + OAUTH_PATHS.revoke,
    register: issuerPath + OAUTH_PATHS.register,
  };
  const server: Server = {
    grants,
    issuer,
    origin: new URL(issuer).origin,
    paths,
    system: config.oauth.mapepire.host ?? "IBM i",
    signOnAllowed: cidrMatcher(config.oauth.signOnAllowedCidrs),
    key: createSecretKey(randomBytes(32)),
    submitted: new Map(),
    readClientDocument: createClientDocumentReader(fetchDocument),
  };
  const metadata = {
    issuer,
    authorization_endpoint: issuer + OAUTH_PATHS.authorize,
    token_endpoint: issuer + OAUTH_PATHS.token,
    revocation_endpoint: issuer + OAUTH_PATHS.revoke,
    registration_endpoint: issuer + OAUTH_PATHS.register,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    client_id_metadata_document_supported: config.oauth.clientMetadataDocuments,
    authorization_response_iss_parameter_supported: true,
    scopes_supported: ["offline_access"],
  };

  const app = new Hono<{ Bindings: HonoNodeBindings }>();
  app.get(paths.metadata, (c) => c.json(metadata));
  app.get(paths.authorize, (c) => getAuthorize(c, server));
  app.post(paths.authorize, (c) => postAuthorize(c, server));
  app.post(paths.token, (c) => postToken(c, server));
  app.post(paths.revoke, (c) => postRevoke(c, server));
  app.post(paths.register, (c) => postRegister(c));
  return { app, paths };
};

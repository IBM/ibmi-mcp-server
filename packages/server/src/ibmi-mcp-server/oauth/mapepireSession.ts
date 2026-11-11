/**
 * @fileoverview The Mapepire client of the built-in OAuth sign-on: one
 * WebSocket per signed-on user, opened with the credentials the user typed.
 *
 * It replaces mapepire-js for these connections because mapepire-js keeps
 * the password reachable for the life of the job, and offers neither a
 * certificate pin nor a connect timeout. Here the password exists as bytes in
 * Buffers of their own that are zero-filled before `openSocket` returns, and as
 * one string, the `Authorization` header, that nothing references once the
 * upgrade request is written.
 *
 * What keeps it that way:
 * - `openSocket` is the only function that reads the password. It is
 *   synchronous and creates no closure.
 * - TLS sockets are made by a `createConnection` built at startup that passes
 *   `tls.connect` its own options, so no header reaches the socket's options.
 * - Sockets, their listeners and the sign-on timers are created in an async
 *   scope made at startup, never in the context of the request that carries
 *   the password.
 *
 * Nothing Mapepire answers to a sign-on is logged, returned or thrown.
 * @module src/ibmi-mcp-server/oauth/mapepireSession
 */

import { AsyncResource } from "node:async_hooks";
import { X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import tls from "node:tls";
import type { BindingValue, JDBCOptions, QueryResult } from "@ibm/mapepire-js";
import WebSocket from "ws";
import { JsonRpcErrorCode, McpError } from "@/types-global/errors.js";
import {
  CONNECT_REPLY_TIMEOUT_MS,
  HANDSHAKE_TIMEOUT_MS,
  SOCKET_TERMINATE_AFTER_MS,
  STATEMENT_TIMEOUT_MS,
  type GrantId,
  type MapepireClient,
  type MapepireSession,
  type MapepireTarget,
  type SessionCloseReason,
  type SignOnOutcome,
} from "./contracts.js";
import { secretBuffer } from "./sealing.js";

/**
 * The `DB2i_JDBC_OPTIONS` keys a grant connection may carry. Anything else
 * could change who the job runs as or where it connects (`user`, `secure`,
 * `proxy server`, `key ring password`, ...).
 */
const JDBC_OPTION_ALLOWLIST = new Set([
  "naming",
  "libraries",
  "date format",
  "date separator",
  "time format",
  "time separator",
  "decimal separator",
  "transaction isolation",
  "access",
]);

/** Text of mapepire-server's own refusals, issued before any IBM i sign-on. */
const MAPEPIRE_REFUSALS = [
  "Connection refused by security rule",
  "Invalid Password",
  "Not connected",
];

/** Rows in a page when the caller names no number: what mapepire-js asks for. */
const DEFAULT_ROWS = 100;
const BASE64 = Buffer.from(
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/",
);
const BASIC = "Basic ";

/** A reply of Mapepire, or why there is none. */
type Answer = Record<string, unknown> | "timeout" | "lost";

/**
 * The `props` of the connect request: `prompt=false` first, so that the
 * driver never asks for a sign-on itself, then the operator's options.
 * `prompt` is not an allowed option, so an operator cannot set it.
 *
 * @throws {McpError} `ConfigurationError` for a key outside the allowlist or
 *   a value that would start another property.
 */
function connectProps(options: JDBCOptions | undefined): string {
  const props = Object.entries(options ?? {}).map(([key, value]) => {
    const text = Array.isArray(value) ? value.join(",") : String(value);
    if (!JDBC_OPTION_ALLOWLIST.has(key) || text.includes(";")) {
      throw new McpError(
        JsonRpcErrorCode.ConfigurationError,
        `DB2i_JDBC_OPTIONS: "${key}" cannot be set when users sign on with their IBM i profile, or its value contains ";". Allowed: ${[...JDBC_OPTION_ALLOWLIST].join(", ")}.`,
      );
    }
    return `${key}=${text}`;
  });
  return ["prompt=false", ...props].join(";");
}

/**
 * Builds the function that opens every TLS connection to the target. It
 * ignores what the HTTP client passes (which includes the request headers)
 * and verifies the server as `target.trust` says: not at all when it is
 * `unverified`.
 *
 * @throws {McpError} `ConfigurationError` when the certificate file holds no
 *   certificate.
 */
function connectionFactory(target: MapepireTarget): () => tls.TLSSocket {
  const { trust } = target;
  const options: tls.ConnectionOptions = {
    host: target.host,
    port: target.port,
    // An address is not sent as a server name; the certificate is then
    // checked against `host`.
    servername: isIP(target.host) ? "" : target.host,
    rejectUnauthorized: trust.kind !== "unverified",
  };
  if (trust.kind === "pin" || trust.kind === "ca") {
    let certificate: X509Certificate;
    try {
      certificate = new X509Certificate(trust.pem);
    } catch {
      throw new McpError(
        JsonRpcErrorCode.ConfigurationError,
        `${trust.kind === "pin" ? "DB2i_SERVER_CERT_FILE" : "DB2i_CA_FILE"} does not hold a PEM certificate.`,
      );
    }
    options.ca = trust.pem;
    if (trust.kind === "pin") {
      const pinned = certificate.raw;
      // The pinned certificate is the trust anchor even when a CA issued it,
      // and the server must present exactly it, under whatever host name.
      options.allowPartialTrustChain = true;
      options.checkServerIdentity = (_host, presented) =>
        presented.raw.equals(pinned)
          ? undefined
          : new Error("The server certificate is not the pinned one.");
    }
  }
  return () => tls.connect({ ...options });
}

/** Writes the Base64 text of `source` into `target` as ASCII bytes. */
function writeBase64(source: Buffer, target: Buffer, offset: number): void {
  for (let i = 0; i < source.length; i += 3) {
    const triple =
      (source[i]! << 16) | ((source[i + 1] ?? 0) << 8) | (source[i + 2] ?? 0);
    target[offset++] = BASE64[triple >> 18]!;
    target[offset++] = BASE64[(triple >> 12) & 63]!;
    target[offset++] =
      i + 1 < source.length ? BASE64[(triple >> 6) & 63]! : 0x3d;
    target[offset++] = i + 2 < source.length ? BASE64[triple & 63]! : 0x3d;
  }
}

/**
 * Starts the one WebSocket connect of a sign-on. The only function that
 * reads the password: it builds `PROFILE:password` and the header in
 * Buffers of their own, zero-fills both, and creates no closure. The header
 * string is the one string derived from the password.
 */
function openSocket(
  url: string,
  createConnection: () => tls.TLSSocket,
  profile: string,
  password: Buffer,
): WebSocket {
  const plain = secretBuffer(profile.length + 1 + password.length);
  const header = secretBuffer(BASIC.length + Math.ceil(plain.length / 3) * 4);
  try {
    plain.write(profile, 0, "latin1");
    plain[profile.length] = 0x3a;
    password.copy(plain, profile.length + 1);
    header.write(BASIC, 0, "latin1");
    writeBase64(plain, header, BASIC.length);
    return new WebSocket(url, {
      headers: { authorization: header.toString("latin1") },
      createConnection,
    });
  } finally {
    plain.fill(0);
    header.fill(0);
  }
}

/** One open Mapepire WebSocket. Holds no user name and no password. */
class Session implements MapepireSession {
  jobName = "";
  /** Whether the WebSocket opened: false when the handshake failed or timed out. */
  readonly opened: Promise<boolean>;
  private open = false;
  /** Set by the socket's `close` event. */
  private gone = false;
  private reason: SessionCloseReason | undefined;
  private listener: ((reason: SessionCloseReason) => void) | undefined;
  private told = false;
  private lastId = 0;
  private readonly pending = new Map<string, (answer: Answer) => void>();
  private readonly pongs = new Set<(alive: boolean) => void>();
  private readonly closed: Promise<void>;
  private terminator: NodeJS.Timeout | undefined;

  constructor(private readonly socket: WebSocket) {
    let settleOpened!: (opened: boolean) => void;
    let settleClosed!: () => void;
    this.opened = new Promise((resolve) => (settleOpened = resolve));
    this.closed = new Promise((resolve) => (settleClosed = resolve));
    // ws's own handshake timeout is a socket timeout, which a custom
    // createConnection never arms.
    const handshake = setTimeout(
      () => socket.terminate(),
      HANDSHAKE_TIMEOUT_MS,
    );

    socket.on("open", () => {
      clearTimeout(handshake);
      this.open = true;
      settleOpened(true);
    });
    socket.on("message", (data) => {
      let reply: unknown;
      try {
        reply = JSON.parse(String(data));
      } catch {
        return;
      }
      const id = (reply as { id?: unknown } | null)?.id;
      if (typeof id === "string") {
        this.pending.get(id)?.(reply as Record<string, unknown>);
      }
    });
    socket.on("pong", () => {
      for (const settle of [...this.pongs]) settle(true);
    });
    // Every failure ends in `close`; the error itself is not looked at.
    socket.on("error", () => {});
    socket.on("close", () => {
      clearTimeout(handshake);
      clearTimeout(this.terminator);
      this.open = false;
      this.gone = true;
      this.reason ??= "lost";
      for (const settle of [...this.pending.values()]) settle("lost");
      for (const settle of [...this.pongs]) settle(false);
      settleOpened(false);
      settleClosed();
      this.tell();
    });
  }

  get isOpen(): boolean {
    return this.open;
  }

  /**
   * Sends one request and resolves to its reply, `timeout` when none came in
   * time, or `lost` when the socket is not open or closes first. Never
   * rejects.
   */
  request(body: Record<string, unknown>, timeoutMs: number): Promise<Answer> {
    if (!this.open) return Promise.resolve("lost");
    const id = String(++this.lastId);
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => this.pending.get(id)?.("timeout"),
        timeoutMs,
      );
      this.pending.set(id, (answer) => {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(answer);
      });
      this.socket.send(JSON.stringify({ id, ...body }));
    });
  }

  /** Cuts the socket without a close handshake. */
  terminate(reason: SessionCloseReason): void {
    this.open = false;
    this.reason ??= reason;
    this.socket.terminate();
  }

  async execute<T = unknown>(
    sql: string,
    params?: BindingValue[],
    rowsToFetch = DEFAULT_ROWS,
  ): Promise<QueryResult<T>> {
    const result = await this.statement<T>({
      type: params === undefined ? "sql" : "prepare_sql_execute",
      sql,
      rows: rowsToFetch,
      parameters: params,
    });
    // Mapepire omits `is_done` when there is no result set to fetch from.
    result.is_done ??= true;
    return result;
  }

  fetchMore<T = unknown>(
    statementId: string,
    rowsToFetch = DEFAULT_ROWS,
  ): Promise<QueryResult<T>> {
    return this.statement<T>({
      type: "sqlmore",
      cont_id: statementId,
      rows: rowsToFetch,
    });
  }

  async closeStatement(statementId: string): Promise<void> {
    await this.statementAnswer({ type: "sqlclose", cont_id: statementId });
  }

  ping(): Promise<boolean> {
    if (!this.open) return Promise.resolve(false);
    return new Promise((resolve) => {
      const settle = (alive: boolean) => {
        clearTimeout(timer);
        this.pongs.delete(settle);
        resolve(alive);
      };
      const timer = setTimeout(settle, HANDSHAKE_TIMEOUT_MS, false);
      this.pongs.add(settle);
      this.socket.ping();
    });
  }

  close(): Promise<void> {
    if (!this.gone && this.reason === undefined) {
      this.reason = "closed";
      if (this.open) {
        this.open = false;
        this.socket.send(JSON.stringify({ id: "exit", type: "exit" }));
      }
      this.socket.close();
      this.terminator = setTimeout(
        () => this.socket.terminate(),
        SOCKET_TERMINATE_AFTER_MS,
      );
    }
    return this.closed;
  }

  onClose(listener: (reason: SessionCloseReason) => void): void {
    this.listener = listener;
    if (this.gone) queueMicrotask(() => this.tell());
  }

  /** Tells the listener, once, that the socket is gone. */
  private tell(): void {
    if (this.told || !this.listener || !this.reason) return;
    this.told = true;
    this.listener(this.reason);
  }

  /**
   * A statement request. There is no cancel in Mapepire: one that goes
   * unanswered is abandoned by closing the socket.
   */
  private async statementAnswer(
    body: Record<string, unknown>,
  ): Promise<Answer> {
    const answer = await this.request(body, STATEMENT_TIMEOUT_MS);
    if (answer === "timeout") this.terminate("abandoned");
    return answer;
  }

  private async statement<T>(
    body: Record<string, unknown>,
  ): Promise<QueryResult<T>> {
    const answer = await this.statementAnswer(body);
    if (answer === "timeout") {
      throw new McpError(
        JsonRpcErrorCode.Timeout,
        `The statement was abandoned after ${STATEMENT_TIMEOUT_MS / 1000} seconds; it may still be running on the IBM i as job ${this.jobName}.`,
        { job: this.jobName },
      );
    }
    if (answer === "lost") {
      throw new McpError(
        JsonRpcErrorCode.ServiceUnavailable,
        "The connection to the IBM i is not open.",
      );
    }
    if (answer.success !== true) {
      const parts = [answer.error, answer.sql_state, answer.sql_rc].filter(
        (part) => part !== undefined && part !== null,
      );
      throw new McpError(JsonRpcErrorCode.DatabaseError, parts.join(", "));
    }
    return answer as unknown as QueryResult<T>;
  }
}

/**
 * Reads the outcome of a sign-on from the reply to `connect`. The classes
 * are structural, so they hold in any language of the Mapepire JVM; only the
 * two details need its English text. The text goes nowhere else.
 */
function classify(
  answer: Answer,
  profile: string,
): Exclude<SignOnOutcome, { class: "ok" }> | { class: "ok"; job: string } {
  if (answer === "timeout") return { class: "timeout" };
  if (answer === "lost") return { class: "other" };
  if (answer.success === true) {
    return typeof answer.job === "string"
      ? { class: "ok", job: answer.job }
      : { class: "other" };
  }
  const text = typeof answer.error === "string" ? answer.error : "";
  if (MAPEPIRE_REFUSALS.some((refusal) => text.includes(refusal))) {
    return { class: "mapepire" };
  }
  // A sign-on rejection ends with ":" and the user id, or, from the native
  // sign-on, with ":USER:", the user id and a message id.
  if (text.includes(`:${profile})`) || text.includes(`:USER:${profile} `)) {
    if (text.includes("Password is expired.")) {
      return { class: "rejected", detail: "expired" };
    }
    if (text.includes("User ID is disabled.")) {
      return { class: "rejected", detail: "disabled" };
    }
    return { class: "rejected" };
  }
  return { class: "other" };
}

/**
 * One WebSocket connect and one `connect` request. Never retried; never rejects.
 *
 * @param signingOn - Holds the session for as long as this runs.
 */
async function signOn(
  url: string,
  createConnection: () => tls.TLSSocket,
  props: string,
  signingOn: Set<Session>,
  profile: string,
  password: Buffer,
  grantId: GrantId,
): Promise<SignOnOutcome> {
  let session: Session;
  try {
    session = new Session(openSocket(url, createConnection, profile, password));
  } catch {
    return { class: "pre" };
  }
  signingOn.add(session);
  try {
    if (!(await session.opened)) return { class: "pre" };

    const outcome = classify(
      await session.request(
        {
          type: "connect",
          // Before mapepire-server 2.3.6 this selects the JTOpen driver.
          technique: "tcp",
          application: `ibmi-mcp/${grantId}`,
          props,
        },
        CONNECT_REPLY_TIMEOUT_MS,
      ),
      profile,
    );
    if (outcome.class !== "ok") {
      session.terminate("closed");
      return outcome;
    }
    session.jobName = outcome.job;
    return { class: "ok", session };
  } finally {
    signingOn.delete(session);
  }
}

/**
 * The client for grant connections. Opens nothing.
 *
 * @throws {McpError} `ConfigurationError` when `target.jdbcOptions` has a key
 *   outside the allowlist or the certificate file holds no certificate.
 */
export function createMapepireClient(target: MapepireTarget): MapepireClient {
  const props = connectProps(target.jdbcOptions);
  const createConnection = connectionFactory(target);
  const url = `wss://${target.host}:${target.port}/db/`;
  // Sign-ons run in this scope, not in the context of whichever request
  // carried the password: an open socket keeps its creation context alive.
  const scope = new AsyncResource("MapepireSession");
  const signingOn = new Set<Session>();
  return {
    signOn: (profile, password, grantId) =>
      scope.runInAsyncScope(
        signOn,
        undefined,
        url,
        createConnection,
        props,
        signingOn,
        profile,
        password,
        grantId,
      ),
    abort() {
      for (const session of signingOn) {
        session.terminate("closed");
      }
    },
  };
}

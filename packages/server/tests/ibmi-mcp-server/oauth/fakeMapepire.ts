/**
 * @fileoverview A fake mapepire-server for tests of the built-in OAuth
 * sign-on. It listens on `127.0.0.1` with TLS and speaks the daemon's
 * protocol: `Authorization: Basic` on the WebSocket upgrade at `/db/`, then
 * `connect`, `sql`, `prepare_sql_execute`, `sqlmore`, `sqlclose` and `exit`.
 * Like mapepire-server 2.3.2 it answers 404 to every other HTTP request. No
 * IBM i is involved and every credential is made up.
 *
 * ```ts
 * const fake = await startFakeMapepire();
 * const client = createMapepireClient({
 *   host: "127.0.0.1",
 *   port: fake.port,
 *   trust: { kind: "pin", pem: Buffer.from(fake.certPem) },
 * });
 * // ... sign on as TESTUSER with FAKE_PASSWORD ...
 * await fake.stop();
 * ```
 *
 * Certificates are generated on each start: `certPem` is the server's own
 * certificate (pin it), issued by the throwaway CA in `caPem` (use it as the
 * CA file). The certificate names `127.0.0.1` and `localhost` unless
 * `certNames` says otherwise. With `expiredSelfSignedCert` the server
 * presents a certificate it signed itself and that expired a day ago, so no
 * verification accepts it.
 *
 * What a test sets (as options, or later on the returned object):
 * - `accounts`: profile to password. A `connect` with the right password
 *   succeeds and names a new job; a wrong password or an unknown profile gets
 *   the host server's rejection text, `(Password is incorrect.:PROFILE)` or
 *   `(User ID is not known.:PROFILE)`.
 * - `signOn`: profile to a behaviour that replaces that judgement; see
 *   {@link SignOnBehaviour}.
 * - `statements`: the first entry whose `match` is part of the SQL text
 *   decides the answer; see {@link StatementReply}. Unmatched SQL returns no
 *   rows. Rows are paged by the request's `rows` the way mapepire-server does
 *   it: `is_done` only once a fetch came up short.
 *
 * What a test reads:
 * - `upgrades`: WebSocket upgrade requests that reached the server.
 * - `httpRequests`: other HTTP requests that reached the server (each got a
 *   404).
 * - `connects`: every `connect` request (profile, application, props, the
 *   job it was given, the TLS server name, whether the password matched;
 *   never the password).
 *   `signOns(profile)` counts them for one profile.
 * - `requests`: every other request, with the profile of its socket.
 * - `openSockets`: WebSockets currently open.
 *
 * What a test does: `stall()` (stop reading from the open sockets: no reply,
 * no pong, no close handshake), `drop()` (cut them), `stop()`.
 *
 * `startIsolatedFakeMapepire` runs the same server in a worker thread, so the
 * credentials it parses stay out of the test's own heap; a heap search can
 * then be about the code under test alone. It takes the same options and
 * reports `state()` on request. It needs Node 22.18 or later (the worker
 * loads this TypeScript file directly), so this file uses erasable syntax
 * only and imports nothing from the repository.
 */

import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";
import type { IncomingMessage } from "node:http";
import https from "node:https";
import { isIPv4 } from "node:net";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import type { TLSSocket } from "node:tls";
import {
  Worker,
  isMainThread,
  parentPort,
  workerData,
} from "node:worker_threads";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";

/** The profile `startFakeMapepire` accepts by default. */
export const FAKE_PROFILE = "TESTUSER";
/** Its password. Obviously not a real one. */
export const FAKE_PASSWORD = "dummy-Pw-123";

/** How the fake answers a profile's sign-on, whatever the password. */
export type SignOnBehaviour =
  /** Host server text an English JVM returns: rejected, detail `expired`. */
  | "expired"
  /** Host server text an English JVM returns: rejected, detail `disabled`. */
  | "disabled"
  /** mapepire-server's own "Connection refused by security rule". */
  | "security_rule"
  /** mapepire-server's own "Invalid Password". */
  | "invalid_password"
  /** mapepire-server's own "Not connected". */
  | "not_connected"
  /** An error that names neither the profile nor a Mapepire literal. */
  | "unknown_error"
  /** The `connect` request is never answered. */
  | "no_reply"
  /** The socket is closed when `connect` arrives. */
  | "close"
  /** The WebSocket upgrade is never answered. */
  | "no_upgrade"
  /** These fields as the reply to `connect`, verbatim. */
  | { reply: Record<string, unknown> };

/** How the fake answers a statement. */
export type StatementReply =
  /** A result set, paged by the request's `rows`. */
  | { rows: unknown[] }
  /** A statement without a result set. */
  | { updateCount: number }
  /** A failed statement. */
  | { error: string; sqlState?: string; sqlRc?: number }
  /** Never answered. */
  | "no_reply"
  /** The socket is closed mid-statement. */
  | "close";

/** One `connect` request the fake received. Never holds the password. */
export interface ConnectRecord {
  profile: string;
  /** Whether the password of the upgrade request is the profile's in `accounts`. */
  passwordMatched: boolean;
  /** The TLS server name (SNI) the client asked for, if it sent one. */
  serverName?: string;
  application?: string;
  /** The JDBC properties string, as sent. */
  props?: string;
  technique?: string;
  /** The job the connect was given; absent when it failed. */
  job?: string;
}

/** One request other than `connect`, as received, plus its socket's profile. */
export interface RequestRecord {
  profile: string;
  id: string;
  type: string;
  [field: string]: unknown;
}

/** Plain data, so the same options start the isolated fake. */
export interface FakeMapepireOptions {
  /** Default: `{ TESTUSER: "dummy-Pw-123" }`. */
  accounts?: Record<string, string>;
  signOn?: Record<string, SignOnBehaviour>;
  statements?: Array<{ match: string; reply: StatementReply }>;
  /** DNS names and IPv4 addresses in the certificate. Default: `127.0.0.1`, `localhost`. */
  certNames?: string[];
  /** Present a self-signed certificate that has expired. */
  expiredSelfSignedCert?: boolean;
}

/** A running fake. The settable members take effect on the next request. */
export interface FakeMapepire {
  readonly port: number;
  /** The server's certificate. */
  readonly certPem: string;
  /** The CA that issued it; the certificate itself when it is self-signed. */
  readonly caPem: string;
  accounts: Record<string, string>;
  signOn: Record<string, SignOnBehaviour>;
  statements: Array<{ match: string; reply: StatementReply }>;
  upgrades: number;
  httpRequests: number;
  readonly connects: ConnectRecord[];
  readonly requests: RequestRecord[];
  readonly openSockets: number;
  /** Number of `connect` requests for a profile: its sign-on attempts. */
  signOns(profile: string): number;
  /** Stops reading from every open socket: a stalled server. */
  stall(): void;
  /** Cuts every open socket without a close handshake. */
  drop(): void;
  stop(): Promise<void>;
}

/** The fake in a worker thread. */
export interface IsolatedFakeMapepire {
  readonly port: number;
  readonly certPem: string;
  readonly caPem: string;
  state(): Promise<FakeMapepireState>;
  stop(): Promise<void>;
}

/** What a fake has received so far. */
export type FakeMapepireState = Pick<
  FakeMapepire,
  "upgrades" | "httpRequests" | "connects" | "requests"
>;

// --- Certificates: just enough DER for an ECDSA X.509 v3 certificate --------

const OID_ECDSA_SHA256 = Buffer.from("06082a8648ce3d040302", "hex");
const OID_COMMON_NAME = Buffer.from("0603550403", "hex");
const OID_BASIC_CONSTRAINTS = Buffer.from("0603551d13", "hex");
const OID_SUBJECT_ALT_NAME = Buffer.from("0603551d11", "hex");
const DAY_MS = 24 * 60 * 60 * 1000;

function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const length =
    body.length < 0x80
      ? [body.length]
      : body.length < 0x100
        ? [0x81, body.length]
        : [0x82, body.length >> 8, body.length & 0xff];
  return Buffer.concat([Buffer.from([tag, ...length]), body]);
}

function distinguishedName(commonName: string): Buffer {
  const attribute = der(
    0x30,
    OID_COMMON_NAME,
    der(0x0c, Buffer.from(commonName)),
  );
  return der(0x30, der(0x31, attribute));
}

function utcTime(time: number): Buffer {
  const text = new Date(time).toISOString().slice(2, 19).replace(/[-T:]/g, "");
  return der(0x17, Buffer.from(`${text}Z`));
}

function extension(oid: Buffer, critical: boolean, value: Buffer): Buffer {
  const flag = critical ? [der(0x01, Buffer.from([0xff]))] : [];
  return der(0x30, oid, ...flag, der(0x04, value));
}

function certificatePem(
  subject: string,
  publicKey: KeyObject,
  issuer: string,
  issuerKey: KeyObject,
  extensionList: Buffer[],
  notAfter = Date.now() + DAY_MS,
): string {
  const serial = randomBytes(8);
  serial[0] = (serial[0]! & 0x3f) | 0x40;
  const algorithm = der(0x30, OID_ECDSA_SHA256);
  const body = der(
    0x30,
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, serial),
    algorithm,
    distinguishedName(issuer),
    der(0x30, utcTime(notAfter - 2 * DAY_MS), utcTime(notAfter)),
    distinguishedName(subject),
    publicKey.export({ type: "spki", format: "der" }),
    der(0xa3, der(0x30, ...extensionList)),
  );
  const signature = sign("sha256", body, issuerKey);
  const certificate = der(
    0x30,
    body,
    algorithm,
    der(0x03, Buffer.from([0]), signature),
  );
  const lines = certificate.toString("base64").match(/.{1,64}/g)!;
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
}

/**
 * A throwaway CA, a server certificate it issued for `names`, and that
 * certificate's private key, all PEM. Valid for a day around now.
 *
 * @param expiredSelfSigned - Instead: one certificate, signed with its own
 *   key, that expired a day ago. `caPem` is then that certificate too.
 */
export function generateCertificates(
  names: string[],
  expiredSelfSigned = false,
): {
  caPem: string;
  certPem: string;
  keyPem: string;
} {
  const ca = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const server = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const issuer = expiredSelfSigned ? names[0]! : "Fake Mapepire CA";
  const caPem = certificatePem(issuer, ca.publicKey, issuer, ca.privateKey, [
    extension(
      OID_BASIC_CONSTRAINTS,
      true,
      der(0x30, der(0x01, Buffer.from([0xff]))),
    ),
  ]);
  const alternativeNames = names.map((name) =>
    isIPv4(name)
      ? der(0x87, Buffer.from(name.split(".").map(Number)))
      : der(0x82, Buffer.from(name)),
  );
  const certPem = certificatePem(
    names[0]!,
    server.publicKey,
    issuer,
    expiredSelfSigned ? server.privateKey : ca.privateKey,
    [extension(OID_SUBJECT_ALT_NAME, false, der(0x30, ...alternativeNames))],
    expiredSelfSigned ? Date.now() - DAY_MS : undefined,
  );
  const keyPem = server.privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  return { caPem: expiredSelfSigned ? certPem : caPem, certPem, keyPem };
}

// --- The server ---------------------------------------------------------------

/** As mapepire-server 2.3.2 reports it. */
const HOST_SERVER_REJECTION =
  "java.sql.SQLNonTransientConnectionException: The application server rejected the connection.";

/** The error text of a failed connect, or `undefined` when it succeeds. */
function connectError(
  behaviour: SignOnBehaviour | undefined,
  profile: string,
  known: boolean,
  passwordMatched: boolean,
): string | undefined {
  switch (behaviour) {
    case "expired":
      return `${HOST_SERVER_REJECTION} (Password is expired.:${profile})`;
    case "disabled":
      return `${HOST_SERVER_REJECTION} (User ID is disabled.:${profile})`;
    case "security_rule":
      return "java.sql.SQLException: java.io.IOException: Connection refused by security rule from /QOpenSys/etc/mapepire/iprules.conf:1";
    case "invalid_password":
      return "java.sql.SQLException: java.io.IOException: Invalid Password";
    case "not_connected":
      return "Not connected";
    case "unknown_error":
      return "java.sql.SQLException: The application requester cannot establish the connection. (Connection refused)";
    default:
      if (!known) {
        return `${HOST_SERVER_REJECTION} (User ID is not known.:${profile})`;
      }
      return passwordMatched
        ? undefined
        : `${HOST_SERVER_REJECTION} (Password is incorrect.:${profile})`;
  }
}

/** The profile and password of an upgrade request, as mapepire-server reads them. */
function basicCredentials(
  request: IncomingMessage,
): { profile: string; password: string } | undefined {
  const header = request.headers.authorization;
  if (!header?.startsWith("Basic ")) return undefined;
  const decoded = Buffer.from(header.slice(6).trim(), "base64");
  const colon = decoded.indexOf(":");
  if (colon <= 0 || colon === decoded.length - 1) return undefined;
  return {
    profile: decoded.subarray(0, colon).toString("utf8"),
    password: decoded.subarray(colon + 1).toString("latin1"),
  };
}

/** Starts the fake in this process. */
export async function startFakeMapepire(
  options: FakeMapepireOptions = {},
): Promise<FakeMapepire> {
  const { caPem, certPem, keyPem } = generateCertificates(
    options.certNames ?? ["127.0.0.1", "localhost"],
    options.expiredSelfSignedCert,
  );
  const server = https.createServer({ cert: certPem, key: keyPem });
  const sockets = new WebSocketServer({ noServer: true });
  /** Upgrade sockets that are never answered. */
  const held = new Set<Duplex>();
  let jobs = 0;

  const fake: FakeMapepire = {
    port: 0,
    certPem,
    caPem,
    accounts: options.accounts ?? { [FAKE_PROFILE]: FAKE_PASSWORD },
    signOn: options.signOn ?? {},
    statements: options.statements ?? [],
    upgrades: 0,
    httpRequests: 0,
    connects: [],
    requests: [],
    get openSockets() {
      return sockets.clients.size;
    },
    signOns: (profile) =>
      fake.connects.filter((connect) => connect.profile === profile).length,
    stall() {
      for (const client of sockets.clients) client.pause();
    },
    drop() {
      for (const client of sockets.clients) client.terminate();
    },
    async stop() {
      fake.drop();
      for (const pending of held) pending.destroy();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };

  server.on("request", (_request, response) => {
    fake.httpRequests++;
    response.writeHead(404).end();
  });

  server.on("upgrade", (request, socket, head) => {
    fake.upgrades++;
    const credentials = basicCredentials(request);
    if (!credentials || request.url !== "/db/") {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    const { profile } = credentials;
    if (fake.signOn[profile] === "no_upgrade") {
      held.add(socket);
      return;
    }
    const passwordMatched = fake.accounts[profile] === credentials.password;
    const serverName = (request.socket as TLSSocket).servername || undefined;
    sockets.handleUpgrade(request, socket, head, (client) =>
      serve(client, profile, passwordMatched, serverName),
    );
  });

  function serve(
    client: WebSocket,
    profile: string,
    passwordMatched: boolean,
    serverName: string | undefined,
  ): void {
    /** Rows not yet fetched, by the id of the request that ran the statement. */
    const cursors = new Map<string, unknown[]>();
    let connected = false;

    const reply = (id: string, fields: Record<string, unknown>) =>
      client.send(`${JSON.stringify({ id, ...fields, execution_time: 1 })}\n`);
    const fail = (id: string, error: string, more = {}) =>
      reply(id, { error, success: false, ...more });
    const page = (rows: unknown[], count: unknown) => {
      const size = typeof count === "number" ? count : 1000;
      const data = rows.splice(0, size);
      return { data, is_done: data.length < size };
    };

    client.on("error", () => {});
    client.on("message", (message) => {
      const request = JSON.parse(String(message)) as RequestRecord;
      const { id } = request;

      if (request.type === "connect") {
        const behaviour = fake.signOn[profile];
        const error = connectError(
          behaviour,
          profile,
          profile in fake.accounts,
          passwordMatched,
        );
        const record: ConnectRecord = {
          profile,
          passwordMatched,
          serverName,
          application: request.application as string | undefined,
          props: request.props as string | undefined,
          technique: request.technique as string | undefined,
        };
        fake.connects.push(record);
        if (behaviour === "no_reply") return;
        if (behaviour === "close") return client.terminate();
        if (typeof behaviour === "object") return reply(id, behaviour.reply);
        if (error !== undefined) return fail(id, error);
        connected = true;
        record.job = `${100000 + ++jobs}/QUSER/QZDASOINIT`;
        return reply(id, { job: record.job, success: true });
      }

      fake.requests.push({ ...request, profile });
      switch (request.type) {
        case "sql":
        case "prepare_sql_execute": {
          if (!connected) return fail(id, "Not connected");
          const sql = String(request.sql);
          const answer: StatementReply = fake.statements.find(({ match }) =>
            sql.includes(match),
          )?.reply ?? { rows: [] };
          if (answer === "no_reply") return;
          if (answer === "close") return client.terminate();
          if ("error" in answer) {
            // mapepire-server serialises a missing SQL state as null.
            return fail(id, answer.error, {
              sql_state: answer.sqlState ?? null,
              sql_rc: answer.sqlRc ?? 0,
            });
          }
          if ("updateCount" in answer) {
            return reply(id, {
              has_results: false,
              update_count: answer.updateCount,
              success: true,
            });
          }
          const rows = [...answer.rows];
          cursors.set(id, rows);
          const columns = Object.keys(rows[0] ?? {}).map((name) => ({
            name,
            label: name,
            type: "VARCHAR",
          }));
          return reply(id, {
            has_results: true,
            update_count: -1,
            metadata: { column_count: columns.length, columns },
            ...page(rows, request.rows),
            success: true,
          });
        }
        case "sqlmore": {
          const rows = cursors.get(String(request.cont_id));
          if (!rows) return fail(id, "invalid correlation ID");
          return reply(id, { ...page(rows, request.rows), success: true });
        }
        case "sqlclose":
          if (!cursors.delete(String(request.cont_id))) {
            return fail(id, "invalid correlation ID");
          }
          return reply(id, { success: true });
        case "exit":
          connected = false;
          return reply(id, { success: true });
        default:
          return fail(id, `Unknown request type: ${request.type}`);
      }
    });
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  (fake as { port: number }).port = (server.address() as AddressInfo).port;
  return fake;
}

// --- The same server in a worker thread ---------------------------------------

function ask<T>(worker: Worker, question: "state" | "stop"): Promise<T> {
  return new Promise((resolve) => {
    worker.once("message", resolve);
    worker.postMessage(question);
  });
}

/**
 * The handle of a started worker. A function of its own, so that the
 * closures it returns do not keep the options, and the passwords in them,
 * reachable in this thread.
 */
function isolatedHandle(worker: Worker): Promise<IsolatedFakeMapepire> {
  return new Promise((resolve, reject) => {
    worker.once("error", reject);
    worker.once(
      "message",
      (ready: Pick<IsolatedFakeMapepire, "port" | "certPem" | "caPem">) =>
        resolve({
          ...ready,
          state: () => ask(worker, "state"),
          stop: async () => {
            await ask(worker, "stop");
            await worker.terminate();
          },
        }),
    );
  });
}

/** Starts the fake in a worker thread, outside this thread's heap. */
export function startIsolatedFakeMapepire(
  options: FakeMapepireOptions = {},
): Promise<IsolatedFakeMapepire> {
  return isolatedHandle(
    new Worker(new URL(import.meta.url), {
      workerData: { fakeMapepire: options },
    }),
  );
}

const isolated = isMainThread
  ? undefined
  : (workerData as { fakeMapepire?: FakeMapepireOptions } | null)?.fakeMapepire;
if (isolated && parentPort) {
  const port = parentPort;
  const fake = await startFakeMapepire(isolated);
  port.on("message", async (question: "state" | "stop") => {
    if (question === "stop") await fake.stop();
    const state: FakeMapepireState = {
      upgrades: fake.upgrades,
      httpRequests: fake.httpRequests,
      connects: fake.connects,
      requests: fake.requests,
    };
    port.postMessage(state);
  });
  port.postMessage({
    port: fake.port,
    certPem: fake.certPem,
    caPem: fake.caPem,
  });
}

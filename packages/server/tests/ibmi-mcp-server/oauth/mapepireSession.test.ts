/**
 * @fileoverview Tests for the Mapepire client of the built-in OAuth sign-on,
 * driven against the fake Mapepire server. No IBM i is contacted and every
 * credential is made up.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import v8 from "node:v8";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONNECT_REPLY_TIMEOUT_MS,
  HANDSHAKE_TIMEOUT_MS,
  SOCKET_TERMINATE_AFTER_MS,
  STATEMENT_TIMEOUT_MS,
  type MapepireSession,
  type MapepireTarget,
  type MapepireTrust,
  type SessionCloseReason,
} from "../../../src/ibmi-mcp-server/oauth/contracts.js";
import { createMapepireClient } from "../../../src/ibmi-mcp-server/oauth/mapepireSession.js";
import {
  JsonRpcErrorCode,
  McpError,
} from "../../../src/types-global/errors.js";
import {
  FAKE_PASSWORD,
  FAKE_PROFILE,
  startFakeMapepire,
  startIsolatedFakeMapepire,
  type FakeMapepire,
  type SignOnBehaviour,
} from "./fakeMapepire.js";
import { hasOwnMemory } from "./ownMemory.js";

let fake: FakeMapepire;

beforeEach(async () => {
  fake = await startFakeMapepire();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await fake.stop();
});

const pin = (pem: string): MapepireTrust => ({
  kind: "pin",
  pem: Buffer.from(pem),
});

function clientFor(
  server: { port: number; certPem: string } = fake,
  target: Partial<MapepireTarget> = {},
) {
  return createMapepireClient({
    host: "127.0.0.1",
    port: server.port,
    trust: pin(server.certPem),
    ...target,
  });
}

function signOn(client = clientFor(), profile = FAKE_PROFILE) {
  return client.signOn(profile, Buffer.from(FAKE_PASSWORD), "grant-1");
}

async function openSession(client = clientFor()): Promise<MapepireSession> {
  const outcome = await signOn(client);
  if (outcome.class !== "ok") throw new Error(`sign-on was ${outcome.class}`);
  return outcome.session;
}

/** Waits on real I/O, also while `setTimeout` is faked. */
async function until(condition: () => boolean): Promise<void> {
  while (!condition()) await new Promise((resolve) => setImmediate(resolve));
}

/** Lets a request the client may have sent reach the fake. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

/** Fakes the timers the client sets; sockets keep running in real time. */
function fakeTimers(): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
}

function closeReasons(session: MapepireSession): SessionCloseReason[] {
  const reasons: SessionCloseReason[] = [];
  session.onClose((reason) => reasons.push(reason));
  return reasons;
}

async function rejection(promise: Promise<unknown>): Promise<McpError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(McpError);
  return error as McpError;
}

describe("sign-on", () => {
  it("is one WebSocket connect and one connect request tagged with the grant", async () => {
    const session = await openSession();

    expect(fake.upgrades).toBe(1);
    expect(fake.connects).toEqual([
      {
        profile: FAKE_PROFILE,
        passwordMatched: true,
        application: "ibmi-mcp/grant-1",
        technique: "tcp",
        props: "prompt=false",
        job: session.jobName,
      },
    ]);
    expect(session.jobName).toMatch(/^\d{6}\/QUSER\/QZDASOINIT$/);
    expect(session.isOpen).toBe(true);
  });

  it("asks Mapepire for nothing else: no HTTP request and no version", async () => {
    const session = await openSession();
    await session.execute("VALUES 1");

    expect(fake.httpRequests).toBe(0);
    expect(fake.requests.map((request) => request.type)).toEqual(["sql"]);
  });

  it("leaves the caller's password buffer as it was", async () => {
    const password = Buffer.from(FAKE_PASSWORD);

    await clientFor().signOn(FAKE_PROFILE, password, "grant-1");

    expect(password.toString()).toBe(FAKE_PASSWORD);
  });

  const hostServerText = (reason: string, profile = FAKE_PROFILE) => ({
    reply: {
      success: false,
      error: `java.sql.SQLException: Der Anwendungsserver hat die Verbindung abgelehnt. (${reason}:${profile})`,
    },
  });

  /** What jt400 reports for a rejected sign-on, in the form the test names. */
  const rejectionText = (reason: string, suffix: string) => ({
    reply: {
      success: false,
      error: `java.sql.SQLNonTransientConnectionException: The application server rejected the connection. (${reason}${suffix})`,
    },
  });
  /** The host servers' form, as mapepire-server 2.3.2 on a real system returns it. */
  const HOST_FORM = `:${FAKE_PROFILE}`;
  /** The native sign-on's form. */
  const NATIVE_FORM = `:USER:${FAKE_PROFILE} CPF22E2`;

  it.each<[string, SignOnBehaviour, object]>([
    [
      "an expired password",
      "expired",
      { class: "rejected", detail: "expired" },
    ],
    [
      "a disabled profile",
      "disabled",
      { class: "rejected", detail: "disabled" },
    ],
    [
      "a wrong password in the host servers' form",
      rejectionText("Password is incorrect.", HOST_FORM),
      { class: "rejected" },
    ],
    [
      "a wrong password in the native sign-on's form",
      rejectionText("Password is incorrect.", NATIVE_FORM),
      { class: "rejected" },
    ],
    [
      "an expired password in the native sign-on's form",
      rejectionText("Password is expired.", NATIVE_FORM),
      { class: "rejected", detail: "expired" },
    ],
    [
      "a disabled profile in the native sign-on's form",
      rejectionText("User ID is disabled.", NATIVE_FORM),
      { class: "rejected", detail: "disabled" },
    ],
    [
      "a native sign-on rejection naming another profile",
      rejectionText("Password is incorrect.", ":USER:OTHERUSER CPF22E2"),
      { class: "other" },
    ],
    [
      "a native sign-on rejection naming a profile this one starts",
      rejectionText("Password is incorrect.", `:USER:${FAKE_PROFILE}2 CPF22E2`),
      { class: "other" },
    ],
    [
      "a rejection in another language",
      hostServerText("Kennwort ist nicht korrekt."),
      { class: "rejected" },
    ],
    ["Mapepire's security rule", "security_rule", { class: "mapepire" }],
    ["Mapepire's Invalid Password", "invalid_password", { class: "mapepire" }],
    ["Mapepire's Not connected", "not_connected", { class: "mapepire" }],
    ["an error naming no profile", "unknown_error", { class: "other" }],
    [
      "a rejection naming another profile",
      hostServerText("Password is expired.", "OTHERUSER"),
      { class: "other" },
    ],
    [
      "a success without a job",
      { reply: { success: true } },
      { class: "other" },
    ],
    ["a socket closed before the reply", "close", { class: "other" }],
  ])("classes %s", async (_name, behaviour, expected) => {
    fake.signOn[FAKE_PROFILE] = behaviour;

    expect(await signOn()).toEqual(expected);

    // One attempt, not retried, and nothing left open.
    await until(() => fake.openSockets === 0);
    expect(fake.upgrades).toBe(1);
    expect(fake.signOns(FAKE_PROFILE)).toBe(1);
  });

  it("classes a wrong password and an unknown profile as rejected", async () => {
    const client = clientFor();

    expect(
      await client.signOn(FAKE_PROFILE, Buffer.from("wrong-Pw-000"), "g"),
    ).toEqual({ class: "rejected" });
    expect(await signOn(client, "NOSUCHUSER")).toEqual({ class: "rejected" });

    expect(fake.connects.map((connect) => connect.passwordMatched)).toEqual([
      false,
      false,
    ]);
  });

  it("classes a refused connection as pre", async () => {
    const client = clientFor();
    await fake.stop();

    expect(await signOn(client)).toEqual({ class: "pre" });
  });

  it("classes a host that cannot be one as pre", async () => {
    const client = clientFor(fake, { host: "not a host" });

    expect(await signOn(client)).toEqual({ class: "pre" });
  });

  it("gives up on a handshake that takes 10 seconds", async () => {
    fakeTimers();
    fake.signOn[FAKE_PROFILE] = "no_upgrade";
    const pending = signOn();
    await until(() => fake.upgrades === 1);

    await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS);

    expect(await pending).toEqual({ class: "pre" });
    expect(fake.connects).toEqual([]);
  });

  it("classes 20 seconds without a reply as timeout and closes the socket", async () => {
    fakeTimers();
    fake.signOn[FAKE_PROFILE] = "no_reply";
    let outcome: unknown;
    const pending = signOn().then((result) => (outcome = result));
    await until(() => fake.connects.length === 1);

    await vi.advanceTimersByTimeAsync(CONNECT_REPLY_TIMEOUT_MS - 1);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);

    expect(await pending).toEqual({ class: "timeout" });
    await until(() => fake.openSockets === 0);
    expect(fake.signOns(FAKE_PROFILE)).toBe(1);
  });

  it("abort cuts the sign-ons that have not finished, at once, and no other socket", async () => {
    // No timer runs out in this test: only `abort` ends the two sign-ons.
    fakeTimers();
    const client = clientFor();
    const signedOn = await openSession(client);
    fake.accounts.SLOWUSER = FAKE_PASSWORD;
    fake.signOn[FAKE_PROFILE] = "no_reply";
    fake.signOn.SLOWUSER = "no_upgrade";
    const unanswered = signOn(client);
    const inHandshake = signOn(client, "SLOWUSER");
    await until(() => fake.connects.length === 2 && fake.upgrades === 3);
    expect(fake.openSockets).toBe(2);

    client.abort();

    expect(await unanswered).toEqual({ class: "other" });
    expect(await inHandshake).toEqual({ class: "pre" });
    await until(() => fake.openSockets === 1);
    expect(signedOn.isOpen).toBe(true);
    await signedOn.close();
  });

  it("opens sockets outside the caller's async context", async () => {
    const requestContext = new AsyncLocalStorage<string>();
    const client = clientFor();
    const session = await requestContext.run("sign-on request", () =>
      openSession(client),
    );
    const seen = new Promise((resolve) =>
      session.onClose(() => resolve(requestContext.getStore())),
    );

    fake.drop();

    expect(await seen).toBeUndefined();
  });
});

describe("TLS trust", () => {
  it("accepts the pinned certificate under any host name", async () => {
    const elsewhere = await startFakeMapepire({
      certNames: ["ibmi.example.internal"],
    });
    try {
      expect((await signOn(clientFor(elsewhere))).class).toBe("ok");
    } finally {
      await elsewhere.stop();
    }
  });

  it("sends nothing when the certificate is not the pinned one", async () => {
    // The issuing CA as the pin: the chain verifies, the certificate differs.
    const client = clientFor(fake, { trust: pin(fake.caPem) });

    expect(await signOn(client)).toEqual({ class: "pre" });

    await settle();
    expect(fake.upgrades).toBe(0);
  });

  it("sends nothing to a server with an unrelated certificate", async () => {
    const other = await startFakeMapepire();
    try {
      const client = clientFor(fake, { trust: pin(other.certPem) });

      expect(await signOn(client)).toEqual({ class: "pre" });

      await settle();
      expect(fake.upgrades).toBe(0);
    } finally {
      await other.stop();
    }
  });

  it("accepts a certificate of the CA file that names the host", async () => {
    const client = clientFor(fake, {
      trust: { kind: "ca", pem: Buffer.from(fake.caPem) },
    });

    expect((await signOn(client)).class).toBe("ok");
    expect(fake.connects[0]?.serverName).toBeUndefined();
  });

  it("asks for a host name, not an address, as the TLS server name", async () => {
    const client = clientFor(fake, {
      host: "localhost",
      trust: { kind: "ca", pem: Buffer.from(fake.caPem) },
    });

    expect((await signOn(client)).class).toBe("ok");
    expect(fake.connects[0]?.serverName).toBe("localhost");
  });

  it("sends nothing when a certificate of the CA file names another host", async () => {
    const elsewhere = await startFakeMapepire({
      certNames: ["ibmi.example.internal"],
    });
    try {
      const client = clientFor(elsewhere, {
        trust: { kind: "ca", pem: Buffer.from(elsewhere.caPem) },
      });

      expect(await signOn(client)).toEqual({ class: "pre" });

      await settle();
      expect(elsewhere.upgrades).toBe(0);
    } finally {
      await elsewhere.stop();
    }
  });

  it("sends nothing when Node's trust store does not know the certificate", async () => {
    const client = clientFor(fake, { trust: { kind: "default" } });

    expect(await signOn(client)).toEqual({ class: "pre" });

    await settle();
    expect(fake.upgrades).toBe(0);
  });

  describe("a server with an expired self-signed certificate", () => {
    let expired: FakeMapepire;

    beforeEach(async () => {
      expired = await startFakeMapepire({
        certNames: ["ibmi.example.internal"],
        expiredSelfSignedCert: true,
      });
    });

    afterEach(() => expired.stop());

    it("is signed on to when the certificate is not verified", async () => {
      const client = clientFor(expired, { trust: { kind: "unverified" } });

      expect((await signOn(client)).class).toBe("ok");
      expect(expired.connects).toMatchObject([
        { profile: FAKE_PROFILE, passwordMatched: true },
      ]);
    });

    it.each<[string, () => MapepireTrust]>([
      ["Node's trust store", () => ({ kind: "default" })],
      [
        "the certificate as the CA file",
        () => ({ kind: "ca", pem: Buffer.from(expired.certPem) }),
      ],
      ["the certificate as the pin", () => pin(expired.certPem)],
    ])("is sent nothing when verified against %s", async (_name, trust) => {
      const client = clientFor(expired, { trust: trust() });

      expect(await signOn(client)).toEqual({ class: "pre" });

      await settle();
      expect(expired.upgrades).toBe(0);
    });
  });

  it.each([
    ["pin", "DB2i_SERVER_CERT_FILE"],
    ["ca", "DB2i_CA_FILE"],
  ] as const)("refuses a %s file without a certificate", (kind, variable) => {
    const create = () =>
      clientFor(fake, { trust: { kind, pem: Buffer.from("not a PEM") } });

    expect(create).toThrow(McpError);
    expect(create).toThrow(variable);
  });
});

describe("JDBC options", () => {
  it("sends the allowed options as the connect properties, after prompt=false", async () => {
    const client = clientFor(fake, {
      jdbcOptions: {
        naming: "system",
        libraries: ["LIB1", "LIB2"],
        "date format": "iso",
        "date separator": "-",
        "time format": "iso",
        "time separator": ":",
        "decimal separator": ".",
        "transaction isolation": "none",
        access: "read only",
      },
    });

    await signOn(client);

    expect(fake.connects[0]?.props).toBe(
      "prompt=false;naming=system;libraries=LIB1,LIB2;date format=iso;date separator=-;time format=iso;time separator=:;decimal separator=.;transaction isolation=none;access=read only",
    );
  });

  it.each(["user", "password", "secure", "proxy server", "Naming", "prompt"])(
    "refuses the option %s",
    (key) => {
      const create = () =>
        clientFor(fake, { jdbcOptions: { [key]: "QSECOFR" } as never });

      expect(create).toThrow(McpError);
      expect(create).toThrow(`"${key}"`);
    },
  );

  it("refuses a value that would start another option", () => {
    expect(() =>
      clientFor(fake, { jdbcOptions: { libraries: ["LIB1;user=QSECOFR"] } }),
    ).toThrow(McpError);
  });
});

describe("statements", () => {
  const rows = [1, 2, 3, 4, 5].map((id) => ({ ID: id }));

  it("returns the first page and fetches the rest by statement id", async () => {
    fake.statements = [{ match: "FROM SAMPLE", reply: { rows } }];
    const session = await openSession();

    const first = await session.execute("SELECT ID FROM SAMPLE", undefined, 2);
    const second = await session.fetchMore(first.id, 2);
    const third = await session.fetchMore(first.id, 2);
    await session.closeStatement(first.id);

    expect(first).toMatchObject({
      success: true,
      has_results: true,
      is_done: false,
      data: [{ ID: 1 }, { ID: 2 }],
      metadata: { column_count: 1, columns: [{ name: "ID" }] },
    });
    expect(second).toMatchObject({
      is_done: false,
      data: [{ ID: 3 }, { ID: 4 }],
    });
    expect(third).toMatchObject({ is_done: true, data: [{ ID: 5 }] });
    expect(fake.requests).toMatchObject([
      { type: "sql", sql: "SELECT ID FROM SAMPLE", rows: 2 },
      { type: "sqlmore", cont_id: first.id, rows: 2 },
      { type: "sqlmore", cont_id: first.id, rows: 2 },
      { type: "sqlclose", cont_id: first.id },
    ]);
  });

  it("prepares a statement that has parameters and asks for 100 rows by default", async () => {
    const session = await openSession();

    await session.execute("SELECT ID FROM SAMPLE WHERE ID = ?", [3]);

    expect(fake.requests).toMatchObject([
      { type: "prepare_sql_execute", parameters: [3], rows: 100 },
    ]);
  });

  it("reports a statement without a result set as done", async () => {
    fake.statements = [{ match: "UPDATE", reply: { updateCount: 4 } }];
    const session = await openSession();

    const result = await session.execute("UPDATE SAMPLE SET ID = 0");

    expect(result).toMatchObject({
      has_results: false,
      update_count: 4,
      is_done: true,
    });
  });

  it("throws the IBM i message of a failed statement", async () => {
    fake.statements = [
      {
        match: "NOPE",
        reply: {
          error: "[SQL0204] NOPE in QGPL type *FILE not found.",
          sqlState: "42704",
          sqlRc: -204,
        },
      },
    ];
    const session = await openSession();

    const error = await rejection(session.execute("SELECT * FROM QGPL.NOPE"));

    expect(error.code).toBe(JsonRpcErrorCode.DatabaseError);
    expect(error.message).toBe(
      "[SQL0204] NOPE in QGPL type *FILE not found., 42704, -204",
    );
    expect(session.isOpen).toBe(true);
  });

  it("leaves a null SQL state out of the message", async () => {
    fake.statements = [{ match: "NOPE", reply: { error: "Not allowed" } }];
    const session = await openSession();

    const error = await rejection(session.execute("CALL NOPE()"));

    expect(error.message).toBe("Not allowed, 0");
  });

  it("abandons a statement after 120 seconds by closing the socket", async () => {
    fakeTimers();
    fake.statements = [{ match: "SLOW", reply: "no_reply" }];
    const session = await openSession();
    const reasons = closeReasons(session);
    const failed = rejection(session.execute("CALL SLOW()"));
    await until(() => fake.requests.length === 1);

    await vi.advanceTimersByTimeAsync(STATEMENT_TIMEOUT_MS - 1);
    expect(session.isOpen).toBe(true);
    await vi.advanceTimersByTimeAsync(1);

    const error = await failed;
    expect(error.code).toBe(JsonRpcErrorCode.Timeout);
    expect(error.message).toContain(session.jobName);
    expect(session.isOpen).toBe(false);
    await until(() => fake.openSockets === 0);
    expect(reasons).toEqual(["abandoned"]);
    expect((await rejection(session.execute("VALUES 1"))).code).toBe(
      JsonRpcErrorCode.ServiceUnavailable,
    );
  });

  it("fails a statement whose socket is lost before the reply", async () => {
    fake.statements = [{ match: "DROP", reply: "close" }];
    const session = await openSession();
    const reasons = closeReasons(session);

    const error = await rejection(session.execute("CALL DROPME()"));

    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(reasons).toEqual(["lost"]);
    expect(session.isOpen).toBe(false);
  });
});

describe("liveness and close", () => {
  it("resolves a ping to true when the pong arrives", async () => {
    const session = await openSession();

    expect(await session.ping()).toBe(true);
  });

  it("resolves a ping to false after 10 seconds without a pong, and stays open", async () => {
    fakeTimers();
    const session = await openSession();
    fake.stall();
    let alive: boolean | undefined;
    const pinged = session.ping().then((result) => (alive = result));

    await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS - 1);
    expect(alive).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);

    expect(await pinged).toBe(false);
    expect(session.isOpen).toBe(true);
  });

  it("tells the listener once when the server drops the socket", async () => {
    const session = await openSession();
    const replaced = closeReasons(session);
    const reasons = closeReasons(session);

    fake.drop();
    await until(() => reasons.length > 0);

    expect(reasons).toEqual(["lost"]);
    expect(replaced).toEqual([]);
    expect(session.isOpen).toBe(false);
    expect(await session.ping()).toBe(false);
  });

  it("tells a listener registered after the socket is gone, and no second one", async () => {
    const session = await openSession();
    fake.drop();
    await until(() => !session.isOpen);

    const reasons = closeReasons(session);
    await until(() => reasons.length > 0);
    const later = closeReasons(session);
    await settle();

    expect(reasons).toEqual(["lost"]);
    expect(later).toEqual([]);
  });

  it("sends exit and closes", async () => {
    const session = await openSession();
    const reasons = closeReasons(session);

    await session.close();
    await session.close();

    expect(fake.requests).toMatchObject([{ type: "exit" }]);
    expect(reasons).toEqual(["closed"]);
    expect(session.isOpen).toBe(false);
    await until(() => fake.openSockets === 0);
    expect((await rejection(session.execute("VALUES 1"))).code).toBe(
      JsonRpcErrorCode.ServiceUnavailable,
    );
  });

  it("terminates a socket that has not closed after 2 seconds", async () => {
    fakeTimers();
    const session = await openSession();
    fake.stall();
    let closed = false;
    const closing = session.close().then(() => (closed = true));

    await vi.advanceTimersByTimeAsync(SOCKET_TERMINATE_AFTER_MS - 1);
    expect(closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await closing;
    expect(closed).toBe(true);
  });

  it("sends only statements, exit and the one connect", async () => {
    const session = await openSession();

    const result = await session.execute("VALUES 1", undefined, 1);
    await session.execute("VALUES ?", [1]);
    await session.fetchMore(result.id);
    await session.closeStatement(result.id);
    await session.ping();
    await session.close();

    expect(fake.connects).toHaveLength(1);
    expect(fake.requests.map((request) => request.type)).toEqual([
      "sql",
      "prepare_sql_execute",
      "sqlmore",
      "sqlclose",
      "exit",
    ]);
  });
});

describe("the password in memory", () => {
  it.each([
    ["a short password", FAKE_PASSWORD],
    ["a password of 128 characters", "long-Pw-".repeat(16)],
  ])(
    "is copied only into buffers outside the V8 heap and the pool that are zero-filled: %s",
    async (_, text) => {
      fake.accounts[FAKE_PROFILE] = text;
      const password = Buffer.from(text);
      const allocate = vi.spyOn(Buffer, "allocUnsafeSlow");

      const outcome = await clientFor().signOn(FAKE_PROFILE, password, "g");

      const allocated = allocate.mock.results.map(
        (result) => result.value as Buffer,
      );
      expect(outcome.class).toBe("ok");
      expect(fake.connects[0]?.passwordMatched).toBe(true);
      // PROFILE:password and the header. A short one is a view of a longer
      // allocation: V8 would keep up to 64 bytes inside its heap.
      expect(allocated).toHaveLength(2);
      for (const buffer of allocated) {
        expect(hasOwnMemory(buffer)).toBe(true);
        expect(buffer.every((byte) => byte === 0)).toBe(true);
      }
    },
  );

  /** The password of the heap test. No literal: source text is in the heap too. */
  function heapPassword(firstLetter = 0x61): Buffer {
    const bytes = Buffer.allocUnsafeSlow(24);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = firstLetter + ((i * 7 + 3) % 26);
    }
    return bytes;
  }

  /** Every string a V8 heap snapshot lists; the snapshot starts with a full GC. */
  async function heapStrings(): Promise<string[]> {
    const chunks: Buffer[] = [];
    for await (const chunk of v8.getHeapSnapshot())
      chunks.push(chunk as Buffer);
    const snapshot = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      strings: string[];
    };
    return snapshot.strings;
  }

  it("leaves no string with the password or its Base64 form in the heap", async () => {
    // The fake runs in a worker so that the header it parses is not in this
    // heap. Profiles are 8 characters, so the Base64 of the password is a
    // substring of the Base64 of PROFILE:password.
    const isolated = await startIsolatedFakeMapepire({
      accounts: { HEAPUSER: heapPassword().toString("latin1") },
    });
    try {
      const pool = Buffer.allocUnsafe(1).buffer;
      const password = heapPassword();
      const good = clientFor(isolated);
      const signedOn = await good.signOn("HEAPUSER", password, "heap-1");
      const rejected = await good.signOn("HEAPNONE", password, "heap-2");
      const refused = await clientFor(isolated, {
        trust: pin(isolated.caPem),
      }).signOn("HEAPUSER", password, "heap-3");
      password.fill(0);
      // A string that is reachable on purpose: the search must find it.
      const canary = heapPassword(0x41).toString("latin1");
      await new Promise((resolve) => setTimeout(resolve, 300));

      const strings = await heapStrings();

      const plain = heapPassword().toString("latin1");
      const base64 = heapPassword().toString("base64");
      const count = (needle: string) =>
        strings.filter((text) => text.includes(needle)).length;
      expect([signedOn.class, rejected.class, refused.class]).toEqual([
        "ok",
        "rejected",
        "pre",
      ]);
      if (signedOn.class !== "ok") throw new Error("not signed on");
      expect(signedOn.session.isOpen).toBe(true);
      expect((await isolated.state()).connects).toMatchObject([
        { profile: "HEAPUSER", passwordMatched: true },
        { profile: "HEAPNONE", passwordMatched: false },
      ]);
      expect(count(canary)).toBeGreaterThan(0);
      expect(count(signedOn.session.jobName)).toBeGreaterThan(0);
      expect({
        plain: count(plain),
        plainPart: count(plain.slice(0, 12)),
        base64: count(base64),
        base64Part: count(base64.slice(4, 24)),
      }).toEqual({ plain: 0, plainPart: 0, base64: 0, base64Part: 0 });
      // Nor are its bytes in the Buffer pool, before or after.
      for (const slab of [pool, Buffer.allocUnsafe(1).buffer]) {
        expect(Buffer.from(slab).includes(heapPassword())).toBe(false);
      }
    } finally {
      await isolated.stop();
    }
  }, 120_000);

  it("does not load mapepire-js", () => {
    const source = readFileSync(
      new URL(
        "../../../src/ibmi-mcp-server/oauth/mapepireSession.ts",
        import.meta.url,
      ),
      "utf8",
    );

    expect(source).not.toMatch(/^import (?!type\b)[^;]*"@ibm\/mapepire-js"/m);
  });
});

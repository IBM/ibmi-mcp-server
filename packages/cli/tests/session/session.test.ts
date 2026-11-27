/**
 * @fileoverview SSH sessions of the CLI: a command opens a session host, later
 * commands reuse it, and errors, timeouts and idle time close it. The host
 * runs in this process on a real Unix socket; only the IBM i connection is
 * faked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import path from "path";
import { McpError } from "@ibm/ibmi-mcp-server/services";
import type { ResolvedSystem } from "../../src/config/types.js";
import {
  connectSession,
  currentSocket,
  listSessions,
  stopSession,
  type SessionClient,
} from "../../src/session/client.js";
import { startSessionHost, type SessionHost } from "../../src/session/host.js";
import { sessionFiles, type SessionFiles } from "../../src/session/paths.js";
import type { QueryRequest } from "../../src/session/protocol.js";

const unix = process.platform !== "win32";

describe.runIf(unix)("SSH sessions", () => {
  const originalHome = process.env.HOME;
  let home: string;
  let system: ResolvedSystem;
  let clients: SessionClient[];
  let hosts: SessionHost[];
  let stopped: number[];
  let connect: ReturnType<typeof vi.fn<() => Promise<void>>>;
  let execute: ReturnType<typeof vi.fn<(r: QueryRequest) => Promise<unknown>>>;
  let close: ReturnType<typeof vi.fn<() => Promise<void>>>;
  let idleTimeoutMs: number;

  /** Starts the session host in this process, as `ibmi session-host` would. */
  const spawnHost = vi.fn((resolved: ResolvedSystem, files: SessionFiles) => {
    void startSessionHost({
      socketPath: files.socket,
      info: {
        system: resolved.name,
        host: resolved.config.host,
        user: resolved.config.user,
        technique: "tcp",
        version: "test",
      },
      idleTimeoutMs,
      connect,
      execute,
      close,
      log: () => {},
      onStopped: (code) => stopped.push(code),
    }).then(
      (host) => hosts.push(host),
      (error: NodeJS.ErrnoException) => {
        // A second host for the same socket exits, as the real one does
        if (error.code !== "EADDRINUSE") throw error;
      },
    );
  });

  /**
   * The sessions of this test. listSessions() also lists the user's own
   * sessions in /tmp/ibmi-<uid>, which a test must not touch.
   */
  const ownSessions = async () =>
    (await listSessions()).filter((s) => s.socket.startsWith(home));

  const open = async () => {
    const client = await connectSession(system, { spawnHost });
    clients.push(client);
    return client;
  };

  beforeEach(() => {
    // A short path, so the socket stays in this home and never in the
    // shared /tmp/ibmi-<uid> (the macOS temp dir is too long for a socket)
    home = mkdtempSync("/tmp/ibmi-t-");
    process.env.HOME = home;
    const key = path.join(home, "id_test");
    writeFileSync(key, "fake-private-key");
    system = {
      name: "dev",
      source: "flag",
      config: {
        host: "dev.example.com",
        port: 8076,
        user: "MYUSER",
        sshKey: key,
        readOnly: false,
        confirm: false,
        timeout: 60,
        maxRows: 5000,
        ignoreUnauthorized: true,
      },
    };
    clients = [];
    hosts = [];
    stopped = [];
    idleTimeoutMs = 60_000;
    spawnHost.mockClear();
    connect = vi.fn(async () => {});
    execute = vi.fn(async (request: QueryRequest) => ({
      success: true,
      data: [{ SQL: request.sql }],
    }));
    close = vi.fn(async () => {});
  });

  afterEach(async () => {
    for (const client of clients) client.close();
    await Promise.all(hosts.map((host) => host.stop("test end")));
    process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("opens a session on the first command and reuses it for the next", async () => {
    const first = await open();
    await expect(first.executeQuery("VALUES 1")).resolves.toEqual({
      success: true,
      data: [{ SQL: "VALUES 1" }],
    });
    first.close();

    const second = await open();
    await second.executeQueryWithPagination("VALUES 2", ["a"], undefined, 50);

    expect(spawnHost).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sql: "VALUES 2",
        params: ["a"],
        rowsToFetch: 50,
        paginate: true,
      }),
    );
  });

  it("gives two commands that start together one session", async () => {
    connect.mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 100)),
    );
    await Promise.all([open(), open()]);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(hosts).toHaveLength(1);
  });

  it("makes the socket and its directory private to the user", async () => {
    await open();
    const socket = currentSocket(system);
    expect(statSync(socket).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(socket)).mode & 0o777).toBe(0o700);
  });

  it("returns an SQL error to the command and keeps the session open", async () => {
    execute.mockRejectedValueOnce(
      new McpError(-32010, "[SQL0204] NOPE in QGPL type *FILE not found."),
    );
    const client = await open();

    const error = await client
      .executeQuery("SELECT * FROM NOPE")
      .catch((e) => e);
    expect(error).toBeInstanceOf(McpError);
    expect(error).toMatchObject({ code: -32010 });
    expect(error.message).toContain("SQL0204");

    await expect(client.executeQuery("VALUES 1")).resolves.toBeDefined();
    expect(stopped).toEqual([]);
  });

  it("closes the session after a statement times out", async () => {
    execute.mockRejectedValueOnce(new McpError(-32004, "Query timed out"));
    const client = await open();

    await expect(client.executeQuery("CALL SLOW()")).rejects.toMatchObject({
      code: -32004,
    });
    await vi.waitFor(() => expect(stopped).toEqual([1]));
    expect(close).toHaveBeenCalledTimes(1);
    expect(existsSync(currentSocket(system))).toBe(false);

    // The next command opens a new session
    await open();
    expect(spawnHost).toHaveBeenCalledTimes(2);
  });

  it("gives the command the error when the session cannot connect", async () => {
    connect.mockRejectedValue(
      new McpError(
        -32009,
        "IBM i sign-on failed: the system rejected the key.",
      ),
    );
    const error = await open().catch((e) => e);
    expect(error).toBeInstanceOf(McpError);
    expect(error).toMatchObject({ code: -32009 });
    expect(error.message).toContain("rejected the key");
    await vi.waitFor(() => expect(stopped).toEqual([1]));
  });

  it("closes an idle session", async () => {
    idleTimeoutMs = 150;
    await open();
    await vi.waitFor(() => expect(stopped).toEqual([0]), { timeout: 2_000 });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("tells a command that waits for the session that it was closed", async () => {
    connect.mockImplementation(() => new Promise(() => {}));
    const waiting = open().catch((e) => e);
    await vi.waitFor(async () => expect(await ownSessions()).toHaveLength(1));

    await stopSession(currentSocket(system));

    const error = await waiting;
    expect(error).toBeInstanceOf(McpError);
    expect(error.message).toContain("The SSH session was closed (disconnect)");
    // No second session host was started
    expect(spawnHost).toHaveBeenCalledTimes(1);
  });

  it("lists open sessions and closes one", async () => {
    await open();
    const sessions = await ownSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.info).toMatchObject({
      system: "dev",
      host: "dev.example.com",
      user: "MYUSER",
      state: "open",
      idleTimeoutSeconds: 60,
    });

    await expect(stopSession(sessions[0]!.socket)).resolves.toBe(true);
    await vi.waitFor(() => expect(stopped).toEqual([0]));
    expect(await ownSessions()).toEqual([]);
  });

  it("replaces the socket file of a session host that died", async () => {
    const socket = currentSocket(system);
    await open();
    clients[0]!.close();
    // A host killed with SIGKILL leaves its socket file behind
    await hosts.pop()!.stop("test");
    writeFileSync(socket, "");

    await open();
    expect(spawnHost).toHaveBeenCalledTimes(2);
  });

  it("puts the socket in /tmp/ibmi-<uid> when the home path is too long", () => {
    process.env.HOME = path.join(home, "x".repeat(80));
    const { socket, log } = sessionFiles(system, "1.0.0");
    expect(path.dirname(socket)).toBe(`/tmp/ibmi-${process.getuid!()}`);
    expect(log.startsWith(path.join(process.env.HOME, ".ibmi", "run"))).toBe(
      true,
    );
  });

  it("refuses a socket directory that is a link", async () => {
    const { ensurePrivateDir } = await import("../../src/session/paths.js");
    const target = path.join(home, "elsewhere");
    const link = path.join(home, "link");
    mkdirSync(target);
    symlinkSync(target, link);
    expect(() => ensurePrivateDir(link)).toThrow(/is not a directory/);
  });

  it("uses another session when the settings change", () => {
    const tcp = sessionFiles(system, "1.0.0").socket;
    const cli = sessionFiles(
      { ...system, config: { ...system.config, sshTechnique: "cli" } },
      "1.0.0",
    ).socket;
    const otherHost = sessionFiles(
      { ...system, config: { ...system.config, host: "test.example.com" } },
      "1.0.0",
    ).socket;
    const newVersion = sessionFiles(system, "1.0.1").socket;

    expect(sessionFiles(system, "1.0.0").socket).toBe(tcp);
    expect(new Set([tcp, cli, otherHost, newVersion]).size).toBe(4);
    expect(path.basename(tcp)).toMatch(/^dev-[0-9a-f]{12}\.sock$/);
  });
});

/**
 * @fileoverview `ibmi session-host`, the real session host command, over a
 * real socket: what it takes from the environment, how it runs statements on
 * the server's connection pool, and how it stops. The pool is faked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import path from "path";

const { pool } = vi.hoisted(() => ({
  pool: {
    executeQuery: vi.fn(async (sql: string) => ({
      success: true,
      data: [{ SQL: sql }],
    })),
    executeQueryWithPagination: vi.fn(async () => ({
      success: true,
      data: [{ A: 1 }, { A: 2 }],
      truncated: false,
    })),
    close: vi.fn(async () => {}),
  },
}));

vi.mock("@ibm/ibmi-mcp-server/services", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@ibm/ibmi-mcp-server/services")>()),
  IBMiConnectionPool: pool,
}));

import { createProgram } from "../../src/program.js";
import type { ResolvedSystem } from "../../src/config/types.js";
import {
  SESSION_ENV,
  connectSession,
  listSessions,
  stopSession,
  type SessionClient,
} from "../../src/session/client.js";
import { ensurePrivateDir, sessionFiles } from "../../src/session/paths.js";
import { getVersion } from "../../src/version.js";

const unix = process.platform !== "win32";

describe.runIf(unix)("ibmi session-host", () => {
  const originalEnv = { ...process.env };
  let home: string;
  let system: ResolvedSystem;
  let exit: ReturnType<typeof vi.spyOn>;
  let client: SessionClient | undefined;

  /**
   * The sessions of this test. listSessions() also lists the user's own
   * sessions in /tmp/ibmi-<uid>, which a test must not touch.
   */
  const ownSessions = async () =>
    (await listSessions()).filter((s) => s.socket.startsWith(home));
  const stopOwnSessions = async () => {
    for (const session of await ownSessions()) {
      await stopSession(session.socket);
    }
  };

  /** Runs `ibmi session-host` with the environment a command hands over. */
  const startHost = async () => {
    const files = sessionFiles(system, getVersion());
    ensurePrivateDir(path.dirname(files.socket));
    process.env[SESSION_ENV.system] = JSON.stringify(system);
    process.env[SESSION_ENV.socket] = files.socket;
    process.env[SESSION_ENV.log] = files.log;
    await createProgram().parseAsync(["node", "ibmi", "session-host"]);
    return files;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    home = mkdtempSync("/tmp/ibmi-h-");
    process.env.HOME = home;
    process.env.DB2i_PASS = "from-the-shell";
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
        sshTechnique: "cli",
        readOnly: false,
        confirm: false,
        timeout: 60,
        maxRows: 5000,
        ignoreUnauthorized: true,
      },
    };
    // The host ends its process when it stops
    exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
  });

  afterEach(async () => {
    client?.close();
    client = undefined;
    await stopOwnSessions();
    exit.mockRestore();
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
      process.removeAllListeners(signal);
    }
    // Restore the real environment in place: a new process.env object would
    // no longer reach os.homedir(), which the session paths use
    for (const name of Object.keys(process.env)) {
      if (!(name in originalEnv)) delete process.env[name];
    }
    Object.assign(process.env, originalEnv);
    rmSync(home, { recursive: true, force: true });
  });

  it("connects with the system it is handed, over SSH and without a password", async () => {
    await startHost();
    client = await connectSession(system, { spawnHost: vi.fn() });

    expect(pool.executeQuery).toHaveBeenCalledWith(
      "VALUES 1",
      [],
      expect.objectContaining({ toolName: "session_open" }),
    );
    expect(process.env).toMatchObject({
      DB2i_HOST: "dev.example.com",
      DB2i_USER: "MYUSER",
      DB2i_SSH_KEY: system.config.sshKey,
      DB2i_SSH_TECHNIQUE: "cli",
    });
    expect(process.env.DB2i_PASS).toBeUndefined();
    expect(client.info).toMatchObject({
      system: "dev",
      technique: "cli",
      idleTimeoutSeconds: 600,
    });
  });

  it("runs single-fetch and paginated statements on the pool", async () => {
    await startHost();
    client = await connectSession(system, { spawnHost: vi.fn() });

    await expect(
      client.executeQuery(
        "SELECT 1",
        ["p"],
        { toolName: "execute_sql" } as never,
        25,
      ),
    ).resolves.toEqual({ success: true, data: [{ SQL: "SELECT 1" }] });
    await expect(
      client.executeQueryWithPagination("SELECT 2", undefined, undefined, 500),
    ).resolves.toMatchObject({ data: [{ A: 1 }, { A: 2 }] });

    expect(pool.executeQuery).toHaveBeenLastCalledWith(
      "SELECT 1",
      ["p"],
      expect.objectContaining({ toolName: "execute_sql" }),
      25,
    );
    expect(pool.executeQueryWithPagination).toHaveBeenCalledWith(
      "SELECT 2",
      undefined,
      expect.anything(),
      500,
    );
  });

  it("takes its idle time from IBMI_SESSION_IDLE_SECONDS, and ignores a bad value", async () => {
    process.env.IBMI_SESSION_IDLE_SECONDS = "90";
    await startHost();
    client = await connectSession(system, { spawnHost: vi.fn() });
    expect(client.info.idleTimeoutSeconds).toBe(90);
    client.close();
    await stopOwnSessions();

    process.env.IBMI_SESSION_IDLE_SECONDS = "soon";
    await startHost();
    client = await connectSession(system, { spawnHost: vi.fn() });
    expect(client.info.idleTimeoutSeconds).toBe(600);
  });

  it("closes the pool, removes its socket and exits when it is closed", async () => {
    const files = await startHost();
    client = await connectSession(system, { spawnHost: vi.fn() });

    await expect(stopSession(files.socket)).resolves.toBe(true);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(pool.close).toHaveBeenCalled();
    expect(await ownSessions()).toEqual([]);
  });

  it("does nothing when it is started by hand", async () => {
    delete process.env[SESSION_ENV.system];
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    await createProgram().parseAsync(["node", "ibmi", "session-host"]);
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining("started by other commands"),
    );
    expect(process.exitCode).toBe(2);
    process.exitCode = undefined;
    stderr.mockRestore();
  });
});

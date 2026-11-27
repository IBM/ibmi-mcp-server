/**
 * @fileoverview connectSystem for a system with an SSH key: key only, no
 * password, and an SSH session unless the command asks for a fresh one.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

const { connectSession, setServiceQueryExecutor, resolvePassword, close } =
  vi.hoisted(() => ({
    connectSession: vi.fn(),
    setServiceQueryExecutor: vi.fn(),
    resolvePassword: vi.fn(async () => "prompted-password"),
    close: vi.fn(async () => {}),
  }));

vi.mock("../../src/session/client.js", () => ({ connectSession }));
vi.mock("../../src/config/credentials.js", () => ({ resolvePassword }));
vi.mock("@ibm/ibmi-mcp-server/services", () => ({
  setServiceQueryExecutor,
  IBMiConnectionPool: { close },
}));

import { connectSystem } from "../../src/utils/connection.js";
import type { ResolvedSystem } from "../../src/config/types.js";

describe("connectSystem with an SSH key", () => {
  const originalEnv = { ...process.env };
  let dir: string;
  let system: ResolvedSystem;

  beforeEach(() => {
    vi.clearAllMocks();
    dir = mkdtempSync(path.join(tmpdir(), "ibmi-ssh-"));
    const key = path.join(dir, "id_test");
    writeFileSync(key, "fake-private-key");
    system = {
      name: "dev",
      source: "flag",
      config: {
        host: "dev.example.com",
        port: 8076,
        user: "MYUSER",
        password: "unused-password",
        sshKey: key,
        sshHostKeySha256: "SHA256:abc",
        sshTechnique: "cli",
        readOnly: false,
        confirm: false,
        timeout: 60,
        maxRows: 5000,
        ignoreUnauthorized: true,
      },
    };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    rmSync(dir, { recursive: true, force: true });
  });

  it("sends its statements to the SSH session and asks for no password", async () => {
    const session = { close: vi.fn() };
    connectSession.mockResolvedValue(session);
    process.env.DB2i_PASS = "from-the-shell";

    const cleanup = await connectSystem(system);

    expect(resolvePassword).not.toHaveBeenCalled();
    expect(connectSession).toHaveBeenCalledWith(system);
    expect(setServiceQueryExecutor).toHaveBeenLastCalledWith(session);
    expect(process.env.DB2i_PASS).toBeUndefined();
    expect(process.env).toMatchObject({
      DB2i_HOST: "dev.example.com",
      DB2i_USER: "MYUSER",
      DB2i_SSH_KEY: system.config.sshKey,
      DB2i_SSH_HOST_KEY_SHA256: "SHA256:abc",
      DB2i_SSH_TECHNIQUE: "cli",
    });

    await cleanup();
    expect(setServiceQueryExecutor).toHaveBeenLastCalledWith(undefined);
    expect(session.close).toHaveBeenCalled();
  });

  it("connects in the command with --fresh", async () => {
    const cleanup = await connectSystem(system, { fresh: true });
    expect(connectSession).not.toHaveBeenCalled();
    expect(process.env.DB2i_SSH_KEY).toBe(system.config.sshKey);
    await cleanup();
    expect(close).toHaveBeenCalled();
  });

  it("connects in the command when keepSession is false", async () => {
    system.config.keepSession = false;
    await connectSystem(system);
    expect(connectSession).not.toHaveBeenCalled();
  });

  it("stops with a clear error when the key cannot be read", async () => {
    system.config.sshKey = path.join(dir, "missing");
    await expect(connectSystem(system)).rejects.toThrow(
      /Cannot read the SSH key of system "dev"/,
    );
    expect(connectSession).not.toHaveBeenCalled();
  });

  it("does not give one system's host key pin or technique to the next", async () => {
    await connectSystem(system, { fresh: true });
    expect(process.env.DB2i_SSH_HOST_KEY_SHA256).toBe("SHA256:abc");

    const {
      sshHostKeySha256: _pin,
      sshTechnique: _technique,
      ...other
    } = system.config;
    await connectSystem(
      {
        ...system,
        name: "test",
        config: { ...other, host: "test.example.com" },
      },
      { fresh: true },
    );
    expect(process.env.DB2i_SSH_HOST_KEY_SHA256).toBeUndefined();
    expect(process.env.DB2i_SSH_TECHNIQUE).toBeUndefined();
  });

  it("keeps a password system off SSH when the shell sets DB2i_SSH_KEY", async () => {
    process.env.DB2i_SSH_KEY = "/some/key";
    const { sshKey: _key, ...config } = system.config;
    await connectSystem({ ...system, config });

    expect(process.env.DB2i_SSH_KEY).toBeUndefined();
    expect(process.env.DB2i_PASS).toBe("prompted-password");
    expect(connectSession).not.toHaveBeenCalled();
  });
});

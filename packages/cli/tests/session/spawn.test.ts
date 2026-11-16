/**
 * @fileoverview What a command hands to a new session host process.
 */

import { describe, expect, it, vi } from "vitest";

const { spawn, unref } = vi.hoisted(() => {
  const unref = vi.fn();
  return { unref, spawn: vi.fn(() => ({ unref, once: vi.fn() })) };
});
vi.mock("child_process", () => ({ spawn }));

import { SESSION_ENV, spawnSessionHost } from "../../src/session/client.js";
import type { ResolvedSystem } from "../../src/config/types.js";

describe("spawnSessionHost", () => {
  const system: ResolvedSystem = {
    name: "dev",
    source: "flag",
    config: {
      host: "dev.example.com",
      port: 8076,
      user: "MYUSER",
      password: "s3cret-pass",
      sshKey: "~/.ssh/id_ed25519",
      readOnly: false,
      confirm: false,
      timeout: 60,
      maxRows: 5000,
      ignoreUnauthorized: true,
    },
  };

  it("starts a detached `ibmi session-host` with the system but not its password", () => {
    spawnSessionHost(system, { socket: "/run/dev.sock", log: "/run/dev.log" });

    const [command, args, options] = spawn.mock.calls[0] as unknown as [
      string,
      string[],
      { detached: boolean; stdio: string; env: Record<string, string> },
    ];
    expect(command).toBe(process.execPath);
    expect(args[0]).toMatch(/index\.js$/);
    expect(args[1]).toBe("session-host");
    expect(options).toMatchObject({ detached: true, stdio: "ignore" });
    expect(unref).toHaveBeenCalled();

    const env = options.env;
    expect(env[SESSION_ENV.socket]).toBe("/run/dev.sock");
    expect(env[SESSION_ENV.log]).toBe("/run/dev.log");
    expect(env["MCP_POOL_IDLE_TIMEOUT_MS"]).toBe("0");
    const handed = JSON.parse(env[SESSION_ENV.system]!) as ResolvedSystem;
    expect(handed.config).toMatchObject({
      host: "dev.example.com",
      user: "MYUSER",
      sshKey: "~/.ssh/id_ed25519",
    });
    expect(env[SESSION_ENV.system]).not.toContain("s3cret-pass");
  });
});

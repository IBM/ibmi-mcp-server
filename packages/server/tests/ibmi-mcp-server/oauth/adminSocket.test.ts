/**
 * @fileoverview Tests for the local admin socket of the built-in OAuth
 * sign-on, with a real grant manager against the fake Mapepire server.
 * Every credential is made up; no IBM i is involved.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../../../src/config/index.js";
import {
  sendAdminCommand,
  startAdminSocket,
} from "../../../src/ibmi-mcp-server/oauth/adminSocket.js";
import type { GrantManager } from "../../../src/ibmi-mcp-server/oauth/contracts.js";
import { createGrantManager } from "../../../src/ibmi-mcp-server/oauth/grantManager.js";
import { createMapepireClient } from "../../../src/ibmi-mcp-server/oauth/mapepireSession.js";
import {
  JsonRpcErrorCode,
  McpError,
} from "../../../src/types-global/errors.js";
import { logger } from "../../../src/utils/internal/logger.js";
import {
  FAKE_PASSWORD,
  startFakeMapepire,
  type FakeMapepire,
} from "./fakeMapepire.js";

const VERIFIER = "pkce-verifier-".repeat(4);
const WRONG_PASSWORD = "wrong-Pw-000";

let fake: FakeMapepire;
let grants: GrantManager;
let directory: string;
let path: string;
let admin: { close(): Promise<void> } | undefined;
let lines: string[];

beforeEach(async () => {
  Object.assign(config.oauth, {
    maxConnections: 50,
    allowedProfiles: [],
    allowPrivilegedProfiles: false,
    signOnMaxFailures: 2,
  });
  lines = [];
  vi.spyOn(logger, "info").mockImplementation((...args: unknown[]) => {
    lines.push(JSON.stringify(args));
  });
  fake = await startFakeMapepire({
    accounts: { TESTUSER: FAKE_PASSWORD, OTHERUSR: FAKE_PASSWORD },
    statements: [
      {
        match: "USER_INFO_BASIC",
        reply: {
          rows: [
            {
              STATUS: "*ENABLED",
              PASSWORD_CHANGE_DATE: "2026-01-01 00:00:00.000000",
              SPECIAL_AUTHORITIES: null,
            },
          ],
        },
      },
    ],
  });
  grants = createGrantManager({
    mapepire: createMapepireClient({
      host: "127.0.0.1",
      port: fake.port,
      trust: { kind: "pin", pem: Buffer.from(fake.certPem) },
    }),
  });
  directory = mkdtempSync(join(tmpdir(), "ibmi-mcp-admin-"));
  path = join(directory, "admin.sock");
  admin = undefined;
});

afterEach(async () => {
  await admin?.close();
  await grants.shutdown();
  await fake.stop();
  rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function signOn(profile: string, password = FAKE_PASSWORD) {
  return grants.signOn({
    profile: Buffer.from(profile),
    password: Buffer.from(password),
    clientId: "https://client.example/oauth/metadata.json",
    redirectUri: "http://127.0.0.1:33418/callback",
    codeChallenge: createHash("sha256").update(VERIFIER).digest("base64url"),
    address: "10.1.2.3",
  });
}

async function until(condition: () => boolean): Promise<void> {
  while (!condition()) await new Promise((resolve) => setImmediate(resolve));
}

const commandsLogged = () =>
  lines
    .map((line) => (JSON.parse(line) as [Record<string, unknown>])[0])
    .filter((entry) => entry?.event === "admin_command")
    .map((entry) => entry.command);

describe("the socket file", () => {
  it("is created for its owner only and removed on close", async () => {
    admin = await startAdminSocket(grants, path);
    const stat = statSync(path);
    expect(stat.isSocket()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o600);
    // The mask that restricted it is not left behind.
    writeFileSync(join(directory, "after"), "");
    expect(statSync(join(directory, "after")).mode & 0o777).toBe(
      0o666 & ~process.umask(),
    );

    await admin.close();
    admin = undefined;
    expect(existsSync(path)).toBe(false);
    await expect(sendAdminCommand(path, "status")).rejects.toThrow();
  });

  it("close does not wait for a client that stays connected", async () => {
    admin = await startAdminSocket(grants, path);
    const socket = net.createConnection(path);
    const closed = new Promise((resolve) => socket.on("close", resolve));
    await new Promise((resolve) =>
      socket.once("data", resolve).write("status\n"),
    );
    await admin.close();
    admin = undefined;
    await closed;
    expect(existsSync(path)).toBe(false);
  });

  it("refuses to start when the path exists and is not a socket", async () => {
    writeFileSync(path, "not a socket");
    const error = await startAdminSocket(grants, path).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe(JsonRpcErrorCode.ConfigurationError);
    expect((error as McpError).message).toContain("OAUTH_ADMIN_SOCKET");
    expect(readFileSync(path, "utf8")).toBe("not a socket");
  });

  it.each([
    [
      "longer than a socket path may be",
      () => join(directory, "a".repeat(120)),
    ],
    ["in a directory that does not exist", () => join(directory, "none", "s")],
  ])("refuses to start with a path %s", async (_case, at) => {
    const error = await startAdminSocket(grants, at()).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe(JsonRpcErrorCode.ConfigurationError);
    expect((error as McpError).message).toMatch(
      /^OAUTH_ADMIN_SOCKET: no socket can be created at /,
    );
  });

  it("replaces a socket an earlier run left behind", async () => {
    // A process that is killed while it listens leaves its socket file.
    spawnSync(process.execPath, [
      "-e",
      "require('node:net').createServer().listen(process.argv[1], () => process.kill(process.pid, 'SIGKILL'))",
      path,
    ]);
    expect(statSync(path).isSocket()).toBe(true);

    admin = await startAdminSocket(grants, path);
    expect(await sendAdminCommand(path, "status")).toBe(
      "grants=0 connections=0/50 blocked=0",
    );
  });

  it("refuses to start on a socket another server listens on, and leaves that server its socket", async () => {
    admin = await startAdminSocket(grants, path);
    const inode = statSync(path).ino;

    const error = await startAdminSocket(grants, path).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe(JsonRpcErrorCode.ConfigurationError);
    expect((error as McpError).message).toBe(
      `OAUTH_ADMIN_SOCKET: another server is listening on ${path}. Stop that server, or give this one a path of its own.`,
    );
    // The first server still has the path, and answers on it.
    expect(statSync(path).ino).toBe(inode);
    expect(await sendAdminCommand(path, "status")).toBe(
      "grants=0 connections=0/50 blocked=0",
    );
  });

  it("sendAdminCommand gives up on a socket that accepts and never answers", async () => {
    // Reads the command, so it sees the client leave, and says nothing.
    const silent = net.createServer((socket) =>
      socket.on("error", () => {}).resume(),
    );
    await new Promise<void>((resolve) => silent.listen(path, resolve));
    try {
      await expect(sendAdminCommand(path, "status")).rejects.toThrow(
        "The admin socket did not answer in 5 seconds.",
      );
    } finally {
      await new Promise((resolve) => silent.close(resolve));
    }
  }, 10_000);
});

describe("commands", () => {
  beforeEach(async () => {
    admin = await startAdminSocket(grants, path);
  });

  it("status reports counts only", async () => {
    await signOn("testuser");
    await signOn("otherusr", WRONG_PASSWORD);
    await signOn("otherusr", WRONG_PASSWORD);
    const reply = await sendAdminCommand(path, "status");
    expect(reply).toBe("grants=1 connections=1/50 blocked=1");
    expect(reply).not.toMatch(/TESTUSER|OTHERUSR/i);
  });

  it("revoke ends every sign-on of a profile, or one by its id", async () => {
    await signOn("testuser");
    await signOn("testuser");
    const other = await signOn("otherusr");
    if (!other.ok) throw new Error(other.reason);

    expect(await sendAdminCommand(path, "revoke testuser")).toBe("revoked 2");
    expect(await sendAdminCommand(path, "revoke testuser")).toBe("revoked 0");
    expect(await sendAdminCommand(path, `revoke ${other.grantId}`)).toBe(
      "revoked 1",
    );
    expect(grants.status().grants).toBe(0);
    await until(() => fake.openSockets === 0);
  });

  it("unblock clears one profile's block", async () => {
    await signOn("testuser", WRONG_PASSWORD);
    await signOn("testuser", WRONG_PASSWORD);
    expect(await signOn("testuser")).toEqual({ ok: false, reason: "blocked" });

    expect(await sendAdminCommand(path, "unblock testuser")).toBe("unblocked");
    expect(await sendAdminCommand(path, "unblock testuser")).toBe(
      "not blocked",
    );
    expect((await signOn("testuser")).ok).toBe(true);
  });

  it.each(["", "help", "status now", "unblock", "revoke a b", "STATUS"])(
    "answers %j with the usage and does nothing",
    async (line) => {
      await signOn("testuser");
      expect(await sendAdminCommand(path, line)).toMatch(
        /^error: expected unblock <profile>, revoke <profile\|grantId> or status$/,
      );
      expect(grants.status().grants).toBe(1);
    },
  );

  it("logs the command, never its argument or a line it did not understand", async () => {
    await sendAdminCommand(path, "status");
    await sendAdminCommand(path, "unblock secretish1");
    await sendAdminCommand(path, "revoke secretish2");
    await sendAdminCommand(path, "secretish3 pasted by mistake");
    expect(commandsLogged()).toEqual(["status", "unblock", "revoke"]);
    expect(lines.filter((line) => /secretish/i.test(line))).toEqual([]);
  });

  it("answers the commands of one connection in order, one line each", async () => {
    await signOn("testuser");
    const socket = net.createConnection(path);
    let received = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => (received += chunk));
    socket.write("status\nrevoke testuser\nstat");
    socket.write("us\n");
    await until(() => received.split("\n").length === 4);
    socket.destroy();
    expect(received).toBe(
      "grants=1 connections=1/50 blocked=0\nrevoked 1\ngrants=0 connections=0/50 blocked=0\n",
    );
  });

  it("cuts off a client that sends a line that is too long", async () => {
    const socket = net.createConnection(path);
    const closed = new Promise((resolve) => socket.on("close", resolve));
    socket.on("error", () => {});
    socket.write("x".repeat(300));
    await closed;
    expect(await sendAdminCommand(path, "status")).toBe(
      "grants=0 connections=0/50 blocked=0",
    );
  });

  it("answers with an error when the command fails", async () => {
    await admin!.close();
    admin = await startAdminSocket(
      {
        status: () => {
          throw new Error("boom");
        },
        unblock: () => false,
        revokeByAdmin: async () => 0,
      },
      path,
    );
    expect(await sendAdminCommand(path, "status")).toBe(
      "error: the command failed",
    );
  });
});

/**
 * @fileoverview Unit tests for config.db2iSsh (DB2i_TRANSPORT=ssh settings).
 */

import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { config } from "../../src/config/index.js";

describe("config.db2iSsh", () => {
  const originalEnv = { ...process.env };
  let dir: string;
  let keyPath: string;

  beforeEach(() => {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith("DB2i_")) delete process.env[k];
    }
    dir = mkdtempSync(path.join(tmpdir(), "ssh-key-"));
    keyPath = path.join(dir, "id_test");
    writeFileSync(keyPath, "fake-private-key");
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns undefined without host, user or any credential", () => {
    expect(config.db2iSsh).toBeUndefined();
    process.env.DB2i_HOST = "h";
    process.env.DB2i_USER = "u";
    expect(config.db2iSsh).toBeUndefined();
    delete process.env.DB2i_USER;
    process.env.DB2i_PASS = "p";
    expect(config.db2iSsh).toBeUndefined();
  });

  it("reads the private key and applies defaults", () => {
    process.env.DB2i_HOST = "h";
    process.env.DB2i_USER = "u";
    process.env.DB2i_SSH_PRIVATE_KEY_PATH = keyPath;

    const ssh = config.db2iSsh;
    expect(ssh).toMatchObject({
      host: "h",
      username: "u",
      port: 22,
      technique: "tcp",
    });
    expect(ssh?.privateKey?.toString()).toBe("fake-private-key");
    expect(ssh?.password).toBeUndefined();
  });

  it("expands a leading ~ in the private key path", () => {
    // .env files and MCP client JSON configs do not expand ~ as a shell does.
    // The file does not exist; the error shows which path was opened.
    const name = `db2i-ssh-test-${process.pid}-missing`;
    process.env.DB2i_HOST = "h";
    process.env.DB2i_USER = "u";
    process.env.DB2i_SSH_PRIVATE_KEY_PATH = `~/${name}`;

    expect(() => config.db2iSsh).toThrow(path.join(homedir(), name));
  });

  it("prefers the key over DB2i_PASS when both are set", () => {
    process.env.DB2i_HOST = "h";
    process.env.DB2i_USER = "u";
    process.env.DB2i_PASS = "secret";
    process.env.DB2i_SSH_PRIVATE_KEY_PATH = keyPath;

    const ssh = config.db2iSsh;
    expect(ssh?.privateKey).toBeDefined();
    expect(ssh?.password).toBeUndefined();
  });

  it("falls back to password auth without a key", () => {
    process.env.DB2i_HOST = "h";
    process.env.DB2i_USER = "u";
    process.env.DB2i_PASS = "secret";

    const ssh = config.db2iSsh;
    expect(ssh?.password).toBe("secret");
    expect(ssh?.privateKey).toBeUndefined();
  });

  it("passes through passphrase, port, technique and host key pin", () => {
    process.env.DB2i_HOST = "h";
    process.env.DB2i_USER = "u";
    process.env.DB2i_SSH_PRIVATE_KEY_PATH = keyPath;
    process.env.DB2i_SSH_PASSPHRASE = "pp";
    process.env.DB2i_SSH_PORT = "2222";
    process.env.DB2i_SSH_TECHNIQUE = "cli";
    process.env.DB2i_SSH_HOST_KEY_SHA256 = " SHA256:abc ";

    expect(config.db2iSsh).toMatchObject({
      passphrase: "pp",
      port: 2222,
      technique: "cli",
      hostKeySha256: "SHA256:abc",
    });
  });

  it("throws on an invalid port, technique or unreadable key file", () => {
    process.env.DB2i_HOST = "h";
    process.env.DB2i_USER = "u";
    process.env.DB2i_SSH_PRIVATE_KEY_PATH = keyPath;

    process.env.DB2i_SSH_PORT = "abc";
    expect(() => config.db2iSsh).toThrow();
    process.env.DB2i_SSH_PORT = "22";

    process.env.DB2i_SSH_TECHNIQUE = "bogus";
    expect(() => config.db2iSsh).toThrow();
    delete process.env.DB2i_SSH_TECHNIQUE;

    process.env.DB2i_SSH_PRIVATE_KEY_PATH = path.join(dir, "missing");
    expect(() => config.db2iSsh).toThrow();
  });
});

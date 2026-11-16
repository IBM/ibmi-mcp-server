/**
 * @fileoverview Unit tests for config.db2iSsh and config.sshFor (SSH key settings).
 */

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
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

  it("returns undefined without host, user or a key", () => {
    expect(config.db2iSsh).toBeUndefined();
    process.env.DB2i_HOST = "h";
    process.env.DB2i_USER = "u";
    expect(config.db2iSsh).toBeUndefined();
    // A password is never an SSH credential.
    process.env.DB2i_PASS = "p";
    expect(config.db2iSsh).toBeUndefined();
    delete process.env.DB2i_USER;
    process.env.DB2i_SSH_KEY = keyPath;
    expect(config.db2iSsh).toBeUndefined();
  });

  it("reads the private key and applies defaults", () => {
    process.env.DB2i_HOST = "h";
    process.env.DB2i_USER = "u";
    process.env.DB2i_SSH_KEY = keyPath;

    const ssh = config.db2iSsh;
    expect(ssh).toMatchObject({
      host: "h",
      username: "u",
      port: 22,
      technique: "tcp",
    });
    expect(ssh?.privateKey.toString()).toBe("fake-private-key");
    expect(ssh).not.toHaveProperty("password");
  });

  it("expands a leading ~ in the private key path", () => {
    // .env files and MCP client JSON configs do not expand ~ as a shell does.
    // The file does not exist; the error shows which path was opened.
    const name = `db2i-ssh-test-${process.pid}-missing`;
    process.env.DB2i_HOST = "h";
    process.env.DB2i_USER = "u";
    process.env.DB2i_SSH_KEY = `~/${name}`;

    expect(() => config.db2iSsh).toThrow(path.join(homedir(), name));
  });

  it("uses the key and no password when DB2i_PASS is also set", () => {
    process.env.DB2i_HOST = "h";
    process.env.DB2i_USER = "u";
    process.env.DB2i_PASS = "secret";
    process.env.DB2i_SSH_KEY = keyPath;

    const ssh = config.db2iSsh;
    expect(ssh?.privateKey).toBeDefined();
    expect(ssh).not.toHaveProperty("password");
  });

  it("passes through passphrase, port, technique and host key pin", () => {
    process.env.DB2i_HOST = "h";
    process.env.DB2i_USER = "u";
    process.env.DB2i_SSH_KEY = keyPath;
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

  it("treats a blank DB2i_SSH_PORT as the default", () => {
    process.env.DB2i_HOST = "h";
    process.env.DB2i_USER = "u";
    process.env.DB2i_SSH_KEY = keyPath;
    process.env.DB2i_SSH_PORT = "";

    expect(config.db2iSsh?.port).toBe(22);
  });

  it("keeps other settings when DB2i_SSH_PORT is blank", async () => {
    // A failed environment parse falls back to defaults for every setting
    process.env.MCP_HTTP_PORT = "4321";
    process.env.DB2i_SSH_PORT = "";

    vi.resetModules();
    const fresh = (await import("../../src/config/index.js")).config;
    expect(fresh.mcpHttpPort).toBe(4321);
  });

  it("throws on an invalid port, technique or unreadable key file", () => {
    process.env.DB2i_HOST = "h";
    process.env.DB2i_USER = "u";
    process.env.DB2i_SSH_KEY = keyPath;

    process.env.DB2i_SSH_PORT = "abc";
    expect(() => config.db2iSsh).toThrow();
    process.env.DB2i_SSH_PORT = "22";

    process.env.DB2i_SSH_TECHNIQUE = "bogus";
    expect(() => config.db2iSsh).toThrow();
    delete process.env.DB2i_SSH_TECHNIQUE;

    process.env.DB2i_SSH_KEY = path.join(dir, "missing");
    expect(() => config.db2iSsh).toThrow();
  });

  describe("sshFor (one YAML source)", () => {
    it("returns undefined when neither the source nor the environment has a key", () => {
      expect(config.sshFor({ host: "h", user: "u" })).toBeUndefined();
    });

    it("uses the source's own host, user and key", () => {
      const ssh = config.sshFor({ host: "dev", user: "DEVUSER", keyPath });
      expect(ssh).toMatchObject({ host: "dev", username: "DEVUSER", port: 22 });
      expect(ssh?.privateKey.toString()).toBe("fake-private-key");
    });

    it("falls back to DB2i_SSH_KEY and keeps the source's host and user", () => {
      process.env.DB2i_HOST = "env-host";
      process.env.DB2i_USER = "ENVUSER";
      process.env.DB2i_SSH_KEY = keyPath;

      expect(config.sshFor({ host: "prod", user: "PRODUSER" })).toMatchObject({
        host: "prod",
        username: "PRODUSER",
      });
    });

    it("prefers the source's key over DB2i_SSH_KEY", () => {
      const otherKey = path.join(dir, "id_other");
      writeFileSync(otherKey, "other-private-key");
      process.env.DB2i_SSH_KEY = keyPath;

      const ssh = config.sshFor({ host: "h", user: "u", keyPath: otherKey });
      expect(ssh?.privateKey.toString()).toBe("other-private-key");
    });

    it("prefers the source's host key fingerprint over the environment", () => {
      process.env.DB2i_SSH_HOST_KEY_SHA256 = "SHA256:env";
      expect(
        config.sshFor({ host: "h", user: "u", keyPath })?.hostKeySha256,
      ).toBe("SHA256:env");
      expect(
        config.sshFor({
          host: "h",
          user: "u",
          keyPath,
          hostKeySha256: "SHA256:source",
        })?.hostKeySha256,
      ).toBe("SHA256:source");
    });

    it("throws when the source's key file cannot be read", () => {
      expect(() =>
        config.sshFor({
          host: "h",
          user: "u",
          keyPath: path.join(dir, "missing"),
        }),
      ).toThrow();
    });
  });
});

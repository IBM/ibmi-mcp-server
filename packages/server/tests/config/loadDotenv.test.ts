/**
 * @fileoverview Tests for opt-in dotenv loading via MCP_SERVER_CONFIG.
 * @module tests/config/loadDotenv.test
 */
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadDotenvIfConfigured } from "../../src/config/loadDotenv.js";

const TEST_KEY = "DOTENV_OPTIN_TEST_KEY";

describe("loadDotenvIfConfigured", () => {
  const originalCwd = process.cwd();
  const originalConfig = process.env.MCP_SERVER_CONFIG;
  const originalTestKey = process.env[TEST_KEY];
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "dotenv-optin-"));
    delete process.env.MCP_SERVER_CONFIG;
    delete process.env[TEST_KEY];
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalConfig === undefined) {
      delete process.env.MCP_SERVER_CONFIG;
    } else {
      process.env.MCP_SERVER_CONFIG = originalConfig;
    }
    if (originalTestKey === undefined) {
      delete process.env[TEST_KEY];
    } else {
      process.env[TEST_KEY] = originalTestKey;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("does not load a cwd .env when MCP_SERVER_CONFIG is unset", () => {
    writeFileSync(path.join(tempDir, ".env"), `${TEST_KEY}=should-not-load\n`);
    process.chdir(tempDir);

    const result = loadDotenvIfConfigured();

    expect(result.loaded).toBe(false);
    expect(result.path).toBeUndefined();
    expect(process.env[TEST_KEY]).toBeUndefined();
  });

  it("loads the file pointed to by MCP_SERVER_CONFIG", () => {
    const configFile = path.join(tempDir, "server.env");
    writeFileSync(configFile, `${TEST_KEY}=loaded-from-config\n`);
    process.env.MCP_SERVER_CONFIG = configFile;

    const result = loadDotenvIfConfigured();

    expect(result.loaded).toBe(true);
    expect(result.path).toBe(path.resolve(configFile));
    expect(process.env[TEST_KEY]).toBe("loaded-from-config");
  });

  it("throws when MCP_SERVER_CONFIG points at a missing file", () => {
    const missing = path.join(tempDir, "does-not-exist.env");
    process.env.MCP_SERVER_CONFIG = missing;

    expect(() => loadDotenvIfConfigured()).toThrow(
      /MCP_SERVER_CONFIG is set to .* but the file does not exist/,
    );
    expect(process.env[TEST_KEY]).toBeUndefined();
  });
});

/**
 * @fileoverview Unit tests for environment validation diagnostics in config.
 */

import { afterEach, describe, it, expect, vi } from "vitest";
import { chmodSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("config environment validation", () => {
  const originalEnv = { ...process.env };
  const originalIsTTY = Object.getOwnPropertyDescriptor(
    process.stdout,
    "isTTY",
  );

  afterEach(() => {
    process.env = { ...originalEnv };
    if (originalIsTTY) {
      Object.defineProperty(process.stdout, "isTTY", originalIsTTY);
    } else {
      delete (process.stdout as { isTTY?: boolean }).isTTY;
    }
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("reports invalid environment variables on stderr even without a TTY", async () => {
    vi.resetModules();
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      configurable: true,
    });
    process.env.MCP_HTTP_PORT = "not-a-port";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { environmentIsValid } = await import("../../src/config/index.js");

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Invalid environment variables"),
      expect.objectContaining({ MCP_HTTP_PORT: expect.any(Array) }),
    );
    expect(environmentIsValid).toBe(false);
  });

  it("keeps the rest of the environment when MCP_AUTH_MODE is the retired jwt", async () => {
    vi.resetModules();
    process.env.MCP_AUTH_MODE = "jwt";
    process.env.MCP_HTTP_PORT = "4567";

    const { config, environmentIsValid } =
      await import("../../src/config/index.js");

    expect(environmentIsValid).toBe(true);
    expect(config.mcpHttpPort).toBe(4567);
    expect(config.mcpAuthMode).toBe("jwt");
  });

  // root can write anywhere, so the directory would not be read-only.
  it.skipIf(process.getuid?.() === 0)(
    "does not log to a LOGS_DIR it cannot write to",
    async () => {
      vi.resetModules();
      const readOnlyDir = mkdtempSync(join(tmpdir(), "ibmi-mcp-ro-logs-"));
      chmodSync(readOnlyDir, 0o555);
      process.env.LOGS_DIR = readOnlyDir;

      const { config } = await import("../../src/config/index.js");

      expect(config.logsPath).toBeNull();
      rmSync(readOnlyDir, { recursive: true, force: true });
    },
  );

  it("warns on stderr when MCP_SERVER_CONFIG points at a missing file, even without a TTY", async () => {
    vi.resetModules();
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      configurable: true,
    });
    process.env.MCP_SERVER_CONFIG = "/nonexistent/ibmi-mcp-server.env";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await import("../../src/config/index.js");

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("MCP_SERVER_CONFIG"),
    );
  });
});

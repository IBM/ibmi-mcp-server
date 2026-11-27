/**
 * @fileoverview Tests for which `.env` file the config module loads.
 */

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("config .env lookup", () => {
  const originalEnv = { ...process.env };
  let root: string;

  /** Imports the config module as if started from `cwd`. */
  const loadConfigFrom = async (cwd: string) => {
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    vi.resetModules();
    return (await import("../../src/config/index.js")).config;
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ibmi-mcp-env-"));
    delete process.env.MCP_HTTP_PORT;
    delete process.env.MCP_SERVER_CONFIG;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("loads .env from the working directory", async () => {
    writeFileSync(join(root, ".env"), "MCP_HTTP_PORT=4571\n");

    const config = await loadConfigFrom(root);

    expect(config.mcpHttpPort).toBe(4571);
  });

  it("does not load .env from the parent of the working directory", async () => {
    writeFileSync(join(root, ".env"), "MCP_HTTP_PORT=4572\n");
    const child = join(root, "child");
    mkdirSync(child);

    const config = await loadConfigFrom(child);

    expect(config.mcpHttpPort).toBe(3010);
  });

  it("loads the MCP_SERVER_CONFIG file instead of the working directory's .env", async () => {
    writeFileSync(join(root, ".env"), "MCP_HTTP_PORT=4573\n");
    const explicit = join(root, "server.env");
    writeFileSync(explicit, "MCP_HTTP_PORT=4574\n");
    process.env.MCP_SERVER_CONFIG = explicit;

    const config = await loadConfigFrom(root);

    expect(config.mcpHttpPort).toBe(4574);
  });
});

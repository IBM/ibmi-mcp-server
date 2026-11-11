/**
 * @fileoverview Tests for the HTTP hardening settings: MCP_TRUSTED_PROXIES and
 * IBMI_AUTH_ALLOWED_HOSTS, and that the removed port-retry settings are
 * ignored.
 */

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("HTTP hardening settings", () => {
  const originalEnv = { ...process.env };
  let root: string;

  /** Imports the config module with only `env` set, and no .env file. */
  const loadConfig = async (env: Record<string, string>) => {
    for (const name of [
      "MCP_TRUSTED_PROXIES",
      "IBMI_AUTH_ALLOWED_HOSTS",
      "DB2i_HOST",
      "MCP_SERVER_CONFIG",
    ]) {
      delete process.env[name];
    }
    Object.assign(process.env, env);
    vi.spyOn(process, "cwd").mockReturnValue(root);
    vi.resetModules();
    return import("../../src/config/index.js");
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ibmi-mcp-env-"));
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("trusts no proxy unless MCP_TRUSTED_PROXIES names it", async () => {
    expect((await loadConfig({})).config.mcpTrustedProxies).toEqual([]);
    expect(
      (await loadConfig({ MCP_TRUSTED_PROXIES: " " })).config.mcpTrustedProxies,
    ).toEqual([]);
  });

  it("reads MCP_TRUSTED_PROXIES as addresses and CIDR ranges", async () => {
    const { config, environmentIsValid } = await loadConfig({
      MCP_TRUSTED_PROXIES: "10.0.0.0/8, 192.168.1.5,fd00::/8 , ::1,",
    });
    expect(environmentIsValid).toBe(true);
    expect(config.mcpTrustedProxies).toEqual([
      "10.0.0.0/8",
      "192.168.1.5/32",
      "fd00::/8",
      "::1/128",
    ]);
  });

  it.each([
    "true",
    "10.0.0.0/33",
    "fd00::/129",
    "10.0.0.0/8/8",
    "10.0.0.0/",
    "10.0.0.0/-1",
    "proxy.example.com",
    "10.0.0.0/8, nonsense",
  ])("refuses MCP_TRUSTED_PROXIES=%s", async (value) => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { config, environmentIsValid } = await loadConfig({
      MCP_TRUSTED_PROXIES: value,
    });

    expect(environmentIsValid).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Invalid environment variables"),
      expect.objectContaining({ MCP_TRUSTED_PROXIES: expect.any(Array) }),
    );
    // Nothing is trusted on the strength of a list that did not parse.
    expect(config.mcpTrustedProxies).toEqual([]);
  });

  it("no longer reads the boolean MCP_TRUST_PROXY", async () => {
    const { config, environmentIsValid } = await loadConfig({
      MCP_TRUST_PROXY: "true",
    });
    expect(environmentIsValid).toBe(true);
    expect(config).not.toHaveProperty("mcpTrustProxy");
    expect(config.mcpTrustedProxies).toEqual([]);
  });

  it("reads the sign-on hosts from IBMI_AUTH_ALLOWED_HOSTS", async () => {
    const { config } = await loadConfig({
      IBMI_AUTH_ALLOWED_HOSTS: "PROD.example.com, dev.example.com,",
      DB2i_HOST: "other.example.com",
    });
    expect(config.ibmiHttpAuth.allowedHosts).toEqual([
      "prod.example.com",
      "dev.example.com",
    ]);
  });

  it("defaults the sign-on hosts to DB2i_HOST", async () => {
    const { config } = await loadConfig({ DB2i_HOST: "MYIBMI.example.com" });
    expect(config.ibmiHttpAuth.allowedHosts).toEqual(["myibmi.example.com"]);
  });

  it("allows no sign-on host when neither is set", async () => {
    const { config } = await loadConfig({});
    expect(config.ibmiHttpAuth.allowedHosts).toEqual([]);
  });

  it("ignores the removed port-retry settings", async () => {
    const { config, environmentIsValid } = await loadConfig({
      MCP_HTTP_MAX_PORT_RETRIES: "15",
      MCP_HTTP_PORT_RETRY_DELAY_MS: "50",
    });
    expect(environmentIsValid).toBe(true);
    expect(config).not.toHaveProperty("mcpHttpMaxPortRetries");
    expect(config).not.toHaveProperty("mcpHttpPortRetryDelayMs");
  });
});

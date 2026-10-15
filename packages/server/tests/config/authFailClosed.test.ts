/**
 * @fileoverview Tests that invalid environment variables never silently
 * disable authentication.
 *
 * Config is parsed at module load, so each case resets the module registry and
 * imports it fresh under the environment it describes.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };

async function loadConfigWith(env: Record<string, string | undefined>) {
  process.env = { ...originalEnv, ...env };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
  }
  vi.resetModules();
  return import("../../src/config/index.js");
}

describe("config fails closed on invalid environment", () => {
  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  it.each(["oauth", "jwt", "ibmi"])(
    "refuses to start in %s mode when any variable is invalid",
    async (mode) => {
      await expect(
        loadConfigWith({ MCP_AUTH_MODE: mode, MCP_HTTP_PORT: "not-a-port" }),
      ).rejects.toThrow(new RegExp(`MCP_AUTH_MODE=${mode}: MCP_HTTP_PORT`));
    },
  );

  it("refuses to start when an OAuth URL is malformed", async () => {
    await expect(
      loadConfigWith({
        MCP_AUTH_MODE: "oauth",
        OAUTH_ISSUER_URL: "login.example.com/tenant/v2.0",
      }),
    ).rejects.toThrow(/OAUTH_ISSUER_URL/);
  });

  it("refuses to start when the auth mode itself is misspelled", async () => {
    await expect(loadConfigWith({ MCP_AUTH_MODE: "oath" })).rejects.toThrow(
      /MCP_AUTH_MODE=oath: MCP_AUTH_MODE/,
    );
  });

  it.each([
    ["unset", undefined],
    ["none", "none"],
  ])(
    "keeps the default fallback when the auth mode is %s",
    async (_label, mode) => {
      const { config } = await loadConfigWith({
        MCP_AUTH_MODE: mode,
        MCP_HTTP_PORT: "not-a-port",
      });

      expect(config.mcpAuthMode).toBe("none");
      expect(config.mcpHttpPort).toBe(3010);
    },
  );

  it("loads normally when every variable is valid", async () => {
    const { config } = await loadConfigWith({
      MCP_AUTH_MODE: "jwt",
      MCP_HTTP_PORT: "3020",
    });

    expect(config.mcpAuthMode).toBe("jwt");
    expect(config.mcpHttpPort).toBe(3020);
  });
});

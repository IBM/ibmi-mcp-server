/**
 * Tests for the HTTP security posture startup guard.
 *
 * The guard refuses to start when ALL FOUR of: transport=http,
 * MCP_AUTH_MODE=none, non-loopback bind, and IBM i credentials present.
 * Credentials must be detected via BOTH paths — DB2i_* env vars
 * (config.db2i is a live getter over process.env) and a configured tools
 * YAML (whose sources: carry their own credentials).
 *
 * @module tests/mcp-server/transports/http/httpSecurityPosture.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { config } from "../../../../src/config/index.js";
import { assertHttpSecurityPosture } from "../../../../src/mcp-server/transports/http/hostValidation.js";
import { JsonRpcErrorCode, McpError } from "../../../../src/types-global/errors.js";
import { requestContextService } from "../../../../src/utils/index.js";

const ENV_KEYS = ["DB2i_HOST", "DB2i_USER", "DB2i_PASS"] as const;

const savedConfig = {
  mcpTransportType: config.mcpTransportType,
  mcpAuthMode: config.mcpAuthMode,
  mcpAuthSecretKey: config.mcpAuthSecretKey,
  mcpHttpHost: config.mcpHttpHost,
  toolsYamlPath: config.toolsYamlPath,
  mcpAllowUnauthenticatedHttp: config.mcpAllowUnauthenticatedHttp,
};

let savedEnv: Record<string, string | undefined>;

/**
 * The guard writes its human-readable block straight to stderr so it stays
 * legible when pino is emitting JSON. Silence it here to keep test output
 * clean, and keep the spy so one test can assert the block is actually written.
 */
let stderrSpy: ReturnType<typeof vi.spyOn>;

const ctx = () =>
  requestContextService.createRequestContext({
    operation: "httpSecurityPostureTest",
  });

/** Arms all four conditions of the fatal quad, with credentials via env vars. */
function armQuad() {
  config.mcpTransportType = "http";
  config.mcpAuthMode = "none";
  config.mcpHttpHost = "0.0.0.0";
  process.env.DB2i_HOST = "ibmi.example.com";
  process.env.DB2i_USER = "tester";
  process.env.DB2i_PASS = "secret";
}

beforeEach(() => {
  stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  config.toolsYamlPath = undefined;
  config.mcpAllowUnauthenticatedHttp = false;
  config.mcpAuthSecretKey = undefined;
});

afterEach(() => {
  stderrSpy.mockRestore();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
  config.mcpTransportType = savedConfig.mcpTransportType;
  config.mcpAuthMode = savedConfig.mcpAuthMode;
  config.mcpAuthSecretKey = savedConfig.mcpAuthSecretKey;
  config.mcpHttpHost = savedConfig.mcpHttpHost;
  config.toolsYamlPath = savedConfig.toolsYamlPath;
  config.mcpAllowUnauthenticatedHttp = savedConfig.mcpAllowUnauthenticatedHttp;
});

describe("assertHttpSecurityPosture", () => {
  it("throws ConfigurationError on the fatal quad (env credentials)", () => {
    armQuad();
    let thrown: unknown;
    try {
      assertHttpSecurityPosture(ctx());
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(McpError);
    expect((thrown as McpError).code).toBe(JsonRpcErrorCode.ConfigurationError);
  });

  it("throws when credentials come only from a tools YAML (no DB2i_* env)", () => {
    armQuad();
    for (const key of ENV_KEYS) delete process.env[key];
    config.toolsYamlPath = "/etc/ibmi/tools.yaml";
    expect(() => assertHttpSecurityPosture(ctx())).toThrow(McpError);
  });

  it("does not throw for stdio transport", () => {
    armQuad();
    config.mcpTransportType = "stdio";
    expect(() => assertHttpSecurityPosture(ctx())).not.toThrow();
  });

  it("does not throw when JWT auth is genuinely enforced", () => {
    armQuad();
    config.mcpAuthMode = "jwt";
    config.mcpAuthSecretKey = "0123456789abcdef0123456789abcdef";
    expect(() => assertHttpSecurityPosture(ctx())).not.toThrow();
  });

  it("throws when MCP_AUTH_MODE=jwt but the secret key is unset (dev bypass)", () => {
    // JwtStrategy falls back to a dev bypass outside production when
    // MCP_AUTH_SECRET_KEY is missing: verify() returns a synthetic AuthInfo for
    // ANY bearer token. Naming an auth mode is therefore not the same as
    // enforcing authentication, and the guard must not be fooled by it.
    armQuad();
    config.mcpAuthMode = "jwt";
    config.mcpAuthSecretKey = undefined;
    expect(() => assertHttpSecurityPosture(ctx())).toThrow(McpError);
  });

  it("does not throw for auth modes without a bypass path", () => {
    armQuad();
    config.mcpAuthMode = "ibmi";
    config.mcpAuthSecretKey = undefined;
    expect(() => assertHttpSecurityPosture(ctx())).not.toThrow();
  });

  it.each(["127.0.0.1", "localhost", "::1"])(
    "does not throw on loopback bind %s (warns and proceeds)",
    (bind) => {
      armQuad();
      config.mcpHttpHost = bind;
      expect(() => assertHttpSecurityPosture(ctx())).not.toThrow();
    },
  );

  it("does not throw when no IBM i credentials are configured", () => {
    armQuad();
    for (const key of ENV_KEYS) delete process.env[key];
    config.toolsYamlPath = undefined;
    expect(() => assertHttpSecurityPosture(ctx())).not.toThrow();
  });

  it("honors the MCP_ALLOW_UNAUTHENTICATED_HTTP override", () => {
    armQuad();
    config.mcpAllowUnauthenticatedHttp = true;
    expect(() => assertHttpSecurityPosture(ctx())).not.toThrow();
  });

  it("writes the human-readable block to stderr and keeps the thrown message single-line", () => {
    armQuad();
    expect(() => assertHttpSecurityPosture(ctx())).toThrow(McpError);

    const block = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    // The block carries the labelled facts an operator needs...
    expect(block).toContain("Bind host    0.0.0.0 - not loopback");
    expect(block).toContain("Auth mode    none - authentication is disabled");
    expect(block).toContain("Credentials  DB2i_* environment variables");
    expect(block).toContain("MCP_ALLOW_UNAUTHENTICATED_HTTP=true");
    // ...and stays ASCII so it survives arbitrary log pipelines intact.
    // eslint-disable-next-line no-control-regex
    expect(block).toMatch(/^[\x00-\x7F]*$/);
  });

  it("keeps the thrown message on one line and the facts in context", () => {
    armQuad();
    let thrown: McpError | undefined;
    try {
      assertHttpSecurityPosture(ctx());
    } catch (error) {
      thrown = error as McpError;
    }
    // A multi-line message would be emitted by pino as escaped \n whenever
    // output is not a TTY, i.e. docker logs, systemd, CI.
    expect(thrown?.message).not.toContain("\n");
    expect(thrown?.details).toMatchObject({
      bindHost: "0.0.0.0",
      authMode: "none",
      credentialSources: "DB2i_* environment variables",
    });
  });

  it("does not write to stderr when the posture is acceptable", () => {
    armQuad();
    config.mcpHttpHost = "127.0.0.1";
    expect(() => assertHttpSecurityPosture(ctx())).not.toThrow();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("names the tools YAML as the credential source when that is the path", () => {
    armQuad();
    for (const key of ENV_KEYS) delete process.env[key];
    config.toolsYamlPath = "/etc/ibmi/tools.yaml";
    expect(() => assertHttpSecurityPosture(ctx())).toThrow(McpError);
    const block = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(block).toContain("Credentials  tools YAML at /etc/ibmi/tools.yaml");
  });

  it("does not throw on partial DB2i_* credentials with no tools YAML", () => {
    // config.db2i requires all three vars and returns undefined otherwise, so
    // 2-of-3 is indistinguishable from 0-of-3: there is no usable credential
    // and nothing to protect.
    armQuad();
    delete process.env.DB2i_PASS;
    config.toolsYamlPath = undefined;
    expect(() => assertHttpSecurityPosture(ctx())).not.toThrow();
  });
});

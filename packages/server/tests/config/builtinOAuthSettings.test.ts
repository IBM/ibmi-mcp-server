/**
 * @fileoverview Tests for the settings of the built-in authorization server
 * (MCP_AUTH_MODE=oauth without OAUTH_ISSUER_URL), the TLS listener files and
 * the settings that contradict each other.
 */

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("built-in authorization server settings", () => {
  const originalEnv = { ...process.env };
  let root: string;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  /** Imports the config module with only `env` set, and no .env file. */
  const loadConfig = async (env: Record<string, string>) => {
    for (const name of Object.keys(process.env)) {
      if (/^(MCP_|OAUTH_|DB2i_)/.test(name)) {
        delete process.env[name];
      }
    }
    Object.assign(process.env, env);
    vi.spyOn(process, "cwd").mockReturnValue(root);
    vi.resetModules();
    return import("../../src/config/index.js");
  };

  /** The variables the config module reported as invalid. */
  const reported = (): Record<string, string[]> =>
    (errorSpy.mock.calls.at(-1)?.[1] ?? {}) as Record<string, string[]>;

  const BUILTIN = {
    MCP_AUTH_MODE: "oauth",
    MCP_RESOURCE_URL: "https://mcp.example.com/mcp",
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ibmi-mcp-env-"));
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.resetModules();
  });

  describe("mode selection", () => {
    it("is the built-in server when MCP_AUTH_MODE=oauth and OAUTH_ISSUER_URL is unset", async () => {
      const { config, environmentIsValid } = await loadConfig(BUILTIN);
      expect(environmentIsValid).toBe(true);
      expect(config.oauth.builtin).toBe(true);
      expect(config.oauth.issuer).toBe("https://mcp.example.com");
    });

    it("treats an empty OAUTH_ISSUER_URL as unset", async () => {
      const { config } = await loadConfig({ ...BUILTIN, OAUTH_ISSUER_URL: "" });
      expect(config.oauth.builtin).toBe(true);
    });

    it("is the external resource server when OAUTH_ISSUER_URL is set", async () => {
      const { config, environmentIsValid } = await loadConfig({
        ...BUILTIN,
        OAUTH_ISSUER_URL: "https://auth.example.com",
        OAUTH_JWKS_URI: "https://auth.example.com/jwks",
        OAUTH_AUDIENCE: "ibmi-mcp",
      });
      expect(environmentIsValid).toBe(true);
      expect(config.oauth.builtin).toBe(false);
      expect(config.oauth.issuer).toBeUndefined();
      expect(config.oauthIssuerUrl).toBe("https://auth.example.com");
    });

    it.each(["none", "ibmi"])(
      "is not the built-in server with MCP_AUTH_MODE=%s",
      async (mode) => {
        const { config, environmentIsValid } = await loadConfig({
          MCP_AUTH_MODE: mode,
        });
        expect(environmentIsValid).toBe(true);
        expect(config.oauth.builtin).toBe(false);
        expect(config.oauth.issuer).toBeUndefined();
      },
    );

    it("follows the configuration when it is changed after loading", async () => {
      const { config } = await loadConfig({});
      expect(config.oauth.builtin).toBe(false);

      config.mcpAuthMode = "oauth";
      config.mcpResourceUrl = "http://127.0.0.1:3010/mcp";
      expect(config.oauth.builtin).toBe(true);
      expect(config.oauth.issuer).toBe("http://127.0.0.1:3010");

      config.oauthIssuerUrl = "https://auth.example.com";
      expect(config.oauth.builtin).toBe(false);
    });

    it.each([
      ["https://h.example.com/mcp", "https://h.example.com"],
      ["https://h.example.com/mcp/", "https://h.example.com"],
      ["https://apps.example.com/ibmi/mcp", "https://apps.example.com/ibmi"],
      ["https://h.example.com", "https://h.example.com"],
      ["https://h.example.com:8443/a/b/mcp", "https://h.example.com:8443/a/b"],
      ["http://localhost:3010/mcp", "http://localhost:3010"],
    ])("derives the issuer of %s as %s", async (resource, issuer) => {
      const { config, environmentIsValid } = await loadConfig({
        ...BUILTIN,
        MCP_RESOURCE_URL: resource,
      });
      expect(environmentIsValid).toBe(true);
      expect(config.oauth.issuer).toBe(issuer);
    });
  });

  describe("MCP_RESOURCE_URL in built-in mode", () => {
    it("is required", async () => {
      const { environmentIsValid } = await loadConfig({
        MCP_AUTH_MODE: "oauth",
      });
      expect(environmentIsValid).toBe(false);
      expect(reported().MCP_RESOURCE_URL).toEqual([
        "MCP_RESOURCE_URL is required when MCP_AUTH_MODE=oauth.",
      ]);
    });

    it.each([
      "http://mcp.example.com/mcp",
      "http://10.0.0.5:3010/mcp",
      "ftp://mcp.example.com/mcp",
    ])("refuses %s: neither https nor loopback", async (resource) => {
      const { environmentIsValid } = await loadConfig({
        ...BUILTIN,
        MCP_RESOURCE_URL: resource,
      });
      expect(environmentIsValid).toBe(false);
      expect(reported().MCP_RESOURCE_URL?.[0]).toContain(
        "must use https unless it is a loopback address",
      );
    });

    it.each(["not a url", "https://mcp.example.com/mcp#frag"])(
      "refuses %s",
      async (resource) => {
        const { environmentIsValid } = await loadConfig({
          ...BUILTIN,
          MCP_RESOURCE_URL: resource,
        });
        expect(environmentIsValid).toBe(false);
        expect(reported()).toHaveProperty("MCP_RESOURCE_URL");
      },
    );

    it.each([
      "http://localhost:3010/mcp",
      "http://127.0.0.1:3010/mcp",
      "http://[::1]:3010/mcp",
    ])("accepts plain http on loopback: %s", async (resource) => {
      const { environmentIsValid } = await loadConfig({
        ...BUILTIN,
        MCP_RESOURCE_URL: resource,
      });
      expect(environmentIsValid).toBe(true);
    });

    it("is not checked here for an external issuer", async () => {
      // transports/auth/oauth.ts validates it when the transport starts.
      const { environmentIsValid } = await loadConfig({
        MCP_AUTH_MODE: "oauth",
        OAUTH_ISSUER_URL: "https://auth.example.com",
        MCP_RESOURCE_URL: "http://mcp.example.com/mcp",
      });
      expect(environmentIsValid).toBe(true);
    });
  });

  it.each(["OAUTH_JWKS_URI", "OAUTH_AUDIENCE"])(
    "refuses %s in built-in mode",
    async (name) => {
      const { environmentIsValid } = await loadConfig({
        ...BUILTIN,
        [name]: "https://auth.example.com/jwks",
      });
      expect(environmentIsValid).toBe(false);
      expect(reported()[name]?.[0]).toContain("set OAUTH_ISSUER_URL as well");
    },
  );

  describe("TLS listener files", () => {
    it("are unset by default", async () => {
      const { config } = await loadConfig({});
      expect(config.mcpTlsCertFile).toBeUndefined();
      expect(config.mcpTlsKeyFile).toBeUndefined();
    });

    it("are read as paths in any auth mode", async () => {
      const { config, environmentIsValid } = await loadConfig({
        MCP_TLS_CERT_FILE: "/etc/ibmi-mcp/tls.crt",
        MCP_TLS_KEY_FILE: "/etc/ibmi-mcp/tls.key",
      });
      expect(environmentIsValid).toBe(true);
      expect(config.mcpTlsCertFile).toBe("/etc/ibmi-mcp/tls.crt");
      expect(config.mcpTlsKeyFile).toBe("/etc/ibmi-mcp/tls.key");
    });

    it.each([
      ["MCP_TLS_CERT_FILE", "MCP_TLS_KEY_FILE"],
      ["MCP_TLS_KEY_FILE", "MCP_TLS_CERT_FILE"],
    ])("refuses %s without %s", async (given, missing) => {
      const { environmentIsValid } = await loadConfig({
        [given]: "/etc/ibmi-mcp/tls.pem",
        [missing]: "",
      });
      expect(environmentIsValid).toBe(false);
      expect(reported()[missing]).toEqual([
        "MCP_TLS_CERT_FILE and MCP_TLS_KEY_FILE must be set together.",
      ]);
    });
  });

  describe("Mapepire target and trust", () => {
    it("exposes the host, port and certificate files", async () => {
      const { config, environmentIsValid } = await loadConfig({
        ...BUILTIN,
        DB2i_HOST: "ibmi.example.com",
        DB2i_PORT: "9000",
        DB2i_SERVER_CERT_FILE: "/etc/ibmi-mcp/mapepire.pem",
      });
      expect(environmentIsValid).toBe(true);
      expect(config.oauth.mapepire).toEqual({
        host: "ibmi.example.com",
        port: 9000,
        serverCertFile: "/etc/ibmi-mcp/mapepire.pem",
        caFile: undefined,
      });
    });

    it("defaults to port 8076 and Node's trust store", async () => {
      const { config } = await loadConfig(BUILTIN);
      expect(config.oauth.mapepire).toEqual({
        host: undefined,
        port: 8076,
        serverCertFile: undefined,
        caFile: undefined,
      });
    });

    it("refuses DB2i_SERVER_CERT_FILE together with DB2i_CA_FILE", async () => {
      const { environmentIsValid } = await loadConfig({
        ...BUILTIN,
        DB2i_SERVER_CERT_FILE: "/etc/ibmi-mcp/mapepire.pem",
        DB2i_CA_FILE: "/etc/ibmi-mcp/ca.pem",
      });
      expect(environmentIsValid).toBe(false);
      expect(reported().DB2i_CA_FILE?.[0]).toContain("not both");
    });
  });

  describe("grant and sign-on policy", () => {
    it("has the documented defaults", async () => {
      const { config } = await loadConfig(BUILTIN);
      expect(config.oauth).toMatchObject({
        signOnAllowedCidrs: [
          "127.0.0.0/8",
          "::1/128",
          "10.0.0.0/8",
          "172.16.0.0/12",
          "192.168.0.0/16",
          "fc00::/7",
        ],
        codeAddressBinding: "strict",
        grantMaxHours: 12,
        idleCloseMinutes: 10,
        maxConnections: 50,
        allowedProfiles: [],
        allowPrivilegedProfiles: false,
        signOnMaxFailures: 2,
        allowLoopbackRedirects: true,
        redirectUris: [],
        adminSocket: undefined,
      });
    });

    it("reads every setting", async () => {
      const { config, environmentIsValid } = await loadConfig({
        ...BUILTIN,
        OAUTH_SIGNON_ALLOWED_CIDRS: "10.20.0.0/16, 2001:db8::/32",
        OAUTH_CODE_ADDRESS_BINDING: "audit",
        OAUTH_GRANT_MAX_HOURS: "8",
        OAUTH_IDLE_CLOSE_MINUTES: "30",
        OAUTH_MAX_CONNECTIONS: "5",
        OAUTH_ALLOWED_PROFILES: "alice, DEV*,qsecofr, a#$_b",
        OAUTH_ALLOW_PRIVILEGED_PROFILES: "true",
        OAUTH_SIGNON_MAX_FAILURES: "1",
        OAUTH_ALLOW_LOOPBACK_REDIRECTS: "false",
        OAUTH_REDIRECT_URIS:
          "https://claude.ai/api/mcp/auth_callback, cursor://anysphere.cursor-mcp/oauth/callback\nhttps://vscode.dev/redirect",
        OAUTH_ADMIN_SOCKET: "/run/ibmi-mcp/admin.sock",
      });
      expect(environmentIsValid).toBe(true);
      expect(config.oauth).toMatchObject({
        signOnAllowedCidrs: ["10.20.0.0/16", "2001:db8::/32"],
        codeAddressBinding: "audit",
        grantMaxHours: 8,
        idleCloseMinutes: 30,
        maxConnections: 5,
        allowedProfiles: ["ALICE", "DEV*", "QSECOFR", "A#$_B"],
        allowPrivilegedProfiles: true,
        signOnMaxFailures: 1,
        allowLoopbackRedirects: false,
        redirectUris: [
          "https://claude.ai/api/mcp/auth_callback",
          "cursor://anysphere.cursor-mcp/oauth/callback",
          "https://vscode.dev/redirect",
        ],
        adminSocket: "/run/ibmi-mcp/admin.sock",
      });
    });

    it.each([
      ["OAUTH_SIGNON_ALLOWED_CIDRS", "everyone"],
      ["OAUTH_SIGNON_ALLOWED_CIDRS", "10.0.0.0/40"],
      ["OAUTH_CODE_ADDRESS_BINDING", "off"],
      ["OAUTH_GRANT_MAX_HOURS", "0"],
      ["OAUTH_GRANT_MAX_HOURS", "1.5"],
      ["OAUTH_IDLE_CLOSE_MINUTES", "0"],
      ["OAUTH_IDLE_CLOSE_MINUTES", "soon"],
      ["OAUTH_MAX_CONNECTIONS", "0"],
      ["OAUTH_SIGNON_MAX_FAILURES", "0"],
      ["OAUTH_SIGNON_MAX_FAILURES", "-1"],
      ["OAUTH_SIGNON_MAX_FAILURES", "1.5"],
      ["OAUTH_ALLOWED_PROFILES", "ALICE,TOOLONGNAME1"],
      ["OAUTH_ALLOWED_PROFILES", "AL ICE"],
      ["OAUTH_ALLOWED_PROFILES", "A*B"],
      ["OAUTH_ALLOWED_PROFILES", "*"],
      ["OAUTH_ALLOWED_PROFILES", "ALICE@EXAMPLE"],
      ["OAUTH_REDIRECT_URIS", "/callback"],
      ["OAUTH_REDIRECT_URIS", "https://vscode.dev/redirect, vscode.dev"],
      ["OAUTH_REDIRECT_URIS", "https://vscode.dev/redirect#fragment"],
    ])("refuses %s=%s", async (name, value) => {
      const { environmentIsValid } = await loadConfig({
        ...BUILTIN,
        [name]: value,
      });
      expect(environmentIsValid).toBe(false);
      expect(reported()).toHaveProperty(name);
    });
  });
});

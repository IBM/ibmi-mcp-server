/**
 * @fileoverview Tests for OAuth environment validation and scope parsing.
 */

import { describe, expect, it } from "vitest";
import {
  parseOAuthScopes,
  validateOAuthEnvironment,
} from "../../src/config/oauthConfig.js";

const validOAuthEnvironment = {
  MCP_AUTH_MODE: "oauth",
  OAUTH_ISSUER_URL: "https://auth.example.com/tenant-id/v2.0",
  OAUTH_JWKS_URI: "https://auth.example.com/tenant-id/discovery/v2.0/keys",
  OAUTH_RESOURCE_URL: "https://mcp.example.com/mcp",
  OAUTH_SCOPES_SUPPORTED: "https://mcp.example.com/mcp/ibmi.read",
};

describe("parseOAuthScopes", () => {
  it("trims, removes empty entries, and deduplicates scopes", () => {
    expect(parseOAuthScopes("ibmi.read, profile,ibmi.read, ")).toEqual([
      "ibmi.read",
      "profile",
    ]);
  });
});

describe("validateOAuthEnvironment", () => {
  it("accepts a complete OAuth configuration", () => {
    expect(() => validateOAuthEnvironment(validOAuthEnvironment)).not.toThrow();
  });

  it("ignores OAuth fields in other authentication modes", () => {
    expect(() =>
      validateOAuthEnvironment({
        ...validOAuthEnvironment,
        MCP_AUTH_MODE: "none",
        OAUTH_ISSUER_URL: "http://auth.example.com",
      }),
    ).not.toThrow();
  });

  it("rejects fragments on the issuer URL", () => {
    expect(() =>
      validateOAuthEnvironment({
        ...validOAuthEnvironment,
        OAUTH_ISSUER_URL: "https://auth.example.com/tenant-id/v2.0#fragment",
      }),
    ).toThrow(/OAUTH_ISSUER_URL must not contain a fragment/);
  });

  it("rejects an insecure public JWKS URL", () => {
    expect(() =>
      validateOAuthEnvironment({
        ...validOAuthEnvironment,
        OAUTH_JWKS_URI: "http://auth.example.com/keys",
      }),
    ).toThrow(/OAUTH_JWKS_URI must use HTTPS/);
  });

  it("rejects fragments on the protected resource URL", () => {
    expect(() =>
      validateOAuthEnvironment({
        ...validOAuthEnvironment,
        OAUTH_RESOURCE_URL: "https://mcp.example.com/mcp#fragment",
      }),
    ).toThrow(/OAUTH_RESOURCE_URL must not contain a fragment/);
  });

  it("rejects an insecure public resource URL", () => {
    expect(() =>
      validateOAuthEnvironment({
        ...validOAuthEnvironment,
        OAUTH_RESOURCE_URL: "http://mcp.example.com/mcp",
      }),
    ).toThrow(/OAUTH_RESOURCE_URL must use HTTPS/);
  });

  it("rejects scope values that cannot be safely advertised", () => {
    expect(() =>
      validateOAuthEnvironment({
        ...validOAuthEnvironment,
        OAUTH_SCOPES_SUPPORTED: 'ibmi.read"bad',
      }),
    ).toThrow(/invalid OAuth scope token/);
  });

  it("allows HTTP for loopback development URLs", () => {
    expect(() =>
      validateOAuthEnvironment({
        ...validOAuthEnvironment,
        OAUTH_ISSUER_URL: "http://localhost:8080/realms/dev",
        OAUTH_RESOURCE_URL: "http://localhost:3010/mcp",
      }),
    ).not.toThrow();
  });
});

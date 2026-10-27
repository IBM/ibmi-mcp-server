/**
 * @fileoverview Tests for OAuth 2.0 Protected Resource Metadata (RFC 9728) helpers.
 * @module tests/mcp-server/transports/auth/lib/protectedResourceMetadata.test
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    mcpAuthMode: "oauth" as string,
    oauthResourceUrl: undefined as string | undefined,
    oauthIssuerUrl: undefined as string | undefined,
    oauthScopesSupported: undefined as string[] | undefined,
  },
}));

vi.mock("../../../../../src/config/index.js", () => ({ config: mockConfig }));

import {
  buildBearerChallenge,
  resolveProtectedResourceMetadata,
} from "../../../../../src/mcp-server/transports/auth/lib/protectedResourceMetadata.js";

const ISSUER = "https://login.microsoftonline.com/tenant-id/v2.0";

describe("resolveProtectedResourceMetadata", () => {
  beforeEach(() => {
    mockConfig.mcpAuthMode = "oauth";
    mockConfig.oauthResourceUrl = "https://mcp.example.com/mcp";
    mockConfig.oauthIssuerUrl = ISSUER;
    mockConfig.oauthScopesSupported = undefined;
  });

  it("builds a metadata document advertising the configured issuer", () => {
    const metadata = resolveProtectedResourceMetadata();

    expect(metadata?.document).toEqual({
      resource: "https://mcp.example.com/mcp",
      authorization_servers: [ISSUER],
      bearer_methods_supported: ["header"],
    });
  });

  it("suffixes the canonical path with the resource path component", () => {
    const metadata = resolveProtectedResourceMetadata();

    expect(metadata?.canonicalPath).toBe(
      "/.well-known/oauth-protected-resource/mcp",
    );
    expect(metadata?.fallbackPath).toBe(
      "/.well-known/oauth-protected-resource",
    );
    expect(metadata?.canonicalUrl).toBe(
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
    );
  });

  it("collapses canonical and fallback paths for a root resource URL", () => {
    mockConfig.oauthResourceUrl = "https://mcp.example.com";

    const metadata = resolveProtectedResourceMetadata();

    expect(metadata?.canonicalPath).toBe(metadata?.fallbackPath);
    expect(metadata?.canonicalPath).toBe(
      "/.well-known/oauth-protected-resource",
    );
  });

  it("does not emit a doubled separator for a trailing-slash resource URL", () => {
    mockConfig.oauthResourceUrl = "https://mcp.example.com/mcp/";

    const metadata = resolveProtectedResourceMetadata();

    expect(metadata?.canonicalPath).toBe(
      "/.well-known/oauth-protected-resource/mcp",
    );
  });

  it("omits scopes_supported when no scopes are configured", () => {
    mockConfig.oauthScopesSupported = [];

    const metadata = resolveProtectedResourceMetadata();

    expect(metadata?.document).not.toHaveProperty("scopes_supported");
  });

  it("includes scopes_supported when scopes are configured", () => {
    mockConfig.oauthScopesSupported = ["ibmi.read", "ibmi.write"];

    const metadata = resolveProtectedResourceMetadata();

    expect(metadata?.document.scopes_supported).toEqual([
      "ibmi.read",
      "ibmi.write",
    ]);
  });

  it("returns undefined when the server is not in oauth mode", () => {
    mockConfig.mcpAuthMode = "ibmi";

    expect(resolveProtectedResourceMetadata()).toBeUndefined();
  });

  it("returns undefined when the resource URL is unset", () => {
    mockConfig.oauthResourceUrl = undefined;

    expect(resolveProtectedResourceMetadata()).toBeUndefined();
  });

  it("returns undefined when the issuer URL is unset", () => {
    mockConfig.oauthIssuerUrl = undefined;

    expect(resolveProtectedResourceMetadata()).toBeUndefined();
  });
});

describe("buildBearerChallenge", () => {
  beforeEach(() => {
    mockConfig.mcpAuthMode = "oauth";
    mockConfig.oauthResourceUrl = "https://mcp.example.com/mcp";
    mockConfig.oauthIssuerUrl = ISSUER;
    mockConfig.oauthScopesSupported = undefined;
  });

  it("points at the canonical metadata URL", () => {
    expect(buildBearerChallenge()).toBe(
      'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it("advertises configured scopes in the challenge", () => {
    mockConfig.oauthScopesSupported = ["https://mcp.example.com/mcp/ibmi.read"];

    expect(buildBearerChallenge()).toBe(
      'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp", scope="https://mcp.example.com/mcp/ibmi.read"',
    );
  });

  it("returns undefined when discovery is not configured", () => {
    mockConfig.oauthResourceUrl = undefined;

    expect(buildBearerChallenge()).toBeUndefined();
  });
});

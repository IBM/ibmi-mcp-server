/**
 * @fileoverview Tests for OauthStrategy claim handling across identity providers.
 * Providers disagree on the shape of the scope claim and the name of the client
 * identifier claim, so these cases pin the accepted variants.
 * @module tests/mcp-server/transports/auth/strategies/oauthStrategy.test
 */

import type { JWTPayload } from "jose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockJwtVerify } = vi.hoisted(() => ({ mockJwtVerify: vi.fn() }));

// Override only the OAuth fields; the rest of the real config must survive
// because transitive imports (rate limiter, logger) read it at module load.
vi.mock("../../../../../src/config/index.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../../src/config/index.js")>();
  return {
    ...actual,
    config: {
      ...actual.config,
      mcpAuthMode: "oauth",
      oauthIssuerUrl: "https://login.microsoftonline.com/tenant-id/v2.0",
      oauthJwksUri: undefined,
      oauthAudience: "11111111-2222-3333-4444-555555555555",
    },
  };
});
vi.mock("jose", () => ({
  createRemoteJWKSet: vi.fn(() => vi.fn()),
  jwtVerify: mockJwtVerify,
}));

import {
  JsonRpcErrorCode,
  McpError,
} from "../../../../../src/types-global/errors.js";
import { OauthStrategy } from "../../../../../src/mcp-server/transports/auth/strategies/oauthStrategy.js";

/** Claims common to every valid token, so each test states only what it varies. */
const baseClaims: JWTPayload = {
  sub: "user-object-id",
  iss: "https://login.microsoftonline.com/tenant-id/v2.0",
  aud: "11111111-2222-3333-4444-555555555555",
};

function verifyWith(claims: JWTPayload) {
  mockJwtVerify.mockResolvedValue({ payload: { ...baseClaims, ...claims } });
  return new OauthStrategy().verify("dummy-token");
}

describe("OauthStrategy scope claim parsing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("accepts a space-delimited 'scp' string as Entra ID emits it", async () => {
    const authInfo = await verifyWith({
      scp: "ibmi.read ibmi.write",
      azp: "entra-client-id",
    });

    expect(authInfo.scopes).toEqual(["ibmi.read", "ibmi.write"]);
  });

  it("accepts an array 'scp' claim", async () => {
    const authInfo = await verifyWith({
      scp: ["ibmi.read"],
      client_id: "some-client",
    });

    expect(authInfo.scopes).toEqual(["ibmi.read"]);
  });

  it("accepts a space-delimited 'scope' claim", async () => {
    const authInfo = await verifyWith({
      scope: "ibmi.read ibmi.write",
      client_id: "some-client",
    });

    expect(authInfo.scopes).toEqual(["ibmi.read", "ibmi.write"]);
  });

  it("rejects a token carrying no scopes", async () => {
    await expect(
      verifyWith({ client_id: "some-client" }),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.Unauthorized,
    });
  });
});

describe("OauthStrategy client identifier claim parsing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prefers the standard 'client_id' claim", async () => {
    const authInfo = await verifyWith({
      scp: "ibmi.read",
      client_id: "standard-id",
      azp: "entra-v2-id",
    });

    expect(authInfo.clientId).toBe("standard-id");
  });

  it("falls back to 'azp' for Entra ID v2 tokens", async () => {
    const authInfo = await verifyWith({
      scp: "ibmi.read",
      azp: "entra-v2-id",
    });

    expect(authInfo.clientId).toBe("entra-v2-id");
  });

  it("falls back to 'appid' for Entra ID v1 tokens", async () => {
    const authInfo = await verifyWith({
      scp: "ibmi.read",
      appid: "entra-v1-id",
    });

    expect(authInfo.clientId).toBe("entra-v1-id");
  });

  it("rejects a token carrying no client identifier", async () => {
    await expect(verifyWith({ scp: "ibmi.read" })).rejects.toThrow(McpError);
  });

  it("exposes the subject claim for per-user attribution", async () => {
    const authInfo = await verifyWith({
      scp: "ibmi.read",
      azp: "entra-v2-id",
    });

    expect(authInfo.subject).toBe("user-object-id");
  });
});

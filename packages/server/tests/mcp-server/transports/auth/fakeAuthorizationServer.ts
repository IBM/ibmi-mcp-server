/**
 * A stand-in authorization server for the OAuth tests: a freshly generated
 * signing key, and a global `fetch` that serves the issuer's metadata and
 * JWKS. Nothing leaves the process.
 *
 * @module tests/mcp-server/transports/auth/fakeAuthorizationServer
 */

import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { vi } from "vitest";

export const ISSUER = "https://auth.example.com";
export const RESOURCE = "https://mcp.example.com/mcp";

type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

export interface FakeAuthorizationServer {
  /** Every URL fetched from the fake server, in order. */
  requests: string[];
  /**
   * Signs an access token. `claims` are merged over a valid set (issuer,
   * audience, client_id, sub, scope, 5 minute expiry); a claim set to
   * `undefined` is left out.
   */
  token(claims?: Record<string, unknown>, key?: SigningKey): Promise<string>;
}

/**
 * Replaces global `fetch` with the fake server. Call `vi.unstubAllGlobals()`
 * when done.
 *
 * @param documents - Extra or replacement responses by URL; `null` removes a
 *   default one (the RFC 8414 metadata and the JWKS).
 */
export async function startFakeAuthorizationServer(
  documents: Record<string, unknown> = {},
): Promise<FakeAuthorizationServer> {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwks = {
    keys: [{ ...(await exportJWK(publicKey)), kid: "test-key", alg: "RS256" }],
  };
  const served: Record<string, unknown> = {
    [`${ISSUER}/.well-known/oauth-authorization-server`]: {
      issuer: ISSUER,
      jwks_uri: `${ISSUER}/jwks`,
    },
    [`${ISSUER}/jwks`]: jwks,
    ...documents,
  };
  const requests: string[] = [];

  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    requests.push(url);
    const document = served[url];
    return document
      ? Response.json(document)
      : new Response("Not found", { status: 404 });
  });

  return {
    requests,
    token(claims = {}, key = privateKey) {
      const now = Math.floor(Date.now() / 1000);
      const payload: Record<string, unknown> = {
        iss: ISSUER,
        aud: RESOURCE,
        client_id: "test-client",
        sub: "user-1",
        scope: "mcp:tools",
        iat: now,
        exp: now + 300,
        ...claims,
      };
      for (const claim of Object.keys(payload)) {
        if (payload[claim] === undefined) {
          delete payload[claim];
        }
      }
      return new SignJWT(payload)
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .sign(key);
    },
  };
}

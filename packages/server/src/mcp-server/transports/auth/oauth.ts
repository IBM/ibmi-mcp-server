/**
 * @fileoverview OAuth 2.1 resource-server authentication for the HTTP
 * transport, as defined by the MCP authorization specification (2026-07-28),
 * against an external authorization server (`OAUTH_ISSUER_URL`). Without
 * that setting the server is its own authorization server: builtinOAuth.ts.
 *
 * Here the server only verifies access tokens; it never issues them. Tokens
 * are JWTs verified locally against the issuer's JWKS. The SDK's
 * `requireBearerAuth` turns the result into the RFC 6750 answers (401 / 403
 * with a `WWW-Authenticate` challenge).
 *
 * A token identifies the caller only. It carries no IBM i credentials, is
 * never forwarded upstream, and SQL keeps running on the service-account
 * pools.
 * @module src/mcp-server/transports/auth/oauth
 */

import { createHash } from "node:crypto";
import {
  getOAuthProtectedResourceMetadataUrl,
  OAuthError,
  OAuthErrorCode,
  requireBearerAuth,
  type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";
import { createRemoteJWKSet, errors, jwtVerify } from "jose";
import { config } from "@/config/index.js";
import { JsonRpcErrorCode, McpError } from "@/types-global/errors.js";
import { logger, type RequestContext } from "@/utils/index.js";
import type { HttpAuth } from "./lib/authTypes.js";

const PROTECTED_RESOURCE_METADATA_PATH =
  "/.well-known/oauth-protected-resource";
const LOOPBACK_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"];
/**
 * Signature algorithms accepted on access tokens: asymmetric only. Defence in
 * depth: jose's remote key set already refuses symmetric and unsigned tokens.
 */
const TOKEN_ALGORITHMS = [
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
  "EdDSA",
  "Ed25519",
];
const METADATA_TIMEOUT_MS = 5000;

export function configurationError(message: string): McpError {
  return new McpError(JsonRpcErrorCode.ConfigurationError, message);
}

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/$/, "");
}

function requireSetting(name: string, value: string | undefined): string {
  if (!value) {
    throw configurationError(`${name} is required when MCP_AUTH_MODE=oauth.`);
  }
  return value;
}

/**
 * Parses a URL setting, or fails startup naming it.
 *
 * @param keySource - The URL locates the keys tokens are trusted by, so it
 *   must be HTTPS unless it points at this host.
 */
function parseUrl(name: string, value: string, keySource = false): URL {
  if (!URL.canParse(value)) {
    throw configurationError(`${name} is not a valid URL: "${value}".`);
  }
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw configurationError(`${name} must be an http(s) URL: "${value}".`);
  }
  if (url.hash) {
    throw configurationError(`${name} must not have a fragment: "${value}".`);
  }
  if (
    keySource &&
    url.protocol !== "https:" &&
    !LOOPBACK_HOSTNAMES.includes(url.hostname)
  ) {
    throw configurationError(
      `${name} must use https unless it is a loopback address: "${value}".`,
    );
  }
  return url;
}

/**
 * The well-known metadata URLs of an issuer, in the order the MCP
 * specification gives: RFC 8414, then OpenID Connect Discovery.
 */
function issuerMetadataUrls(issuer: URL): string[] {
  const path = withoutTrailingSlash(issuer.pathname);
  return path
    ? [
        `${issuer.origin}/.well-known/oauth-authorization-server${path}`,
        `${issuer.origin}/.well-known/openid-configuration${path}`,
        `${issuer.origin}${path}/.well-known/openid-configuration`,
      ]
    : [
        `${issuer.origin}/.well-known/oauth-authorization-server`,
        `${issuer.origin}/.well-known/openid-configuration`,
      ];
}

/**
 * Finds the issuer's `jwks_uri` in its metadata document.
 *
 * @throws If no document is found, or the document names another issuer.
 */
async function discoverJwksUri(issuer: string): Promise<string> {
  const tried: string[] = [];
  for (const url of issuerMetadataUrls(new URL(issuer))) {
    let metadata: { issuer?: unknown; jwks_uri?: unknown };
    try {
      const response = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
      });
      if (!response.ok) {
        tried.push(`${url} (HTTP ${response.status})`);
        continue;
      }
      metadata = (await response.json()) as typeof metadata;
    } catch (error) {
      tried.push(`${url} (${error instanceof Error ? error.message : error})`);
      continue;
    }
    if (metadata.issuer !== issuer) {
      throw configurationError(
        `The authorization server metadata at ${url} names issuer "${String(metadata.issuer)}", which is not OAUTH_ISSUER_URL "${issuer}".`,
      );
    }
    if (typeof metadata.jwks_uri !== "string") {
      throw configurationError(
        `The authorization server metadata at ${url} has no jwks_uri. Set OAUTH_JWKS_URI.`,
      );
    }
    return metadata.jwks_uri;
  }
  throw configurationError(
    `No authorization server metadata found for OAUTH_ISSUER_URL "${issuer}". Tried ${tried.join(", ")}. Check the issuer, or set OAUTH_JWKS_URI.`,
  );
}

/**
 * The RFC 9728 Protected Resource Metadata of the MCP endpoint and where it
 * is served.
 *
 * @param resourceId - `MCP_RESOURCE_URL` as configured.
 * @param resource - The same, parsed.
 * @param issuer - The authorization server clients are sent to.
 */
export function protectedResourceMetadata(
  resourceId: string,
  resource: URL,
  issuer: string,
  requiredScopes: string[] = [],
): NonNullable<HttpAuth["protectedResourceMetadata"]> {
  return {
    // RFC 9728: the root form, and the form carrying the endpoint path
    // (as clients see it, and as this server routes it).
    paths: [
      ...new Set(
        ["", resource.pathname, config.mcpHttpEndpointPath].map(
          (path) =>
            PROTECTED_RESOURCE_METADATA_PATH + withoutTrailingSlash(path),
        ),
      ),
    ],
    document: {
      resource: resourceId,
      authorization_servers: [issuer],
      scopes_supported: requiredScopes.length > 0 ? requiredScopes : undefined,
      bearer_methods_supported: ["header"],
    },
  };
}

/** Reads a `scope` (space-separated) or `scp` (array) claim. */
function toScopes(claim: unknown): string[] {
  if (typeof claim === "string") {
    return claim.split(" ").filter(Boolean);
  }
  return Array.isArray(claim)
    ? claim.filter((scope): scope is string => typeof scope === "string")
    : [];
}

/**
 * Builds the OAuth authentication for the HTTP transport from the
 * configuration.
 *
 * @throws {McpError} `ConfigurationError` naming the setting at fault, or
 *   when the issuer's JWKS location cannot be discovered.
 */
export async function createOAuthAuth(
  context: RequestContext,
): Promise<HttpAuth> {
  const resourceId = requireSetting("MCP_RESOURCE_URL", config.mcpResourceUrl);
  const resource = parseUrl("MCP_RESOURCE_URL", resourceId);
  // The issuer stays the exact string configured: that is what the
  // authorization server's metadata and its tokens are compared with.
  const issuer = requireSetting("OAUTH_ISSUER_URL", config.oauthIssuerUrl);
  parseUrl("OAUTH_ISSUER_URL", issuer, true);
  const jwksUri = config.oauthJwksUri
    ? parseUrl("OAUTH_JWKS_URI", config.oauthJwksUri, true)
    : parseUrl(
        `The jwks_uri published by ${issuer}`,
        await discoverJwksUri(issuer),
        true,
      );
  const requiredScopes = config.oauthRequiredScopes ?? [];
  if (requiredScopes.includes("offline_access")) {
    throw configurationError(
      "OAUTH_REQUIRED_SCOPES must not contain offline_access: clients request it from the authorization server to get refresh tokens; it is not a scope of this resource.",
    );
  }
  // An empty OAUTH_AUDIENCE is unset, never "accept any audience".
  const audienceOverride = config.oauthAudience || undefined;

  // The resource as token audiences are compared with it: parsed, so the
  // case of scheme and host does not matter, and without a trailing slash,
  // because authorization servers differ on it.
  const canonicalResource = withoutTrailingSlash(resource.href);
  const namesThisResource = (audience: string): boolean =>
    URL.canParse(audience) &&
    withoutTrailingSlash(new URL(audience).href) === canonicalResource;

  // jose caches the key set and rate-limits refetches for unknown key ids.
  const jwks = createRemoteJWKSet(jwksUri);

  const verifier: OAuthTokenVerifier = {
    async verifyAccessToken(token) {
      try {
        const { payload } = await jwtVerify(token, jwks, {
          issuer,
          audience: audienceOverride,
          algorithms: TOKEN_ALGORITHMS,
          requiredClaims: ["exp"],
        });
        // jose has matched an OAUTH_AUDIENCE override, which the operator
        // declares to mean this server. Otherwise the token must name the
        // resource URL itself.
        const audience = audienceOverride
          ? resource.href
          : [payload.aud ?? []].flat().find(namesThisResource);
        if (!audience) {
          throw new errors.JWTClaimValidationFailed(
            'unexpected "aud" claim value',
            payload,
            "aud",
            "check_failed",
          );
        }
        const clientId = [payload.client_id, payload.azp, payload.sub].find(
          (claim): claim is string => typeof claim === "string" && claim !== "",
        );
        if (!clientId) {
          throw new Error("Token has no client_id, azp or sub claim.");
        }
        return {
          token,
          clientId,
          scopes: toScopes(payload.scope ?? payload.scp),
          expiresAt: payload.exp,
          // requireBearerAuth compares this with `expectedResource`.
          resource: new URL(audience),
          extra: { subject: payload.sub },
        };
      } catch (error) {
        // The reason stays in the log; the caller only learns the token is
        // invalid. The token itself is never logged.
        logger.warning(
          {
            ...context,
            reason:
              (error as { code?: string }).code ??
              (error instanceof Error ? error.message : String(error)),
            tokenFingerprint: createHash("sha256")
              .update(token)
              .digest("hex")
              .slice(0, 12),
          },
          "Access token rejected.",
        );
        throw new OAuthError(
          OAuthErrorCode.InvalidToken,
          "Invalid access token",
        );
      }
    },
  };

  logger.info(
    {
      ...context,
      resource: resourceId,
      issuer,
      jwksUri: jwksUri.href,
      requiredScopes,
    },
    "OAuth authentication enabled. Tokens identify the caller only: all SQL runs as the configured service account (DB2i_USER or the YAML source's user).",
  );

  return {
    authenticate: requireBearerAuth({
      verifier,
      requiredScopes,
      resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resource),
      expectedResource: resource,
    }),
    protectedResourceMetadata: protectedResourceMetadata(
      resourceId,
      resource,
      issuer,
      requiredScopes,
    ),
  };
}

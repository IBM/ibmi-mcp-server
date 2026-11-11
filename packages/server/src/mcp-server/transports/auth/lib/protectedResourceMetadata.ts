/**
 * @fileoverview OAuth 2.0 Protected Resource Metadata (RFC 9728) helpers.
 *
 * MCP clients discover the authorization server by reading this document, which
 * they locate either from the `resource_metadata` parameter of a `WWW-Authenticate`
 * challenge on a 401 response, or by probing the server's well-known paths. Both
 * the transport (which serves the document) and the HTTP error handler (which
 * emits the challenge) derive their URLs here so the two cannot drift apart.
 *
 * @module src/mcp-server/transports/auth/lib/protectedResourceMetadata
 */

import { config } from "@/config/index.js";

/**
 * The metadata document as published to clients.
 * @see https://www.rfc-editor.org/rfc/rfc9728#section-2
 */
export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  bearer_methods_supported: string[];
  scopes_supported?: string[];
}

interface ResolvedMetadata {
  document: ProtectedResourceMetadata;
  /** Path carrying the resource's own path component, per RFC 9728 section 3.1. */
  canonicalPath: string;
  /** Path clients fall back to when the canonical path 404s. */
  fallbackPath: string;
  /** Absolute URL advertised in the `WWW-Authenticate` challenge. */
  canonicalUrl: string;
}

const WELL_KNOWN_PREFIX = "/.well-known/oauth-protected-resource";

/**
 * Resolves protected resource metadata from configuration.
 *
 * Returns `undefined` when the server is not running in OAuth mode or the
 * required configuration is absent, in which case no discovery routes are
 * mounted and no challenge header is emitted.
 */
export function resolveProtectedResourceMetadata():
  | ResolvedMetadata
  | undefined {
  if (config.mcpAuthMode !== "oauth") {
    return undefined;
  }
  if (!config.oauthResourceUrl || !config.oauthIssuerUrl) {
    return undefined;
  }

  const resource = new URL(config.oauthResourceUrl);
  // A trailing slash would produce a doubled separator in the canonical path.
  const resourcePath = resource.pathname.replace(/\/+$/, "");
  const canonicalPath = `${WELL_KNOWN_PREFIX}${resourcePath}`;

  const document: ProtectedResourceMetadata = {
    resource: config.oauthResourceUrl,
    // Clients use the first entry and do not fall back to later ones.
    authorization_servers: [config.oauthIssuerUrl],
    bearer_methods_supported: ["header"],
  };
  if (config.oauthScopesSupported?.length) {
    document.scopes_supported = config.oauthScopesSupported;
  }

  return {
    document,
    canonicalPath,
    fallbackPath: WELL_KNOWN_PREFIX,
    canonicalUrl: `${resource.origin}${canonicalPath}`,
  };
}

/**
 * Builds the `WWW-Authenticate` header value for a 401 response.
 *
 * @returns The challenge value, or `undefined` if discovery is not configured.
 */
export function buildBearerChallenge(): string | undefined {
  const metadata = resolveProtectedResourceMetadata();
  if (!metadata) {
    return undefined;
  }

  const parts = [`Bearer resource_metadata="${metadata.canonicalUrl}"`];
  const scopes = metadata.document.scopes_supported;
  if (scopes?.length) {
    parts.push(`scope="${scopes.join(" ")}"`);
  }
  return parts.join(", ");
}

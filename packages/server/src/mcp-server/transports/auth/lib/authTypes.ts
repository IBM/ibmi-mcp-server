/**
 * @fileoverview Shared types for HTTP authentication.
 * @module src/mcp-server/transports/auth/lib/authTypes
 */

import type {
  AuthInfo as SdkAuthInfo,
  OAuthProtectedResourceMetadata,
} from "@modelcontextprotocol/server";

/**
 * The verified identity of a request. The token's subject, when it has one,
 * is in `extra.subject`.
 */
export type AuthInfo = SdkAuthInfo & {
  /**
   * The caller's IBM i token, which selects their authenticated pool.
   * @deprecated Set only by IBM i HTTP token authentication.
   */
  ibmiToken?: string;
  /** @deprecated Set only by IBM i HTTP token authentication. */
  ibmiHost?: string;
};

/** How the HTTP transport authenticates requests to the MCP endpoint. */
export interface HttpAuth {
  /**
   * Resolves to the caller's identity, or to the response that refuses the
   * request.
   */
  authenticate(request: Request): Promise<AuthInfo | Response>;
  /**
   * OAuth only: the RFC 9728 Protected Resource Metadata document and the
   * paths it is served at, without authentication.
   */
  protectedResourceMetadata?: {
    paths: string[];
    document: OAuthProtectedResourceMetadata;
  };
}

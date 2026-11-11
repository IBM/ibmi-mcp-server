/**
 * @fileoverview The built-in IBM i sign-on (`MCP_AUTH_MODE=oauth` without
 * `OAUTH_ISSUER_URL`) as the transports see it: what the server refuses to
 * start with in this mode, and the resource-server side of the MCP endpoint,
 * which resolves an access token to the sign-on (grant) it belongs to.
 *
 * The authorization server itself (sign-in page, token endpoint) is
 * src/ibmi-mcp-server/oauth/.
 * @module src/mcp-server/transports/auth/builtinOAuth
 */

import inspector from "node:inspector";
import {
  getOAuthProtectedResourceMetadataUrl,
  OAuthError,
  OAuthErrorCode,
  requireBearerAuth,
  type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";
import { config } from "@/config/index.js";
import {
  CONNECTION_CLOSED_DESCRIPTION,
  GRANT_TOKEN_PREFIX,
  type GrantAuthExtra,
  type GrantManager,
  type MapepireClient,
} from "@/ibmi-mcp-server/oauth/contracts.js";
import { createMapepireClient } from "@/ibmi-mcp-server/oauth/mapepireSession.js";
import {
  logger,
  requestContextService,
  type RequestContext,
} from "@/utils/index.js";
import { isLoopback } from "../http/hostValidation.js";
import { readSettingFile } from "../http/settingFile.js";
import type { HttpAuth } from "./lib/authTypes.js";
import { configurationError, protectedResourceMetadata } from "./oauth.js";

/**
 * Checks what the built-in IBM i sign-on needs before anything else starts,
 * and builds the client its connections are opened with. Opens nothing.
 *
 * Runs after the command-line overrides are applied. The settings that can
 * be judged from the environment alone (`MCP_RESOURCE_URL`, the TLS file
 * pair, `OAUTH_JWKS_URI`, ...) are refused by the config module.
 *
 * @throws {McpError} `ConfigurationError` saying what to change.
 */
export function createBuiltinMapepireClient(): MapepireClient {
  const { host, port, serverCertFile, caFile } = config.oauth.mapepire;

  if (config.mcpTransportType !== "http") {
    throw configurationError(
      "MCP_AUTH_MODE=oauth without OAUTH_ISSUER_URL (users sign on with their IBM i profile) needs the HTTP transport: set MCP_TRANSPORT_TYPE=http.",
    );
  }
  if (!isLoopback(config.mcpHttpHost.toLowerCase()) && !config.mcpTlsCertFile) {
    throw configurationError(
      `MCP_HTTP_HOST=${config.mcpHttpHost} is not a loopback address and users type their IBM i password into a page this server serves: set MCP_TLS_CERT_FILE and MCP_TLS_KEY_FILE, or set MCP_HTTP_HOST=127.0.0.1 and put a TLS proxy on this host in front.`,
    );
  }
  // A public resource URL served from a loopback listener without TLS: a
  // TLS proxy on this host is in front. Unless it is named, and so has to
  // report the client, every user appears at its loopback address, which
  // the sign-in page admits.
  const resourceHost = URL.canParse(config.mcpResourceUrl ?? "")
    ? new URL(config.mcpResourceUrl!).hostname
        .replace(/^\[|\]$/g, "")
        .toLowerCase()
    : undefined;
  if (
    !config.mcpTlsCertFile &&
    resourceHost !== undefined &&
    !isLoopback(resourceHost) &&
    config.mcpTrustedProxies.length === 0
  ) {
    throw configurationError(
      `MCP_RESOURCE_URL names ${resourceHost} while the server listens on ${config.mcpHttpHost} without TLS, so a proxy on this host is in front of it, and MCP_TRUSTED_PROXIES does not name that proxy: every user would appear at the proxy's address and pass OAUTH_SIGNON_ALLOWED_CIDRS. Set MCP_TRUSTED_PROXIES=127.0.0.1 (add ::1 if the proxy connects over IPv6) and have the proxy set X-Forwarded-For.`,
    );
  }
  if (process.env.DB2i_PASS) {
    throw configurationError(
      "DB2i_PASS must not be set when users sign on with their IBM i profile (MCP_AUTH_MODE=oauth without OAUTH_ISSUER_URL): remove DB2i_PASS, no SQL runs as a service account in this mode.",
    );
  }
  // Only when set: the service-account default (true) does not apply here.
  const ignoreUnauthorized = ["true", "1"].includes(
    process.env.DB2i_IGNORE_UNAUTHORIZED ?? "",
  );
  const certificateSetting = serverCertFile
    ? "DB2i_SERVER_CERT_FILE"
    : caFile
      ? "DB2i_CA_FILE"
      : undefined;
  if (ignoreUnauthorized && certificateSetting) {
    throw configurationError(
      `DB2i_IGNORE_UNAUTHORIZED=true and ${certificateSetting} contradict each other: the first turns verification of the Mapepire certificate off, the second says what to verify it against. Remove one of them.`,
    );
  }
  if (!host) {
    throw configurationError(
      "DB2i_HOST is required when users sign on with their IBM i profile (MCP_AUTH_MODE=oauth without OAUTH_ISSUER_URL): set it to the IBM i they sign on to.",
    );
  }
  if (config.ibmiHttpAuth.enabled) {
    throw configurationError(
      "IBMI_HTTP_AUTH_ENABLED=true cannot be combined with MCP_AUTH_MODE=oauth without OAUTH_ISSUER_URL: remove IBMI_HTTP_AUTH_ENABLED, users sign on at the built-in sign-in page.",
    );
  }
  if (inspector.url()) {
    throw configurationError(
      "The Node.js inspector is active, and it can read what users type at the IBM i sign-in page: start the server without --inspect.",
    );
  }

  // Refuses a DB2i_JDBC_OPTIONS key outside its allowlist.
  const client = createMapepireClient({
    host,
    port,
    trust: ignoreUnauthorized
      ? { kind: "unverified" }
      : serverCertFile
        ? {
            kind: "pin",
            pem: readSettingFile("DB2i_SERVER_CERT_FILE", serverCertFile),
          }
        : caFile
          ? { kind: "ca", pem: readSettingFile("DB2i_CA_FILE", caFile) }
          : { kind: "default" },
    jdbcOptions: config.db2iJdbcOptions,
  });
  if (ignoreUnauthorized) {
    logger.warning(
      requestContextService.createRequestContext({
        operation: "createBuiltinMapepireClient",
      }),
      "DB2i_IGNORE_UNAUTHORIZED=true: the Mapepire certificate is not verified, so the IBM i passwords users type on the sign-in page are sent to a server whose identity is not checked. Set DB2i_SERVER_CERT_FILE or DB2i_CA_FILE instead to verify it.",
    );
  }
  return client;
}

/**
 * Builds the authentication of the MCP endpoint for the built-in IBM i
 * sign-on. An access token is looked up in the grant manager on every
 * request: that is what keeps the grant's IBM i connection from being closed
 * as idle, so the answer is never cached.
 *
 * @throws {McpError} `ConfigurationError` without `MCP_RESOURCE_URL`.
 */
export function createBuiltinOAuthAuth(
  grants: Pick<GrantManager, "authenticate">,
  context: RequestContext,
): HttpAuth {
  const resourceId = config.mcpResourceUrl;
  const issuer = config.oauth.issuer;
  if (!resourceId || !issuer) {
    throw configurationError(
      "MCP_RESOURCE_URL is required when MCP_AUTH_MODE=oauth.",
    );
  }
  const resource = new URL(resourceId);

  const verifier: OAuthTokenVerifier = {
    async verifyAccessToken(bearer) {
      const identity = await grants.authenticate(bearer);
      if (typeof identity === "string") {
        // "connection closed": the sign-on stands but its IBM i connection
        // was closed. A client answers that 401 by presenting its refresh
        // token, which reopens the connection.
        throw new OAuthError(
          OAuthErrorCode.InvalidToken,
          identity === "connection_closed"
            ? CONNECTION_CLOSED_DESCRIPTION
            : "Invalid access token",
        );
      }
      return {
        // Never the bearer: handlers and logs see which sign-on it is.
        token: GRANT_TOKEN_PREFIX + identity.grantId,
        clientId: identity.clientId,
        scopes: [],
        expiresAt: identity.expiresAt,
        extra: {
          subject: identity.profile,
          grantId: identity.grantId,
        } satisfies GrantAuthExtra,
      };
    },
  };

  logger.info(
    { ...context, resource: resourceId, issuer },
    "Built-in OAuth authorization server enabled. Users sign on with their IBM i profile and all SQL runs as the signed-on user.",
  );

  return {
    authenticate: requireBearerAuth({
      verifier,
      resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resource),
    }),
    protectedResourceMetadata: protectedResourceMetadata(
      resourceId,
      resource,
      issuer,
    ),
  };
}

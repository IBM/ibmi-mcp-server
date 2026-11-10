/**
 * @fileoverview Selects the HTTP authentication for the configured
 * `MCP_AUTH_MODE`.
 * @module src/mcp-server/transports/auth/authFactory
 */
import { config } from "@/config/index.js";
import { JsonRpcErrorCode, McpError } from "@/types-global/errors.js";
import { logger, type RequestContext } from "@/utils/index.js";
import { getPublicKeyMetadata } from "@/ibmi-mcp-server/auth/crypto.js";
import { authenticateIbmiToken } from "./ibmiTokenAuth.js";
import type { HttpAuth } from "./lib/authTypes.js";
import { createOAuthAuth } from "./oauth.js";

const jwtModeRetired = (): McpError =>
  new McpError(
    JsonRpcErrorCode.ConfigurationError,
    "MCP_AUTH_MODE=jwt is no longer supported. Use MCP_AUTH_MODE=oauth with MCP_RESOURCE_URL and OAUTH_ISSUER_URL.",
  );

/**
 * Refuses to start with the retired `jwt` auth mode, on either transport.
 *
 * @throws {McpError} `ConfigurationError`.
 */
export function assertAuthModeSupported(): void {
  if (config.mcpAuthMode === "jwt") {
    throw jwtModeRetired();
  }
}

/**
 * Builds the authentication for the HTTP transport.
 *
 * @returns `null` when authentication is disabled (`MCP_AUTH_MODE=none`).
 * @throws {McpError} `ConfigurationError` if the mode is misconfigured.
 */
export async function createHttpAuth(
  context: RequestContext,
): Promise<HttpAuth | null> {
  if (config.mcpAuthMode === "ibmi" || config.ibmiHttpAuth.enabled) {
    logger.warning(
      context,
      "IBM i HTTP token authentication is deprecated and will be removed in a future major release; use MCP_AUTH_MODE=oauth for multi-user remote deployments.",
    );
    if (config.ibmiHttpAuth.allowedHosts.length === 0) {
      throw new McpError(
        JsonRpcErrorCode.ConfigurationError,
        "IBM i HTTP authentication needs the IBM i hosts users may sign on to: set IBMI_AUTH_ALLOWED_HOSTS (comma-separated host names) or DB2i_HOST.",
      );
    }
  }
  if (config.ibmiHttpAuth.enabled) {
    // Read the key pair now: a bad key path must stop startup, not fail
    // every sign-on.
    try {
      getPublicKeyMetadata();
    } catch (error) {
      throw new McpError(
        JsonRpcErrorCode.ConfigurationError,
        `The IBM i HTTP authentication key pair could not be loaded (IBMI_AUTH_PRIVATE_KEY_PATH, IBMI_AUTH_PUBLIC_KEY_PATH): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  switch (config.mcpAuthMode) {
    case "jwt":
      throw jwtModeRetired();
    case "oauth":
      return createOAuthAuth(context);
    case "ibmi":
      return { authenticate: authenticateIbmiToken };
    case "none":
      logger.info(context, "Authentication is disabled ('none' mode).");
      return null;
  }
}

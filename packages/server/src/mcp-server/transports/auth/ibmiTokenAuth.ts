/**
 * @fileoverview Authenticates requests carrying an IBM i bearer token issued
 * by `/api/v1/auth` (TokenManager), and routes them to the caller's
 * authenticated pool.
 * @deprecated IBM i HTTP token authentication will be removed in a future
 * major release. Use `MCP_AUTH_MODE=oauth`.
 * @module src/mcp-server/transports/auth/ibmiTokenAuth
 */

import { JsonRpcErrorCode, McpError } from "@/types-global/errors.js";
import { logger, requestContextService } from "@/utils/index.js";
import { TokenManager } from "@/ibmi-mcp-server/auth/tokenManager.js";
import type { AuthInfo } from "./lib/authTypes.js";

/**
 * Verifies the request's IBM i bearer token.
 *
 * @throws {McpError} `Unauthorized` if the token is missing, unknown or
 *   expired.
 */
export async function authenticateIbmiToken(
  request: Request,
): Promise<AuthInfo> {
  const context = requestContextService.createRequestContext({
    operation: "authenticateIbmiToken",
  });

  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    logger.warning(context, "Authorization header missing or invalid.");
    throw new McpError(
      JsonRpcErrorCode.Unauthorized,
      "Missing or invalid Authorization header. Bearer scheme required.",
      context,
    );
  }

  const token = authHeader.substring(7);
  if (!token) {
    logger.warning(
      context,
      "Bearer token is missing from Authorization header.",
    );
    throw new McpError(
      JsonRpcErrorCode.Unauthorized,
      "Authentication token is missing.",
      context,
    );
  }

  const validation = TokenManager.getInstance().validateToken(token, context);
  if (!validation.valid || !validation.session) {
    const errorContext = {
      ...context,
      tokenPrefix: token.substring(0, 10) + "...",
    };
    logger.warning(
      { ...errorContext, error: validation.error },
      "IBM i token validation failed",
    );
    throw new McpError(
      JsonRpcErrorCode.Unauthorized,
      validation.error || "Invalid IBM i authentication token",
      errorContext,
    );
  }

  const { user, host } = validation.session.credentials;
  return {
    token,
    clientId: user,
    scopes: ["ibmi:access"],
    extra: { subject: user },
    ibmiToken: token,
    ibmiHost: host,
  };
}

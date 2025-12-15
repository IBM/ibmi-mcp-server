/**
 * @fileoverview HTTP authentication endpoint implementation for IBM i authentication.
 * Provides POST /api/v1/auth endpoint with TLS enforcement and bearer token generation.
 *
 * @module src/ibmi-mcp-server/auth/httpAuthEndpoint
 */

import { Context } from "hono";
import { config } from "@/config/index.js";
import { logger, requestContextService } from "@/utils/index.js";
import { JsonRpcErrorCode, McpError } from "@/types-global/errors.js";
import { TokenManager } from "./tokenManager.js";
import { AuthenticatedPoolManager } from "../services/authenticatedPoolManager.js";
import {
  type AuthRequest,
  type AuthResponse,
  type AuthCredentials,
  type EncryptedAuthEnvelope,
} from "./types.js";
import { decryptAuthEnvelope } from "./crypto.js";

/**
 * Validate authentication request body
 * @param body - Request body to validate
 * @returns Validated request or throws error
 */
function validateAuthRequest(body: unknown): AuthRequest {
  if (!body || typeof body !== "object") {
    throw new McpError(
      JsonRpcErrorCode.InvalidRequest,
      "Request body must be a JSON object",
    );
  }

  const request = body as Record<string, unknown>;
  const validated: Partial<AuthRequest> = {};

  // Validate host (required)
  if (
    !request.host ||
    typeof request.host !== "string" ||
    request.host.trim().length === 0
  ) {
    throw new McpError(
      JsonRpcErrorCode.InvalidRequest,
      "Host is required and must be a non-empty string",
    );
  }
  validated.host = request.host.trim();

  // Validate duration
  if (request.duration !== undefined) {
    if (
      typeof request.duration !== "number" ||
      request.duration <= 0 ||
      request.duration > 86400
    ) {
      throw new McpError(
        JsonRpcErrorCode.InvalidRequest,
        "Duration must be a positive number not exceeding 86400 seconds (24 hours)",
      );
    }
    validated.duration = request.duration;
  }

  // Validate poolstart
  if (request.poolstart !== undefined) {
    if (
      typeof request.poolstart !== "number" ||
      request.poolstart < 1 ||
      request.poolstart > 50
    ) {
      throw new McpError(
        JsonRpcErrorCode.InvalidRequest,
        "poolstart must be a number between 1 and 50",
      );
    }
    validated.poolstart = request.poolstart;
  }

  // Validate poolmax
  if (request.poolmax !== undefined) {
    if (
      typeof request.poolmax !== "number" ||
      request.poolmax < 1 ||
      request.poolmax > 100
    ) {
      throw new McpError(
        JsonRpcErrorCode.InvalidRequest,
        "poolmax must be a number between 1 and 100",
      );
    }
    validated.poolmax = request.poolmax;
  }

  // Validate poolstart <= poolmax
  if (
    validated.poolstart &&
    validated.poolmax &&
    validated.poolstart > validated.poolmax
  ) {
    throw new McpError(
      JsonRpcErrorCode.InvalidRequest,
      "poolstart cannot be greater than poolmax",
    );
  }

  return validated as AuthRequest;
}

function validateEncryptedEnvelope(body: unknown): EncryptedAuthEnvelope {
  if (!body || typeof body !== "object") {
    throw new McpError(
      JsonRpcErrorCode.InvalidRequest,
      "Encrypted payload must be a JSON object",
    );
  }

  const envelope = body as Record<string, unknown>;
  const requiredFields: Array<keyof EncryptedAuthEnvelope> = [
    "keyId",
    "encryptedSessionKey",
    "iv",
    "authTag",
    "ciphertext",
  ];

  for (const field of requiredFields) {
    const value = envelope[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new McpError(
        JsonRpcErrorCode.InvalidRequest,
        `Encrypted payload is missing required field: ${field}`,
      );
    }
  }

  return {
    keyId: envelope.keyId as string,
    encryptedSessionKey: envelope.encryptedSessionKey as string,
    iv: envelope.iv as string,
    authTag: envelope.authTag as string,
    ciphertext: envelope.ciphertext as string,
  };
}

function validateCredentials(credentials: AuthCredentials): AuthCredentials {
  if (!credentials.username || !credentials.username.trim()) {
    throw new McpError(JsonRpcErrorCode.InvalidRequest, "Username is required");
  }

  if (credentials.password === undefined || credentials.password === null) {
    throw new McpError(JsonRpcErrorCode.InvalidRequest, "Password is required");
  }

  return {
    username: credentials.username.trim(),
    password: credentials.password,
  };
}

/**
 * Middleware to enforce TLS for authentication endpoints
 * In development environment, TLS can be bypassed with IBMI_AUTH_ALLOW_HTTP=true
 */
export const enforceTLS = async (c: Context, next: () => Promise<void>) => {
  const protocol =
    c.req.header("x-forwarded-proto") ||
    (c.req.url.startsWith("https:") ? "https" : "http");

  // Allow HTTP in development if explicitly configured
  const allowHttp =
    config.environment === "development" && config.ibmiHttpAuth.allowHttp;

  if (protocol !== "https" && !allowHttp) {
    const context = requestContextService.createRequestContext({
      operation: "enforceTLS",
      protocol,
      url: c.req.url,
    });

    logger.warning(
      {
        ...context,
        clientIp:
          c.req.header("x-forwarded-for") ||
          c.req.header("x-real-ip") ||
          "unknown",
        allowHttp,
        environment: config.environment,
      },
      "TLS required for authentication endpoint",
    );

    throw new McpError(
      JsonRpcErrorCode.InvalidRequest,
      "HTTPS/TLS is required for authentication endpoints",
    );
  }

  if (allowHttp && protocol === "http") {
    logger.warning(
      {
        operation: "enforceTLS",
        protocol,
        environment: config.environment,
      },
      "Allowing HTTP for authentication endpoint in development mode",
    );
  }

  await next();
};

/**
 * Handle POST /api/v1/auth authentication requests
 */
export const handleAuthRequest = async (c: Context) => {
  const context = requestContextService.createRequestContext({
    operation: "handleAuthRequest",
    method: c.req.method,
    path: c.req.path,
  });

  try {
    // Check if IBM i HTTP auth is enabled
    if (!config.ibmiHttpAuth.enabled) {
      throw new McpError(
        JsonRpcErrorCode.MethodNotFound,
        "IBM i HTTP authentication is not enabled on this server",
      );
    }

    let envelope: EncryptedAuthEnvelope;
    try {
      const body = await c.req.json();
      envelope = validateEncryptedEnvelope(body);
    } catch (error) {
      if (error instanceof McpError) {
        throw error;
      }
      throw new McpError(
        JsonRpcErrorCode.InvalidRequest,
        "Invalid JSON in request body",
      );
    }

    const decrypted = decryptAuthEnvelope(envelope, context);
    const credentials = validateCredentials(decrypted.credentials);
    const requestBody = validateAuthRequest(decrypted.request);

    logger.info(
      {
        ...context,
        user: credentials.username,
      },
      "Processing authentication request",
    );

    // Check concurrent session limits
    const tokenManager = TokenManager.getInstance();
    if (!tokenManager.canCreateNewSession()) {
      throw new McpError(
        JsonRpcErrorCode.InternalError,
        "Maximum concurrent sessions reached. Please try again later",
      );
    }

    // Create IBM i credentials as DaemonServer object using existing config defaults
    // Default to ignore unauthorized SSL (like existing connectionPool.ts)
    const ignoreUnauthorized = config.db2i?.ignoreUnauthorized ?? true;
    const ibmiCredentials = {
      host: requestBody.host,
      user: credentials.username,
      password: credentials.password,
      rejectUnauthorized: !ignoreUnauthorized, // Use existing Db2i config
    };

    // Generate authentication token
    const token = tokenManager.generateToken(
      ibmiCredentials,
      requestBody.duration,
      context,
    );

    // Create authenticated pool
    const poolManager = AuthenticatedPoolManager.getInstance();
    await poolManager.createPool(
      token,
      ibmiCredentials,
      {
        startingSize: requestBody.poolstart || 2,
        maxSize: requestBody.poolmax || 10,
      },
      context,
    );

    // Calculate expiration
    const expirySeconds =
      requestBody.duration || config.ibmiHttpAuth.tokenExpirySeconds;
    const expiresAt = new Date(Date.now() + expirySeconds * 1000);

    const response: AuthResponse = {
      access_token: token,
      token_type: "Bearer",
      expires_in: expirySeconds,
      expires_at: expiresAt.toISOString(),
    };

    logger.info(
      {
        ...context,
        user: credentials.username,
        expiresAt: expiresAt.toISOString(),
        poolStartingSize: requestBody.poolstart || 2,
        poolMaxSize: requestBody.poolmax || 10,
      },
      "Authentication successful, token generated",
    );

    return c.json(response, 201);
  } catch (error) {
    if (error instanceof McpError) {
      logger.warning(
        {
          ...context,
          errorCode: error.code,
          errorMessage: error.message,
        },
        "Authentication request failed",
      );

      const status =
        error.code === JsonRpcErrorCode.InvalidRequest
          ? 400
          : error.code === JsonRpcErrorCode.MethodNotFound
            ? 404
            : error.code === JsonRpcErrorCode.Unauthorized
              ? 401
              : 500;

      return c.json(
        {
          error: {
            code: error.code,
            message: error.message,
          },
        },
        status,
      );
    }

    logger.error(
      {
        ...context,
        error: error instanceof Error ? error.message : String(error),
      },
      "Unexpected error in authentication request",
    );

    return c.json(
      {
        error: {
          code: JsonRpcErrorCode.InternalError,
          message: "Internal server error",
        },
      },
      500,
    );
  }
};

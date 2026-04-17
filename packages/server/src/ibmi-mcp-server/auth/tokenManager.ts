/**
 * @fileoverview Token management system for IBM i HTTP authentication.
 * Handles secure token generation, validation, and lifecycle management.
 *
 * @module src/ibmi-mcp-server/auth/tokenManager
 */

import crypto from "crypto";
import { config } from "@/config/index.js";
import {
  logger,
  RequestContext,
  requestContextService,
} from "@/utils/index.js";

import type { DaemonServer } from "@ibm/mapepire-js";

/**
 * IBM i credentials for authenticated sessions - using DaemonServer interface
 */
export type IBMiCredentials = DaemonServer;

/**
 * Token session metadata
 */
export interface TokenSession {
  token: string;
  credentials: IBMiCredentials;
  createdAt: Date;
  expiresAt: Date;
  lastUsed: Date;
}

/**
 * Token generation and validation result
 */
export interface TokenValidationResult {
  valid: boolean;
  session?: TokenSession;
  error?: string;
}

/**
 * Token manager for secure token generation and session management
 */
export class TokenManager {
  private static instance: TokenManager;
  private sessions = new Map<string, TokenSession>();
  private cleanupTimer: NodeJS.Timeout | null = null;

  private constructor() {
    this.startCleanupTimer();
  }

  /**
   * Get singleton instance of TokenManager
   */
  static getInstance(): TokenManager {
    if (!TokenManager.instance) {
      TokenManager.instance = new TokenManager();
    }
    return TokenManager.instance;
  }

  /**
   * Generate a cryptographically secure bearer token (1024+ bytes)
   * @param credentials - IBM i credentials for this session
   * @param expirySeconds - Token lifetime in seconds (optional)
   * @returns Generated token string
   */
  generateToken(
    credentials: IBMiCredentials,
    expirySeconds?: number,
    context?: RequestContext,
  ): string {
    const operationContext =
      context ||
      requestContextService.createRequestContext({
        operation: "generateToken",
      });

    const expiry = expirySeconds || config.ibmiHttpAuth.tokenExpirySeconds;

    // Generate 1024+ bytes of secure random data
    const tokenBytes = crypto.randomBytes(256);
    const token = tokenBytes.toString("base64url");

    const now = new Date();
    const expiresAt = new Date(now.getTime() + expiry * 1000);

    const session: TokenSession = {
      token,
      credentials,
      createdAt: now,
      expiresAt,
      lastUsed: now,
    };

    this.sessions.set(token, session);

    logger.info(
      {
        ...operationContext,
        user: credentials.user,
        host: credentials.host,
        expirySeconds: expiry,
        expiresAt: expiresAt.toISOString(),
        sessionCount: this.sessions.size,
      },
      "Generated new authentication token",
    );

    return token;
  }

  /**
   * Validate a bearer token and return session info
   * @param token - Bearer token to validate
   * @returns Validation result with session info if valid
   */
  validateToken(
    token: string,
    context?: RequestContext,
  ): TokenValidationResult {
    const operationContext =
      context ||
      requestContextService.createRequestContext({
        operation: "validateToken",
      });

    if (!token || typeof token !== "string") {
      logger.debug({ ...operationContext }, "Invalid token format");
      return { valid: false, error: "Invalid token format" };
    }

    const session = this.sessions.get(token);
    if (!session) {
      logger.debug(
        {
          ...operationContext,
          tokenPrefix: token.substring(0, 10) + "...",
        },
        "Token not found in session store",
      );
      return { valid: false, error: "Token not found" };
    }

    // Check if token has expired
    if (new Date() > session.expiresAt) {
      logger.info(
        {
          ...operationContext,
          user: session.credentials.user,
          expiredAt: session.expiresAt.toISOString(),
        },
        "Token has expired",
      );

      this.sessions.delete(token);
      return { valid: false, error: "Token expired" };
    }

    // Update last used timestamp
    session.lastUsed = new Date();

    logger.debug(
      {
        ...operationContext,
        user: session.credentials.user,
        lastUsed: session.lastUsed.toISOString(),
      },
      "Token validated successfully",
    );

    return { valid: true, session };
  }

  /**
   * Revoke a specific token
   * @param token - Token to revoke
   */
  revokeToken(token: string, context?: RequestContext): boolean {
    const operationContext =
      context ||
      requestContextService.createRequestContext({
        operation: "revokeToken",
      });

    const session = this.sessions.get(token);
    if (!session) {
      logger.debug({ ...operationContext }, "Token not found for revocation");
      return false;
    }

    this.sessions.delete(token);

    logger.info(
      {
        ...operationContext,
        user: session.credentials.user,
        sessionCount: this.sessions.size,
      },
      "Token revoked successfully",
    );

    return true;
  }

  /**
   * Get current session statistics
   */
  getSessionStats(): {
    totalSessions: number;
    activeSessions: number;
    expiredSessions: number;
  } {
    const now = new Date();
    let activeSessions = 0;
    let expiredSessions = 0;

    for (const session of this.sessions.values()) {
      if (now <= session.expiresAt) {
        activeSessions++;
      } else {
        expiredSessions++;
      }
    }

    return {
      totalSessions: this.sessions.size,
      activeSessions,
      expiredSessions,
    };
  }

  /**
   * Clean up expired tokens
   */
  private cleanupExpiredTokens(): void {
    const context = requestContextService.createRequestContext({
      operation: "cleanupExpiredTokens",
    });

    const now = new Date();
    const expiredTokens: string[] = [];

    for (const [token, session] of this.sessions.entries()) {
      if (now > session.expiresAt) {
        expiredTokens.push(token);
      }
    }

    for (const token of expiredTokens) {
      this.sessions.delete(token);
    }

    if (expiredTokens.length > 0) {
      logger.info(
        {
          ...context,
          expiredCount: expiredTokens.length,
          remainingCount: this.sessions.size,
        },
        "Cleaned up expired tokens",
      );
    }
  }

  /**
   * Start the cleanup timer
   */
  private startCleanupTimer(): void {
    if (!config.ibmiHttpAuth.enabled) {
      return;
    }

    const intervalMs = config.ibmiHttpAuth.cleanupIntervalSeconds * 1000;

    this.cleanupTimer = setInterval(() => {
      this.cleanupExpiredTokens();
    }, intervalMs);

    logger.info(
      {
        operation: "startCleanupTimer",
        intervalSeconds: config.ibmiHttpAuth.cleanupIntervalSeconds,
      },
      "Started token cleanup timer",
    );
  }

  /**
   * Stop the cleanup timer and clear all sessions
   */
  shutdown(): void {
    const context = requestContextService.createRequestContext({
      operation: "tokenManagerShutdown",
    });

    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    const sessionCount = this.sessions.size;
    this.sessions.clear();

    logger.info(
      {
        ...context,
        clearedSessions: sessionCount,
      },
      "Token manager shutdown completed",
    );
  }

  /**
   * Check if max concurrent sessions limit would be exceeded
   */
  canCreateNewSession(): boolean {
    return this.sessions.size < config.ibmiHttpAuth.maxConcurrentSessions;
  }
}

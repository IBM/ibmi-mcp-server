/**
 * @fileoverview Authenticated IBM i pool management system.
 * Manages per-token Mapepire Pool instances with lifecycle management.
 * Extends BaseConnectionPool for consistent connection management patterns.
 *
 * @module src/ibmi-mcp-server/services/authenticatedPoolManager
 */

import { createHash } from "crypto";
import { BindingValue, QueryResult } from "@ibm/mapepire-js";
import {
  logger,
  RequestContext,
  requestContextService,
} from "@/utils/index.js";
import { ErrorHandler } from "@/utils/internal/errorHandler.js";
import { JsonRpcErrorCode, McpError } from "@/types-global/errors.js";
import { TokenManager, IBMiCredentials } from "../auth/tokenManager.js";
import {
  BaseConnectionPool,
  PoolConnectionConfig,
} from "./baseConnectionPool.js";
import { SqlToolSecurityConfig } from "@/ibmi-mcp-server/schemas/index.js";
import { config } from "@/config/index.js";

/**
 * Pool configuration options for authenticated sessions
 */
export interface AuthPoolOptions {
  startingSize?: number;
  maxSize?: number;
}

/**
 * Pool manager for per-token authenticated IBM i connections
 * Extends BaseConnectionPool to leverage shared connection management
 */
export class AuthenticatedPoolManager extends BaseConnectionPool<string> {
  private static instance: AuthenticatedPoolManager;
  private tokenManager: TokenManager;
  private credentialsMap = new Map<string, IBMiCredentials>();
  private expiredPoolTimer: NodeJS.Timeout | null = null;

  private constructor() {
    super();
    this.tokenManager = TokenManager.getInstance();
  }

  /**
   * Get singleton instance of AuthenticatedPoolManager
   */
  static getInstance(): AuthenticatedPoolManager {
    if (!AuthenticatedPoolManager.instance) {
      AuthenticatedPoolManager.instance = new AuthenticatedPoolManager();
    }
    return AuthenticatedPoolManager.instance;
  }

  /**
   * Pool ids here are bearer tokens: log a short one-way fingerprint instead
   * of the token itself.
   */
  protected describePool(token: string): string {
    return `token:${createHash("sha256").update(token).digest("hex").substring(0, 12)}`;
  }

  /**
   * Create a new authenticated pool for a token
   * @param token - Authentication token
   * @param credentials - IBM i credentials
   * @param options - Pool configuration options
   * @param context - Request context for logging
   * @returns Promise resolving when pool is created
   */
  async createPool(
    token: string,
    credentials: IBMiCredentials,
    options: AuthPoolOptions = {},
    context?: RequestContext,
  ): Promise<void> {
    const operationContext =
      context ||
      requestContextService.createRequestContext({
        operation: "createAuthenticatedPool",
        token: token.substring(0, 10) + "...",
      });

    // Read outside tryCatch: malformed options must fail before credentials are
    // stored, and tryCatch would put the raw option text in the sign-on response
    const jdbcOptions = config.db2iJdbcOptions;

    return ErrorHandler.tryCatch(
      async () => {
        logger.info(
          {
            ...operationContext,
            user: credentials.user,
            host: credentials.host,
            startingSize: options.startingSize || 2,
            maxSize: options.maxSize || 10,
            rejectUnauthorized: credentials.rejectUnauthorized,
          },
          "Creating authenticated pool",
        );

        // Store credentials mapping for this token
        this.credentialsMap.set(token, credentials);

        // Convert IBMi credentials to pool connection config
        const poolConfig: PoolConnectionConfig = {
          host: credentials.host,
          user: credentials.user,
          password: credentials.password,
          port: credentials.port,
          ignoreUnauthorized: !credentials.rejectUnauthorized,
          maxSize: options.maxSize || 10,
          startingSize: options.startingSize || 2,
          ...(jdbcOptions ? { jdbcOptions } : {}),
        };

        // Initialize pool using base class method
        try {
          await this.initializePool(token, poolConfig, operationContext);
        } catch (error) {
          // Sign-on failed, so this token is never handed to a client: drop
          // the stored credentials rather than keeping them until exit.
          this.credentialsMap.delete(token);
          this.pools.delete(token);
          throw error;
        }

        this.startExpiredPoolSweep();

        logger.info(
          {
            ...operationContext,
            user: credentials.user,
            poolCount: this.pools.size,
          },
          "Authenticated pool created successfully",
        );
      },
      {
        operation: "createAuthenticatedPool",
        context: operationContext,
        errorCode: JsonRpcErrorCode.InitializationFailed,
        critical: false,
      },
    );
  }

  /**
   * Validate token and ensure pool is available
   * @param token - Authentication token
   * @param context - Request context for logging
   * @returns Boolean indicating if token is valid and pool exists
   */
  private async validateTokenAndPool(
    token: string,
    context: RequestContext,
  ): Promise<boolean> {
    // First validate the token
    const tokenValidation = this.tokenManager.validateToken(token, context);
    if (!tokenValidation.valid || !tokenValidation.session) {
      logger.debug(
        {
          ...context,
          error: tokenValidation.error,
        },
        "Token validation failed for pool access",
      );
      return false;
    }

    // Check if pool exists for this token
    const poolState = this.pools.get(token);
    if (!poolState) {
      logger.debug(
        {
          ...context,
          user: tokenValidation.session.credentials.user,
        },
        "Pool not found for valid token",
      );
      return false;
    }

    logger.debug(
      {
        ...context,
        user: tokenValidation.session.credentials.user,
      },
      "Token and pool validation successful",
    );

    return true;
  }

  /**
   * Execute a query using an authenticated pool
   * @param token - Authentication token
   * @param query - SQL query to execute
   * @param params - Query parameters
   * @param context - Request context for logging
   * @returns Promise resolving to query result
   */
  async executeQuery<T = unknown>(
    token: string,
    query: string,
    params?: BindingValue[],
    context?: RequestContext,
    securityConfig?: SqlToolSecurityConfig,
    rowsToFetch?: number,
  ): Promise<QueryResult<T>> {
    const operationContext =
      context ||
      requestContextService.createRequestContext({
        operation: "executeAuthenticatedQuery",
        token: token.substring(0, 10) + "...",
      });

    return ErrorHandler.tryCatch(
      async () => {
        // Validate token and ensure pool exists
        const isValid = await this.validateTokenAndPool(
          token,
          operationContext,
        );
        if (!isValid) {
          throw new McpError(
            JsonRpcErrorCode.Unauthorized,
            "Invalid or expired authentication token",
          );
        }

        logger.debug(
          {
            ...operationContext,
            queryLength: query.length,
            paramCount: params?.length || 0,
          },
          "Executing authenticated query",
        );

        // Use base class executeQuery method
        const result = await super.executeQuery<T>(
          token,
          query,
          params,
          operationContext,
          securityConfig,
          rowsToFetch,
        );

        logger.debug(
          {
            ...operationContext,
            rowCount: result.data?.length || 0,
            success: result.success,
            executionTime: result.execution_time,
          },
          "Authenticated query completed",
        );

        return result;
      },
      {
        operation: "executeAuthenticatedQuery",
        context: operationContext,
        errorCode: JsonRpcErrorCode.DatabaseError,
      },
    );
  }

  /**
   * Execute a query with automatic pagination using an authenticated pool.
   * Fetches all available rows via repeated fetchMore calls (bounded by the
   * base pool's safety cap, IBMI_PAGINATION_MAX_ROWS).
   * @param token - Authentication token
   * @param query - SQL query to execute
   * @param params - Query parameters
   * @param context - Request context for logging
   * @param securityConfig - Optional security configuration
   */
  async executeQueryWithPagination(
    token: string,
    query: string,
    params?: BindingValue[],
    context?: RequestContext,
    fetchSize?: number,
    securityConfig?: SqlToolSecurityConfig,
  ) {
    const operationContext =
      context ||
      requestContextService.createRequestContext({
        operation: "executeAuthenticatedQueryWithPagination",
        token: token.substring(0, 10) + "...",
      });

    return ErrorHandler.tryCatch(
      async () => {
        const isValid = await this.validateTokenAndPool(
          token,
          operationContext,
        );
        if (!isValid) {
          throw new McpError(
            JsonRpcErrorCode.Unauthorized,
            "Invalid or expired authentication token",
          );
        }

        return super.executeQueryWithPagination(
          token,
          query,
          params,
          operationContext,
          fetchSize,
          securityConfig,
        );
      },
      {
        operation: "executeAuthenticatedQueryWithPagination",
        context: operationContext,
        errorCode: JsonRpcErrorCode.DatabaseError,
      },
    );
  }

  /**
   * Remove and close a pool by token
   * @param token - Authentication token
   * @param context - Request context for logging
   * @returns Promise resolving when pool is closed
   */
  async removePool(token: string, context?: RequestContext): Promise<boolean> {
    const operationContext =
      context ||
      requestContextService.createRequestContext({
        operation: "removeAuthenticatedPool",
        token: token.substring(0, 10) + "...",
      });

    const poolState = this.pools.get(token);
    if (!poolState) {
      logger.debug({ ...operationContext }, "Pool not found for removal");
      return false;
    }

    try {
      // Get credentials for logging before removal
      const credentials = this.credentialsMap.get(token);

      // Use base class closePool method
      await this.closePool(token, operationContext);

      // Drop the pool entry (it holds the connection config, including the
      // password) and the credentials mapping
      this.pools.delete(token);
      this.credentialsMap.delete(token);

      logger.info(
        {
          ...operationContext,
          user: credentials?.user,
          poolCount: this.pools.size,
        },
        "Authenticated pool removed successfully",
      );

      return true;
    } catch (error) {
      logger.error(
        {
          ...operationContext,
          error: error instanceof Error ? error.message : String(error),
        },
        "Error removing authenticated pool",
      );
      return false;
    }
  }

  /**
   * Start the periodic sweep that removes pools once their token is no longer
   * valid, so connections and stored credentials do not outlive the token.
   * Runs on the token cleanup interval. Idempotent.
   */
  private startExpiredPoolSweep(): void {
    if (this.expiredPoolTimer) {
      return;
    }

    this.expiredPoolTimer = setInterval(() => {
      this.cleanupExpiredPools().catch(() => {
        // best-effort
      });
    }, config.ibmiHttpAuth.cleanupIntervalSeconds * 1000);

    // Don't let the timer prevent process exit
    this.expiredPoolTimer.unref();
  }

  /**
   * Clean up pools for expired tokens
   * @param context - Request context for logging
   */
  async cleanupExpiredPools(context?: RequestContext): Promise<void> {
    const operationContext =
      context ||
      requestContextService.createRequestContext({
        operation: "cleanupExpiredPools",
      });

    const expiredTokens: string[] = [];

    // Check each pool's token validity
    for (const [token] of this.pools.entries()) {
      const tokenValidation = this.tokenManager.validateToken(token);
      if (!tokenValidation.valid) {
        expiredTokens.push(token);
      }
    }

    // Remove expired pools
    let cleanupCount = 0;
    for (const token of expiredTokens) {
      const removed = await this.removePool(token, operationContext);
      if (removed) {
        cleanupCount++;
      }
    }

    if (cleanupCount > 0) {
      logger.info(
        {
          ...operationContext,
          cleanupCount,
          remainingPools: this.pools.size,
        },
        "Cleaned up expired pools",
      );
    }
  }

  /**
   * Shutdown all pools and cleanup
   */
  async shutdown(context?: RequestContext): Promise<void> {
    const operationContext =
      context ||
      requestContextService.createRequestContext({
        operation: "authenticatedPoolManagerShutdown",
      });

    const poolCount = this.pools.size;

    if (this.expiredPoolTimer) {
      clearInterval(this.expiredPoolTimer);
      this.expiredPoolTimer = null;
    }

    // Base class handles stopIdleTimer + closeAllPools
    await super.shutdown(operationContext);

    // Clean up credentials mapping
    this.credentialsMap.clear();

    logger.info(
      {
        ...operationContext,
        closedPools: poolCount,
      },
      "Authenticated pool manager shutdown completed",
    );
  }
}

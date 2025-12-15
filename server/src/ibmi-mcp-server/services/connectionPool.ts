/**
 * @fileoverview IBM i connection pool management using mapepire-js
 * This module provides a singleton connection pool for IBM i DB2 database operations.
 * Credentials are provided by the MCP client via environment variables.
 *
 * @module src/services/mapepire/connectionPool
 */

import { BindingValue, QueryResult } from "@ibm/mapepire-js";
import { config } from "@/config/index.js";
import { logger } from "@/utils/internal/logger.js";
import { ErrorHandler } from "@/utils/internal/errorHandler.js";
import {
  requestContextService,
  RequestContext,
} from "@/utils/internal/requestContext.js";
import { JsonRpcErrorCode, McpError } from "@/types-global/errors.js";
import {
  BaseConnectionPool,
  PoolConnectionConfig,
} from "./baseConnectionPool.js";

// Singleton identifier for the IBM i connection pool
const IBM_I_POOL_ID = Symbol("ibmi-singleton-pool");

/**
 * IBM i connection pool manager with lazy initialization
 * Credentials are provided by MCP client via environment variables
 */
export class IBMiConnectionPool extends BaseConnectionPool<
  typeof IBM_I_POOL_ID
> {
  private static instance: IBMiConnectionPool | undefined;

  /**
   * Get the singleton instance
   */
  private static getInstance(): IBMiConnectionPool {
    if (!this.instance) {
      this.instance = new IBMiConnectionPool();
    }
    return this.instance;
  }

  /**
   * Initialize the connection pool using credentials from config
   * Called automatically on first query if not already initialized
   */
  private static async ensureInitialized(): Promise<void> {
    const instance = this.getInstance();
    const poolState = instance.pools.get(IBM_I_POOL_ID);

    if (poolState && poolState.isInitialized) {
      return;
    }

    const context = requestContextService.createRequestContext({
      operation: "InitializeIBMiConnectionPool",
    });

    try {
      // Check if Db2i configuration is available
      if (!config.db2i) {
        throw new McpError(
          JsonRpcErrorCode.ConfigurationError,
          "Db2i configuration not found. Please ensure DB2i_HOST, DB2i_USER, and DB2i_PASS environment variables are set.",
          { configSection: "db2i" },
        );
      }

      const { host, user, password, ignoreUnauthorized } = config.db2i;

      logger.info(
        {
          ...context,
          host,
          user: user.substring(0, 3) + "***", // Mask username for security
          ignoreUnauthorized,
        },
        "Initializing IBM i connection pool",
      );

      // Convert config to pool connection config
      const poolConfig: PoolConnectionConfig = {
        host,
        user,
        password,
        ignoreUnauthorized,
      };

      // Initialize the pool using base class
      await instance.initializePool(IBM_I_POOL_ID, poolConfig, context);

      logger.info(context, "IBM i connection pool initialized successfully");
    } catch (error) {
      const handledError = ErrorHandler.handleError(error, {
        operation: "InitializeIBMiConnectionPool",
        context,
        errorCode: JsonRpcErrorCode.InitializationFailed,
        critical: true,
      });

      throw handledError;
    }
  }

  /**
   * Execute a SQL query with automatic pagination to fetch all results
   * Uses the query/execute/fetchMore pattern for large result sets
   */
  static async executeQueryWithPagination(
    query: string,
    params?: BindingValue[],
    context?: RequestContext,
    fetchSize: number = 300,
  ): Promise<{
    data: unknown[];
    success: boolean;
    sql_rc?: unknown;
    execution_time?: number;
  }> {
    const operationContext =
      context ||
      requestContextService.createRequestContext({
        operation: "ExecuteQueryWithPagination",
      });

    await this.ensureInitialized();
    const instance = this.getInstance();
    return instance.executeQueryWithPagination(
      IBM_I_POOL_ID,
      query,
      params,
      operationContext,
      fetchSize,
    );
  }

  /**
   * Execute a SQL query against the IBM i database
   * Automatically initializes the pool if not already done
   */
  static async executeQuery(
    query: string,
    params?: BindingValue[],
    context?: RequestContext,
  ): Promise<QueryResult<unknown>> {
    const operationContext =
      context ||
      requestContextService.createRequestContext({
        operation: "ExecuteQuery",
      });

    await this.ensureInitialized();
    const instance = this.getInstance();
    return instance.executeQuery(
      IBM_I_POOL_ID,
      query,
      params,
      operationContext,
    );
  }

  /**
   * Check the health of the connection pool
   */
  static async healthCheck(): Promise<boolean> {
    const context = requestContextService.createRequestContext({
      operation: "ConnectionHealthCheck",
    });

    try {
      await this.ensureInitialized();
      const instance = this.getInstance();
      const health = await instance.checkPoolHealth(IBM_I_POOL_ID, context);

      logger.debug(context, "Connection health check passed");
      return health.status === "healthy";
    } catch (error) {
      logger.error(
        {
          ...context,
          error: error instanceof Error ? error.message : String(error),
        },
        "Connection health check failed",
      );
      return false;
    }
  }

  /**
   * Close the connection pool gracefully
   */
  static async close(): Promise<void> {
    const context = requestContextService.createRequestContext({
      operation: "CloseConnectionPool",
    });

    const instance = this.getInstance();
    const poolState = instance.pools.get(IBM_I_POOL_ID);

    if (poolState && poolState.pool) {
      logger.info(context, "Closing IBM i connection pool");
      await instance.closePool(IBM_I_POOL_ID, context);
      logger.info(context, "IBM i connection pool closed successfully");
    }
  }

  /**
   * Get connection pool status for monitoring
   */
  static getStatus(): {
    initialized: boolean;
    connecting: boolean;
    poolExists: boolean;
  } {
    const instance = this.getInstance();
    const poolStatus = instance.getPoolStatus(IBM_I_POOL_ID);

    return {
      initialized: poolStatus?.initialized ?? false,
      connecting: poolStatus?.connecting ?? false,
      poolExists: poolStatus !== null,
    };
  }
}

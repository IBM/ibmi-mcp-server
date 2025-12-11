/**
 * @fileoverview Base connection pool abstraction for IBM i connections
 * Provides shared connection pool logic that can be extended by specific implementations
 *
 * @module src/services/baseConnectionPool
 */

import pkg, { BindingValue, QueryResult, DaemonServer } from "@ibm/mapepire-js";
const { Pool, getRootCertificate } = pkg;
import { ErrorHandler, logger } from "@/utils/internal/index.js";
import {
  requestContextService,
  RequestContext,
} from "@/utils/internal/requestContext.js";
import { JsonRpcErrorCode, McpError } from "@/types-global/errors.js";
import { SqlToolSecurityConfig } from "@/ibmi-mcp-server/schemas/index.js";
import { SqlSecurityValidator } from "../utils/security/sqlSecurityValidator.js";

/**
 * Connection configuration for a pool instance
 */
export interface PoolConnectionConfig {
  host: string;
  user: string;
  password: string;
  port?: number;
  ignoreUnauthorized?: boolean;
  maxSize?: number;
  startingSize?: number;
}

/**
 * Pool instance state
 */
export interface PoolInstanceState {
  pool: InstanceType<typeof Pool> | null;
  isInitialized: boolean;
  isConnecting: boolean;
  lastHealthCheck?: Date;
  healthStatus: "healthy" | "unhealthy" | "unknown";
  config: PoolConnectionConfig;
}

/**
 * Health status information
 */
export interface PoolHealth {
  status: "healthy" | "unhealthy" | "unknown";
  lastCheck?: Date;
  lastError?: string;
  initialized: boolean;
  connecting: boolean;
}

/**
 * Base connection pool manager that provides shared functionality
 * for all IBM i connection pools in the application
 */
export abstract class BaseConnectionPool<TId extends string | symbol = string> {
  protected pools: Map<TId, PoolInstanceState> = new Map();
  protected initializationPromises: Map<TId, Promise<void>> = new Map();

  /**
   * Create a daemon server configuration from connection config
   * @param config - Connection configuration
   * @param context - Request context for logging
   */
  protected async createDaemonServer(
    config: PoolConnectionConfig,
    context: RequestContext,
  ): Promise<DaemonServer> {
    const server: DaemonServer = {
      host: config.host,
      user: config.user,
      password: config.password,
      rejectUnauthorized: !(config.ignoreUnauthorized ?? true),
    };

    // Get SSL certificate if needed
    if (!(config.ignoreUnauthorized ?? true)) {
      logger.debug(context, "Fetching SSL certificate for secure connection");
      server.ca = await getRootCertificate(server);
    }

    return server;
  }

  /**
   * Initialize a connection pool for the given identifier
   * @param poolId - Unique identifier for the pool
   * @param config - Connection configuration
   * @param context - Request context for logging
   */
  protected async initializePool(
    poolId: TId,
    config: PoolConnectionConfig,
    context: RequestContext,
  ): Promise<void> {
    // Check if there's already an initialization in progress
    const existingPromise = this.initializationPromises.get(poolId);
    if (existingPromise) {
      logger.debug(
        context,
        `Waiting for existing initialization of pool: ${String(poolId)}`,
      );
      return existingPromise;
    }

    let poolState = this.pools.get(poolId);
    if (!poolState) {
      poolState = {
        pool: null,
        isInitialized: false,
        isConnecting: false,
        healthStatus: "unknown",
        config,
      };
      this.pools.set(poolId, poolState);
    }

    // Check if already initialized
    if (poolState.isInitialized && poolState.pool) {
      logger.debug(context, `Pool '${String(poolId)}' already initialized`);
      return;
    }

    // Create initialization promise and store it
    const initPromise = this.performInitialization(poolId, poolState, context);
    this.initializationPromises.set(poolId, initPromise);

    try {
      await initPromise;
    } finally {
      // Clean up the promise from the map
      this.initializationPromises.delete(poolId);
    }
  }

  /**
   * Perform the actual initialization of a pool
   * @private
   */
  private async performInitialization(
    poolId: TId,
    poolState: PoolInstanceState,
    context: RequestContext,
  ): Promise<void> {
    // Double-check if already initialized (in case another thread completed it)
    if (poolState.isInitialized && poolState.pool) {
      return;
    }

    if (poolState.isConnecting) {
      logger.debug(
        context,
        `Pool '${String(poolId)}' is already connecting, waiting...`,
      );
      // Wait a bit and check again
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (poolState.isInitialized && poolState.pool) {
        return;
      }
    }

    poolState.isConnecting = true;

    try {
      logger.info(
        {
          ...context,
          host: poolState.config.host,
          port: poolState.config.port || 8471,
          user: poolState.config.user.substring(0, 3) + "***",
          ignoreUnauthorized: poolState.config.ignoreUnauthorized ?? true,
        },
        `Initializing connection pool: ${String(poolId).substring(0, 7)}***`,
      );

      // Create daemon server configuration
      const server = await this.createDaemonServer(poolState.config, context);

      // Create and initialize connection pool
      poolState.pool = new Pool({
        creds: server,
        maxSize: poolState.config.maxSize || 10,
        startingSize: poolState.config.startingSize || 2,
      });

      await poolState.pool.init();
      poolState.isInitialized = true;
      poolState.healthStatus = "healthy";
      poolState.lastHealthCheck = new Date();

      logger.info(
        context,
        `Connection pool initialized successfully: ${String(poolId).substring(0, 7)}***`,
      );
    } catch (error) {
      poolState.isInitialized = false;
      poolState.healthStatus = "unhealthy";
      poolState.pool = null;

      const handledError = ErrorHandler.handleError(error, {
        operation: "performInitialization",
        context,
        errorCode: JsonRpcErrorCode.InitializationFailed,
        critical: true,
      });

      throw handledError;
    } finally {
      poolState.isConnecting = false;
    }
  }

  /**
   * Execute a SQL query on a specific pool
   * @param poolId - Pool identifier
   * @param query - SQL query string
   * @param params - Query parameters
   * @param context - Request context for logging
   */
  protected async executeQuery<T = unknown>(
    poolId: TId,
    query: string,
    params?: BindingValue[],
    context?: RequestContext,
    securityConfig?: SqlToolSecurityConfig,
  ): Promise<QueryResult<T>> {
    const operationContext =
      context ||
      requestContextService.createRequestContext({
        operation: "ExecuteQuery",
        poolId: String(poolId),
      });

    return ErrorHandler.tryCatch(
      async () => {
        const poolState = this.pools.get(poolId);
        if (!poolState) {
          throw new McpError(
            JsonRpcErrorCode.ConfigurationError,
            `Pool '${String(poolId)}' not found. Please register the pool first.`,
            { poolId: String(poolId) },
          );
        }

        // Ensure pool is initialized
        await this.initializePool(poolId, poolState.config, operationContext);

        if (!poolState.pool) {
          throw new McpError(
            JsonRpcErrorCode.InternalError,
            `Connection pool '${String(poolId)}' is not available`,
            { poolId: String(poolId) },
          );
        }

        // Additional check to ensure pool is properly initialized
        if (!poolState.isInitialized) {
          throw new McpError(
            JsonRpcErrorCode.InternalError,
            `Connection pool '${String(poolId)}' is not fully initialized`,
            {
              poolId: String(poolId),
              isInitialized: poolState.isInitialized,
              isConnecting: poolState.isConnecting,
            },
          );
        }

        logger.debug(
          {
            ...operationContext,
            query: query,
            queryLength: query.length,
            hasParameters: !!params && params.length > 0,
            paramCount: params?.length || 0,
          },
          `Executing SQL query on pool: ${String(poolId)}`,
        );

        // Validate parameter types for mapepire compatibility
        if (params && params.length > 0) {
          for (let i = 0; i < params.length; i++) {
            const param = params[i];
            if (param !== null && param !== undefined) {
              const isValidType =
                typeof param === "string" ||
                typeof param === "number" ||
                (Array.isArray(param) &&
                  param.every(
                    (item) =>
                      typeof item === "string" || typeof item === "number",
                  ));
              if (!isValidType) {
                logger.warning(
                  {
                    ...operationContext,
                    paramIndex: i,
                    paramType: typeof param,
                    paramValue: param,
                  },
                  `Parameter ${i} has invalid type for mapepire binding`,
                );
              }
            }
          }
        }

        // Apply security validation if config is provided
        if (securityConfig) {
          SqlSecurityValidator.validateQuery(
            query,
            securityConfig,
            operationContext,
          );
        }

        const result = await poolState.pool.execute(query, {
          parameters: params,
        });

        logger.debug(
          {
            ...operationContext,
            rowCount: result.data?.length || 0,
            success: result.success,
            sqlReturnCode: result.sql_rc,
            executionTime: result.execution_time,
          },
          `Query executed successfully on pool: ${String(poolId)}`,
        );

        // Update health status on successful query
        poolState.healthStatus = "healthy";
        poolState.lastHealthCheck = new Date();

        return result as QueryResult<T>;
      },
      {
        operation: "ExecuteQuery",
        context: operationContext,
        errorCode: JsonRpcErrorCode.DatabaseError,
      },
    );
  }

  /**
   * Execute a SQL query with automatic pagination
   * @param poolId - Pool identifier
   * @param query - SQL query string
   * @param params - Query parameters
   * @param context - Request context for logging
   * @param fetchSize - Number of records per fetch
   */
  protected async executeQueryWithPagination(
    poolId: TId,
    query: string,
    params?: BindingValue[],
    context?: RequestContext,
    fetchSize: number = 300,
    securityConfig?: SqlToolSecurityConfig,
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
        poolId: String(poolId),
      });

    return ErrorHandler.tryCatch(
      async () => {
        const poolState = this.pools.get(poolId);
        if (!poolState) {
          throw new McpError(
            JsonRpcErrorCode.ConfigurationError,
            `Pool '${String(poolId)}' not found`,
            { poolId: String(poolId) },
          );
        }

        // Ensure pool is initialized
        await this.initializePool(poolId, poolState.config, operationContext);

        if (!poolState.pool) {
          throw new McpError(
            JsonRpcErrorCode.InternalError,
            "Connection pool is not available",
          );
        }

        // Apply security validation if config is provided
        if (securityConfig) {
          SqlSecurityValidator.validateQuery(
            query,
            securityConfig,
            operationContext,
          );
        }

        logger.debug(
          {
            ...operationContext,
            queryLength: query.length,
            hasParameters: !!params && params.length > 0,
            paramCount: params?.length || 0,
            fetchSize,
          },
          "Executing SQL query with pagination",
        );

        // Create query object with parameters
        const queryObj = poolState.pool.query(query, { parameters: params });

        // Execute initial query
        let result = await queryObj.execute();
        const allData: unknown[] = [];

        if (result.success && result.data) {
          allData.push(...result.data);
        }

        // Fetch more results until done
        let fetchCount = 1;
        while (!result.is_done && fetchCount < 100) {
          // Safety limit
          logger.debug(
            {
              ...operationContext,
              fetchCount,
              currentDataLength: allData.length,
            },
            "Fetching more results",
          );

          result = await queryObj.fetchMore(fetchSize);

          if (result.success && result.data) {
            allData.push(...result.data);
          }

          fetchCount++;
        }

        // Close the query
        await queryObj.close();

        logger.debug(
          {
            ...operationContext,
            totalRows: allData.length,
            fetchCount,
            success: result.success,
            sqlReturnCode: result.sql_rc,
            executionTime: result.execution_time,
          },
          "Paginated query completed",
        );

        return {
          data: allData,
          success: result.success,
          sql_rc: result.sql_rc,
          execution_time: result.execution_time,
        };
      },
      {
        operation: "ExecuteQueryWithPagination",
        context: operationContext,
        errorCode: JsonRpcErrorCode.DatabaseError,
      },
    );
  }

  /**
   * Check the health of a specific pool
   * @param poolId - Pool identifier
   * @param context - Request context for logging
   */
  async checkPoolHealth(
    poolId: TId,
    context?: RequestContext,
  ): Promise<PoolHealth> {
    const operationContext =
      context ||
      requestContextService.createRequestContext({
        operation: "CheckPoolHealth",
        poolId: String(poolId),
      });

    const poolState = this.pools.get(poolId);
    if (!poolState) {
      return {
        status: "unknown",
        initialized: false,
        connecting: false,
      };
    }

    try {
      if (!poolState.isInitialized || !poolState.pool) {
        return {
          status: "unknown",
          initialized: false,
          connecting: poolState.isConnecting,
        };
      }

      // Execute a simple query to test connection
      await this.executeQuery(
        poolId,
        "SELECT 1 FROM SYSIBM.SYSDUMMY1",
        [],
        operationContext,
      );

      poolState.healthStatus = "healthy";
      poolState.lastHealthCheck = new Date();

      logger.debug(
        operationContext,
        `Health check passed for pool: ${String(poolId)}`,
      );

      return {
        status: "healthy",
        lastCheck: poolState.lastHealthCheck,
        initialized: true,
        connecting: false,
      };
    } catch (error) {
      poolState.healthStatus = "unhealthy";
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      logger.error(
        {
          ...operationContext,
          error: errorMessage,
        },
        `Health check failed for pool: ${String(poolId)}`,
      );

      return {
        status: "unhealthy",
        lastError: errorMessage,
        lastCheck: new Date(),
        initialized: poolState.isInitialized,
        connecting: poolState.isConnecting,
      };
    }
  }

  /**
   * Close a specific pool's connections
   * @param poolId - Pool identifier
   * @param context - Request context for logging
   */
  async closePool(poolId: TId, context?: RequestContext): Promise<void> {
    const operationContext =
      context ||
      requestContextService.createRequestContext({
        operation: "ClosePool",
        poolId: String(poolId),
      });

    const poolState = this.pools.get(poolId);
    if (!poolState || !poolState.pool) {
      return;
    }

    try {
      logger.info(
        operationContext,
        `Closing connection pool: ${String(poolId)}`,
      );

      await poolState.pool.end();
      poolState.pool = null;
      poolState.isInitialized = false;
      poolState.healthStatus = "unknown";

      logger.info(
        operationContext,
        `Connection pool closed successfully: ${String(poolId)}`,
      );
    } catch (error) {
      logger.error(
        {
          ...operationContext,
          error: error instanceof Error ? error.message : String(error),
        },
        `Error closing connection pool: ${String(poolId)}`,
      );
    }
  }

  /**
   * Close all connection pools gracefully

  /**
   * Close all connection pools gracefully
   * @param context - Request context for logging
   */
  async closeAllPools(context?: RequestContext): Promise<void> {
    const operationContext =
      context ||
      requestContextService.createRequestContext({
        operation: "CloseAllPools",
      });

    const closePromises = Array.from(this.pools.keys()).map((poolId) =>
      this.closePool(poolId, operationContext),
    );

    const results = await Promise.allSettled(closePromises);

    logger.info(
      {
        ...operationContext,
        closedCount: results.length,
      },
      "All connection pools closed",
    );
  }

  /**
   * Get status of a specific pool
   * @param poolId - Pool identifier
   */
  getPoolStatus(poolId: TId): {
    initialized: boolean;
    connecting: boolean;
    healthStatus: string;
  } | null {
    const poolState = this.pools.get(poolId);
    if (!poolState) {
      return null;
    }

    return {
      initialized: poolState.isInitialized,
      connecting: poolState.isConnecting,
      healthStatus: poolState.healthStatus,
    };
  }

  /**
   * Get list of registered pool identifiers
   */
  getRegisteredPools(): TId[] {
    return Array.from(this.pools.keys());
  }

  /**
   * Clear all pools (for testing)
   */
  protected clearAllPools(): void {
    this.pools.clear();
    this.initializationPromises.clear();
  }
}

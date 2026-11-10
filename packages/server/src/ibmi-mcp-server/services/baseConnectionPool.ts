/**
 * @fileoverview Base connection pool abstraction for IBM i connections
 * Provides shared connection pool logic that can be extended by specific implementations
 *
 * @module src/services/baseConnectionPool
 */

import pkg, {
  BindingValue,
  QueryResult,
  DaemonServer,
  QueryMetaData,
} from "@ibm/mapepire-js";
import type { JDBCOptions } from "@ibm/mapepire-js";
const { Pool, getRootCertificate } = pkg;
import { ErrorHandler, logger } from "@/utils/internal/index.js";
import {
  requestContextService,
  RequestContext,
} from "@/utils/internal/requestContext.js";
import { JsonRpcErrorCode, McpError } from "@/types-global/errors.js";
import { SqlToolSecurityConfig } from "@/ibmi-mcp-server/schemas/index.js";
import { DEFAULT_MAPEPIRE_PORT } from "@/ibmi-mcp-server/schemas/common.js";
import { SqlSecurityValidator } from "../utils/security/sqlSecurityValidator.js";
import {
  config,
  DEFAULT_PAGE_SIZE,
  MAX_PAGINATION_ROWS,
} from "@/config/index.js";

/**
 * Pool health status values used across pool interfaces and return types
 */
export type PoolHealthStatus = "healthy" | "unhealthy" | "unknown";

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
  jdbcOptions?: JDBCOptions;
}

/**
 * Pool instance state
 */
export interface PoolInstanceState {
  pool: InstanceType<typeof Pool> | null;
  isInitialized: boolean;
  isConnecting: boolean;
  lastHealthCheck?: Date;
  healthStatus: PoolHealthStatus;
  config: PoolConnectionConfig;
  lastActivityAt: Date;
}

/**
 * Health status information
 */
export interface PoolHealth {
  status: PoolHealthStatus;
  lastCheck?: Date;
  lastError?: string;
  initialized: boolean;
  connecting: boolean;
  lastActivity?: Date;
}

/**
 * Base connection pool manager that provides shared functionality
 * for all IBM i connection pools in the application
 */
export abstract class BaseConnectionPool<TId extends string | symbol = string> {
  protected pools: Map<TId, PoolInstanceState> = new Map();
  protected initializationPromises: Map<TId, Promise<void>> = new Map();
  private idleCheckInterval: NodeJS.Timeout | null = null;

  /** Registry of all BaseConnectionPool instances for coordinated shutdown */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private static readonly instances = new Set<BaseConnectionPool<any>>();

  constructor() {
    BaseConnectionPool.instances.add(this);
  }

  /**
   * Label for a pool id in log messages and errors. Subclasses whose pool ids
   * are secrets (e.g. bearer tokens) must override this so the raw id is never
   * written to logs or returned to clients.
   * @param poolId - Pool identifier
   */
  protected describePool(poolId: TId): string {
    return String(poolId);
  }

  /**
   * mapepire-js keeps every Query it creates in a static list and only prunes
   * it when Query.cleanup() is called, which the library never does itself.
   * Call it after closing a query so a long-running server does not retain
   * every statement (SQL text, parameters, job) it has ever executed.
   * @param queryObj - A query that has just been closed
   */
  private pruneClosedQueries(queryObj: object): void {
    // The Query class is not exported by mapepire-js; reach it via the instance.
    const queryClass = queryObj.constructor as {
      cleanup?: () => Promise<void>;
    };
    // Not awaited: cleanup also closes other finished queries, and that must
    // not hold up this request.
    queryClass.cleanup?.().catch(() => {
      // best-effort
    });
  }

  /**
   * Create a daemon server configuration from connection config
   * @param config - Connection configuration
   * @param context - Request context for logging
   */
  protected async createDaemonServer(
    poolConfig: PoolConnectionConfig,
    context: RequestContext,
  ): Promise<DaemonServer> {
    const server: DaemonServer = {
      host: poolConfig.host,
      port: poolConfig.port,
      user: poolConfig.user,
      password: poolConfig.password,
      rejectUnauthorized: !(poolConfig.ignoreUnauthorized ?? true),
    };

    // Get SSL certificate if needed
    if (!(poolConfig.ignoreUnauthorized ?? true)) {
      logger.debug(context, "Fetching SSL certificate for secure connection");
      server.ca = await getRootCertificate(server);
    }

    return server;
  }

  /**
   * Initialize a connection pool for the given identifier
   * @param poolId - Unique identifier for the pool
   * @param poolConfig - Connection configuration
   * @param context - Request context for logging
   */
  protected async initializePool(
    poolId: TId,
    poolConfig: PoolConnectionConfig,
    context: RequestContext,
  ): Promise<void> {
    // Check if there's already an initialization in progress
    const existingPromise = this.initializationPromises.get(poolId);
    if (existingPromise) {
      logger.debug(
        context,
        `Waiting for existing initialization of pool: ${this.describePool(poolId)}`,
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
        config: poolConfig,
        lastActivityAt: new Date(),
      };
      this.pools.set(poolId, poolState);
    }

    // Check if already initialized
    if (poolState.isInitialized && poolState.pool) {
      logger.debug(
        context,
        `Pool '${this.describePool(poolId)}' already initialized`,
      );
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
        `Pool '${this.describePool(poolId)}' is already connecting, waiting...`,
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
          port: poolState.config.port ?? DEFAULT_MAPEPIRE_PORT,
          user: poolState.config.user.substring(0, 3) + "***",
          ignoreUnauthorized: poolState.config.ignoreUnauthorized ?? true,
          // Intentionally logging only `libraries`: other JDBCOptions fields
          // (e.g., "key ring password", "proxy server") may contain sensitive
          // values. Revisit if we add structured redaction for the full
          // jdbcOptions object.
          ...(poolState.config.jdbcOptions?.libraries?.length
            ? { libraries: poolState.config.jdbcOptions.libraries }
            : {}),
        },
        `Initializing connection pool: ${this.describePool(poolId)}`,
      );

      // Create daemon server configuration
      const server = await this.createDaemonServer(poolState.config, context);

      // Create and initialize connection pool
      poolState.pool = new Pool({
        creds: server,
        maxSize: poolState.config.maxSize || 10,
        startingSize: poolState.config.startingSize || 2,
        ...(poolState.config.jdbcOptions &&
        Object.keys(poolState.config.jdbcOptions).length > 0
          ? { opts: poolState.config.jdbcOptions }
          : {}),
      });

      await poolState.pool.init();
      poolState.isInitialized = true;
      poolState.healthStatus = "healthy";
      poolState.lastHealthCheck = new Date();
      poolState.lastActivityAt = new Date();

      // Start idle timer (idempotent — safe to call on every init)
      this.startIdleTimer();

      logger.info(
        context,
        `Connection pool initialized successfully: ${this.describePool(poolId)}`,
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
   * Wrap a promise with a configurable timeout.
   * On timeout: marks pool unhealthy, closes it async so next request re-inits.
   * If queryTimeoutMs <= 0, passes through without timeout (disabled).
   */
  private async executeWithTimeout<T>(
    poolId: TId,
    promise: Promise<T>,
    context: RequestContext,
  ): Promise<T> {
    const timeoutMs = config.poolTimeouts.queryTimeoutMs;
    if (timeoutMs <= 0) {
      return promise;
    }

    let timer!: NodeJS.Timeout;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new McpError(
            JsonRpcErrorCode.Timeout,
            `Query timed out after ${timeoutMs}ms on pool '${this.describePool(poolId)}'. The connection may be stale. Pool will be re-initialized on the next request.`,
            { poolId: this.describePool(poolId), timeoutMs },
          ),
        );
      }, timeoutMs);
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } catch (error) {
      // If it's our timeout error, mark pool unhealthy and close it
      if (error instanceof McpError && error.code === JsonRpcErrorCode.Timeout) {
        const poolState = this.pools.get(poolId);
        if (poolState) {
          poolState.healthStatus = "unhealthy";
        }
        logger.error(
          { ...context, timeoutMs, poolId: this.describePool(poolId) },
          `Query timed out on pool '${this.describePool(poolId)}'. Closing pool for re-initialization.`,
        );
        // Close pool async — don't await, let it clean up in background
        this.closePool(poolId, context).catch(() => {
          // best-effort
        });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Start the idle pool check timer. Idempotent — safe to call multiple times.
   * Uses interval of max(10s, timeout/2) following existing StatefulTransportManager pattern.
   * If idleTimeoutMs <= 0, this is a no-op (disabled).
   */
  protected startIdleTimer(): void {
    const idleTimeoutMs = config.poolTimeouts.idleTimeoutMs;
    if (idleTimeoutMs <= 0 || this.idleCheckInterval) {
      return;
    }

    const checkIntervalMs = Math.max(10_000, Math.floor(idleTimeoutMs / 2));

    this.idleCheckInterval = setInterval(() => {
      this.closeIdlePools();
    }, checkIntervalMs);

    // Don't let the timer prevent process exit
    this.idleCheckInterval.unref();

    logger.info(
      requestContextService.createRequestContext({
        operation: "StartIdleTimer",
      }),
      `Pool idle timer started: checking every ${checkIntervalMs}ms, closing pools idle for ${idleTimeoutMs}ms`,
    );
  }

  /**
   * Stop the idle pool check timer. Called during shutdown.
   */
  public stopIdleTimer(): void {
    if (this.idleCheckInterval) {
      clearInterval(this.idleCheckInterval);
      this.idleCheckInterval = null;
      logger.debug(
        requestContextService.createRequestContext({
          operation: "StopIdleTimer",
        }),
        "Pool idle timer stopped",
      );
    }
  }

  /**
   * Close pools that have been idle longer than the configured timeout.
   * The existing lazy-init path in executeQuery() will re-initialize on next use.
   */
  private closeIdlePools(): void {
    const idleTimeoutMs = config.poolTimeouts.idleTimeoutMs;
    if (idleTimeoutMs <= 0) {
      return;
    }

    const now = Date.now();
    let context: RequestContext | undefined;

    for (const [poolId, poolState] of this.pools.entries()) {
      if (!poolState.isInitialized || !poolState.pool) {
        continue;
      }

      const idleDuration = now - poolState.lastActivityAt.getTime();
      if (idleDuration > idleTimeoutMs) {
        context ??= requestContextService.createRequestContext({
          operation: "CloseIdlePools",
        });
        logger.info(
          {
            ...context,
            poolId: this.describePool(poolId),
            idleDurationMs: idleDuration,
            idleTimeoutMs,
          },
          `Closing idle pool '${this.describePool(poolId)}' (idle for ${Math.round(idleDuration / 1000)}s)`,
        );
        // Close async — don't block the interval
        this.closePool(poolId, context).catch(() => {
          // best-effort
        });
      }
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
    rowsToFetch?: number,
  ): Promise<QueryResult<T>> {
    const operationContext =
      context ||
      requestContextService.createRequestContext({
        operation: "ExecuteQuery",
        poolId: this.describePool(poolId),
      });

    return ErrorHandler.tryCatch(
      async () => {
        const poolState = this.pools.get(poolId);
        if (!poolState) {
          throw new McpError(
            JsonRpcErrorCode.ConfigurationError,
            `Pool '${this.describePool(poolId)}' not found. Please register the pool first.`,
            { poolId: this.describePool(poolId) },
          );
        }

        // Ensure pool is initialized
        await this.initializePool(poolId, poolState.config, operationContext);

        if (!poolState.pool) {
          throw new McpError(
            JsonRpcErrorCode.InternalError,
            `Connection pool '${this.describePool(poolId)}' is not available`,
            { poolId: this.describePool(poolId) },
          );
        }

        // Additional check to ensure pool is properly initialized
        if (!poolState.isInitialized) {
          throw new McpError(
            JsonRpcErrorCode.InternalError,
            `Connection pool '${this.describePool(poolId)}' is not fully initialized`,
            {
              poolId: this.describePool(poolId),
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
            rowsToFetch,
          },
          `Executing SQL query on pool: ${this.describePool(poolId)}`,
        );

        if (rowsToFetch !== undefined && rowsToFetch > 10_000) {
          logger.warning(
            {
              ...operationContext,
              rowsToFetch,
            },
            `Large rowsToFetch requested (${rowsToFetch}). Large result sets can bloat LLM context and consume memory. Consider using pagination via SQL OFFSET/FETCH FIRST instead.`,
          );
        }

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

        // Use pool.query().execute(rowsToFetch) so per-call row limits are honored.
        // mapepire's pool.execute() QueryOptions doesn't accept rowsToFetch; the
        // Query.execute(n) path does. close() releases the job back to the pool.
        const queryObj = poolState.pool.query(query, {
          parameters: params,
        });
        const executionPromise = (
          rowsToFetch !== undefined
            ? queryObj.execute(rowsToFetch)
            : queryObj.execute()
        ) as Promise<QueryResult<T>>;
        let result: QueryResult<T>;
        try {
          result = await this.executeWithTimeout<QueryResult<T>>(
            poolId,
            executionPromise,
            operationContext,
          );
        } finally {
          await queryObj.close().catch((closeErr: unknown) => {
            logger.warning(
              {
                ...operationContext,
                error:
                  closeErr instanceof Error
                    ? closeErr.message
                    : String(closeErr),
              },
              "Failed to close query object after execution",
            );
          });
          this.pruneClosedQueries(queryObj);
        }

        logger.debug(
          {
            ...operationContext,
            rowCount: result.data?.length || 0,
            success: result.success,
            sqlReturnCode: result.sql_rc,
            executionTime: result.execution_time,
          },
          `Query executed successfully on pool: ${this.describePool(poolId)}`,
        );

        // Update health status and activity timestamp on successful query
        poolState.healthStatus = "healthy";
        poolState.lastHealthCheck = new Date();
        poolState.lastActivityAt = new Date();

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
    fetchSize: number = DEFAULT_PAGE_SIZE,
    securityConfig?: SqlToolSecurityConfig,
  ): Promise<{
    data: unknown[];
    success: boolean;
    sql_rc?: unknown;
    execution_time?: number;
    metadata?: QueryMetaData;
    truncated: boolean;
  }> {
    const operationContext =
      context ||
      requestContextService.createRequestContext({
        operation: "ExecuteQueryWithPagination",
        poolId: this.describePool(poolId),
      });

    return ErrorHandler.tryCatch(
      async () => {
        const poolState = this.pools.get(poolId);
        if (!poolState) {
          throw new McpError(
            JsonRpcErrorCode.ConfigurationError,
            `Pool '${this.describePool(poolId)}' not found`,
            { poolId: this.describePool(poolId) },
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

        const allData: unknown[] = [];
        let fetchCount = 1;
        let result: QueryResult<unknown>;
        let initialMetadata: QueryMetaData | undefined;
        try {
          // Execute initial query — wrap with timeout to catch stale connections
          result = await this.executeWithTimeout(
            poolId,
            queryObj.execute(),
            operationContext,
          );
          // Capture metadata from the first result — subsequent fetchMore calls
          // don't re-send column descriptors, so SQL tools need this snapshot.
          initialMetadata = result.metadata;

          if (result.success && result.data) {
            allData.push(...result.data);
          }

          // Fetch more results until done or safety cap reached. The cap is
          // row-based so the effective ceiling is stable regardless of
          // per-fetch page size — see MAX_PAGINATION_ROWS.
          while (!result.is_done && allData.length < MAX_PAGINATION_ROWS) {
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
        } finally {
          // Close the query even when a fetch fails, so its cursor is released
          await queryObj.close().catch((closeErr: unknown) => {
            logger.warning(
              {
                ...operationContext,
                error:
                  closeErr instanceof Error
                    ? closeErr.message
                    : String(closeErr),
              },
              "Failed to close query object after paginated execution",
            );
          });
          this.pruneClosedQueries(queryObj);
        }

        // Truncate to MAX_PAGINATION_ROWS exactly when the final page
        // overshoots the cap. Callers should not see more rows than promised.
        // A result that ends exactly at the cap (is_done) is complete, not
        // truncated.
        const truncated =
          !result.is_done || allData.length > MAX_PAGINATION_ROWS;
        if (allData.length > MAX_PAGINATION_ROWS) {
          allData.length = MAX_PAGINATION_ROWS;
        }

        if (truncated) {
          logger.warning(
            {
              ...operationContext,
              totalRows: allData.length,
              cap: MAX_PAGINATION_ROWS,
              fetchCount,
              fetchSize,
            },
            "Paginated query hit row cap — result is truncated. Raise IBMI_PAGINATION_MAX_ROWS or narrow the query.",
          );
        }

        logger.debug(
          {
            ...operationContext,
            totalRows: allData.length,
            fetchCount,
            truncated,
            success: result.success,
            sqlReturnCode: result.sql_rc,
            executionTime: result.execution_time,
          },
          "Paginated query completed",
        );

        // Update health status and activity timestamp on successful paginated query
        poolState.healthStatus = "healthy";
        poolState.lastHealthCheck = new Date();
        poolState.lastActivityAt = new Date();

        return {
          data: allData,
          success: result.success,
          sql_rc: result.sql_rc,
          execution_time: result.execution_time,
          metadata: initialMetadata,
          truncated,
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
        poolId: this.describePool(poolId),
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
          lastActivity: poolState.lastActivityAt,
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
        `Health check passed for pool: ${this.describePool(poolId)}`,
      );

      return {
        status: "healthy",
        lastCheck: poolState.lastHealthCheck,
        initialized: true,
        connecting: false,
        lastActivity: poolState.lastActivityAt,
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
        `Health check failed for pool: ${this.describePool(poolId)}`,
      );

      return {
        status: "unhealthy",
        lastError: errorMessage,
        lastCheck: new Date(),
        initialized: poolState.isInitialized,
        connecting: poolState.isConnecting,
        lastActivity: poolState.lastActivityAt,
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
        poolId: this.describePool(poolId),
      });

    const poolState = this.pools.get(poolId);
    if (!poolState || !poolState.pool) {
      return;
    }

    try {
      logger.info(
        operationContext,
        `Closing connection pool: ${this.describePool(poolId)}`,
      );

      await poolState.pool.end();
      poolState.pool = null;
      poolState.isInitialized = false;
      poolState.healthStatus = "unknown";

      logger.info(
        operationContext,
        `Connection pool closed successfully: ${this.describePool(poolId)}`,
      );
    } catch (error) {
      logger.error(
        {
          ...operationContext,
          error: error instanceof Error ? error.message : String(error),
        },
        `Error closing connection pool: ${this.describePool(poolId)}`,
      );
    }
  }

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
   * Graceful shutdown for this pool instance.
   * Stops the idle timer and closes all connections.
   * Subclasses may override to clean up additional state.
   * @param context - Request context for logging
   */
  async shutdown(context?: RequestContext): Promise<void> {
    this.stopIdleTimer();
    await this.closeAllPools(context);
  }

  /**
   * Shut down all registered BaseConnectionPool instances.
   * Each instance's shutdown() is called via Promise.allSettled
   * so one failure does not prevent others from closing.
   * @param context - Request context for logging
   */
  static async shutdownAll(context?: RequestContext): Promise<void> {
    const operationContext =
      context ||
      requestContextService.createRequestContext({
        operation: "ShutdownAllPools",
      });

    const instances = Array.from(BaseConnectionPool.instances);
    if (instances.length === 0) {
      return;
    }

    logger.info(
      { ...operationContext, poolCount: instances.length },
      `Shutting down ${instances.length} connection pool(s)`,
    );

    const results = await Promise.allSettled(
      instances.map((instance) => instance.shutdown(operationContext)),
    );

    for (const result of results) {
      if (result.status === "rejected") {
        logger.error(
          {
            ...operationContext,
            error:
              result.reason instanceof Error
                ? result.reason.message
                : String(result.reason),
          },
          "Error during pool instance shutdown",
        );
      }
    }

    BaseConnectionPool.instances.clear();
  }

  /**
   * Get status of a specific pool
   * @param poolId - Pool identifier
   */
  getPoolStatus(poolId: TId): {
    initialized: boolean;
    connecting: boolean;
    healthStatus: PoolHealthStatus;
    lastActivityAt?: Date;
  } | null {
    const poolState = this.pools.get(poolId);
    if (!poolState) {
      return null;
    }

    return {
      initialized: poolState.isInitialized,
      connecting: poolState.isConnecting,
      healthStatus: poolState.healthStatus,
      lastActivityAt: poolState.lastActivityAt,
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
    this.stopIdleTimer();
    this.pools.clear();
    this.initializationPromises.clear();
    BaseConnectionPool.instances.delete(this);
  }
}

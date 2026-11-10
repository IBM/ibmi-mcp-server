/**
 * @fileoverview Base connection pool abstraction for IBM i connections
 * Provides shared connection pool logic that can be extended by specific implementations
 *
 * @module src/services/baseConnectionPool
 */

import { createHash } from "crypto";
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

type MapepirePool = InstanceType<typeof Pool>;
type MapepireJob = ReturnType<MapepirePool["getJob"]>;
type MapepireQuery = ReturnType<MapepireJob["query"]>;

/**
 * A pool's connections. mapepire keeps them private, and its own way of
 * picking one (Pool.query, Pool.getJob) opens a further connection in the
 * background when all are busy: a sign-on nobody waits for, so a rejected one
 * is an unhandled promise rejection and is not held back by the sign-on
 * cool-down. The pool picks and adds connections itself (see takeJob).
 */
const jobsOf = (pool: MapepirePool): MapepireJob[] =>
  (pool as unknown as { jobs: MapepireJob[] }).jobs;

/** "ready", "busy", "connecting" or "ended" (JobStatus is a type-only import) */
const statusOf = (job: MapepireJob): string => job.getStatus();

/**
 * How long a rejected sign-on is remembered. IBM i disables a user profile
 * after a few bad sign-ons, so the same credentials are not tried again until
 * this has passed.
 */
const SIGN_ON_COOL_DOWN_MS = 60_000;

/** How long any other initialization failure (network, TLS) is remembered. */
const INIT_COOL_DOWN_MS = 5_000;

/** How Mapepire (JTOpen underneath) words a rejected sign-on. */
const SIGN_ON_REJECTED =
  /rejected the connection|password is (incorrect|expired)|user id is (not known|disabled)|unexpected server response: 40[13]/i;

/** A failed pool initialization that must not be repeated yet */
interface InitFailure {
  retryAt: number;
  signOnRejected: boolean;
  message: string;
  cause: unknown;
}

/** One request's use of a pool: the statement it runs and how to cancel it */
interface PoolLease {
  state: PoolInstanceState;
  pool: MapepirePool;
  /** The connection the statement runs on */
  job: MapepireJob;
  query: MapepireQuery;
  /** Rejects when the request times out or its pool is closed under it */
  cancelled: Promise<never>;
  cancel: (reason: McpError) => void;
}

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
  pool: MapepirePool | null;
  isInitialized: boolean;
  isConnecting: boolean;
  healthStatus: PoolHealthStatus;
  config: PoolConnectionConfig;
  lastActivityAt: Date;
  /** Cancels each request currently running on `pool` */
  inFlight: Set<(reason: McpError) => void>;
  /** The initialization in progress, shared by the requests waiting for it */
  initializing?: Promise<void>;
  /** The pool was closed while it was connecting: release it once connected */
  closedWhileConnecting?: boolean;
}

/**
 * Base connection pool manager that provides shared functionality
 * for all IBM i connection pools in the application
 */
export abstract class BaseConnectionPool<TId extends string | symbol = string> {
  protected pools: Map<TId, PoolInstanceState> = new Map();
  private idleCheckInterval: NodeJS.Timeout | null = null;

  /** Registry of all BaseConnectionPool instances for coordinated shutdown */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private static readonly instances = new Set<BaseConnectionPool<any>>();

  /**
   * Recent initialization failures, keyed by the sign-on they attempted (see
   * signOnKey). Shared by every pool manager: the user profile they would
   * disable is the same one.
   */
  private static readonly initFailures = new Map<string, InitFailure>();

  /**
   * Sign-ons in progress, by signOnKey: one at a time per set of credentials,
   * whichever pool makes it, so that a rejection is remembered before the
   * next pool or connection tries them. These promises never reject.
   */
  private static readonly signOns = new Map<string, Promise<void>>();

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
   * Identifies the sign-on a pool configuration performs, so a failure is
   * remembered for those credentials whichever pool tries them next. Host and
   * user profile names are not case-sensitive on IBM i. Hashed so the password
   * is not kept as a map key.
   */
  private static signOnKey(poolConfig: PoolConnectionConfig): string {
    return createHash("sha256")
      .update(
        JSON.stringify([
          poolConfig.host.toLowerCase(),
          poolConfig.port ?? DEFAULT_MAPEPIRE_PORT,
          poolConfig.user.toUpperCase(),
          poolConfig.password,
        ]),
      )
      .digest("hex");
  }

  /** Remember a failed sign-on or connection attempt for its cool-down */
  private static rememberInitFailure(
    signOnKey: string,
    error: unknown,
  ): InitFailure {
    const message = error instanceof Error ? error.message : String(error);
    const signOnRejected = SIGN_ON_REJECTED.test(message);
    const now = Date.now();
    const failure: InitFailure = {
      retryAt:
        now + (signOnRejected ? SIGN_ON_COOL_DOWN_MS : INIT_COOL_DOWN_MS),
      signOnRejected,
      message,
      cause: error,
    };
    for (const [key, past] of BaseConnectionPool.initFailures) {
      if (past.retryAt <= now) {
        BaseConnectionPool.initFailures.delete(key);
      }
    }
    BaseConnectionPool.initFailures.set(signOnKey, failure);
    return failure;
  }

  /** The failure with these credentials whose cool-down has not passed yet */
  private static recentInitFailure(signOnKey: string): InitFailure | undefined {
    const failure = BaseConnectionPool.initFailures.get(signOnKey);
    return failure && Date.now() < failure.retryAt ? failure : undefined;
  }

  /**
   * The error reported while an initialization failure is being remembered.
   * A rejected sign-on is described without the server's own text, which
   * names the user profile.
   */
  private initFailureError(poolId: TId, failure: InitFailure): McpError {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((failure.retryAt - Date.now()) / 1000),
    );
    const details = { poolId: this.describePool(poolId), retryAfterSeconds };
    if (failure.signOnRejected) {
      return new McpError(
        JsonRpcErrorCode.InitializationFailed,
        `IBM i sign-on failed: the system rejected the user or password. No new sign-on is attempted for ${retryAfterSeconds} s, so that repeated failures do not disable the user profile. Correct the credentials and retry after that.`,
        details,
      );
    }
    return new McpError(
      JsonRpcErrorCode.InitializationFailed,
      `Connection pool '${this.describePool(poolId)}' could not be initialized: ${failure.message}. Retry in ${retryAfterSeconds} s.`,
      details,
      { cause: failure.cause },
    );
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
    let poolState = this.pools.get(poolId);
    if (!poolState) {
      poolState = {
        pool: null,
        isInitialized: false,
        isConnecting: false,
        healthStatus: "unknown",
        config: poolConfig,
        lastActivityAt: new Date(),
        inFlight: new Set(),
      };
      this.pools.set(poolId, poolState);
    }
    const state = poolState;
    const signOnKey = BaseConnectionPool.signOnKey(state.config);

    for (;;) {
      if (state.initializing) {
        logger.debug(
          context,
          `Waiting for existing initialization of pool: ${this.describePool(poolId)}`,
        );
        return state.initializing;
      }
      if (state.isInitialized && state.pool) {
        logger.debug(
          context,
          `Pool '${this.describePool(poolId)}' already initialized`,
        );
        return;
      }
      // Wait for a sign-on another pool is making with the same credentials,
      // then look again: if it was rejected, this pool must not repeat it.
      const signOn = BaseConnectionPool.signOns.get(signOnKey);
      if (!signOn) {
        break;
      }
      await signOn;
    }

    // Fail fast while a recent failure with these credentials is remembered
    const failure = BaseConnectionPool.recentInitFailure(signOnKey);
    if (failure) {
      throw this.initFailureError(poolId, failure);
    }

    const initializing = this.performInitialization(
      poolId,
      state,
      context,
    ).finally(() => {
      state.initializing = undefined;
      BaseConnectionPool.signOns.delete(signOnKey);
    });
    state.initializing = initializing;
    BaseConnectionPool.signOns.set(
      signOnKey,
      initializing.catch(() => {
        // reported to the requests waiting on `initializing`
      }),
    );
    return initializing;
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
    poolState.isConnecting = true;
    poolState.closedWhileConnecting = false;
    let pool: MapepirePool | undefined;

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

      const maxSize = poolState.config.maxSize || 10;
      const startingSize = poolState.config.startingSize || 2;
      if (startingSize > maxSize) {
        throw new Error(
          "Max size must be greater than or equal to starting size",
        );
      }

      // Create daemon server configuration
      const server = await this.createDaemonServer(poolState.config, context);

      // Pool.init() opens `startingSize` connections in parallel, and each one
      // is a sign-on. Open a single probe connection first, so that rejected
      // credentials cost one sign-on attempt, then open the rest: init() reads
      // the size from this options object every time it is called.
      const poolOptions = {
        creds: server,
        maxSize,
        startingSize: 1,
        ...(poolState.config.jdbcOptions &&
        Object.keys(poolState.config.jdbcOptions).length > 0
          ? { opts: poolState.config.jdbcOptions }
          : {}),
      };
      pool = new Pool(poolOptions);
      await pool.init();
      if (startingSize > 1) {
        poolOptions.startingSize = startingSize - 1;
        await pool.init();
      }
    } catch (error) {
      // Release any connection that did open before the failure
      try {
        pool?.end();
      } catch {
        // the initialization failure is the error to report
      }
      poolState.isInitialized = false;
      poolState.healthStatus = "unhealthy";
      poolState.pool = null;

      const failure = BaseConnectionPool.rememberInitFailure(
        BaseConnectionPool.signOnKey(poolState.config),
        error,
      );

      logger.error(
        {
          ...context,
          poolId: this.describePool(poolId),
          error: failure.message,
          signOnRejected: failure.signOnRejected,
        },
        `Failed to initialize connection pool: ${this.describePool(poolId)}`,
      );

      throw this.initFailureError(poolId, failure);
    } finally {
      poolState.isConnecting = false;
    }

    // Closed (shutdown), or replaced by a changed source, while it was
    // connecting: nothing else would ever close these connections.
    if (
      poolState.closedWhileConnecting ||
      this.pools.get(poolId) !== poolState
    ) {
      poolState.closedWhileConnecting = false;
      pool.end();
      throw new McpError(
        JsonRpcErrorCode.ServiceUnavailable,
        `Connection pool '${this.describePool(poolId)}' was closed while it was connecting. Retry the request.`,
        { poolId: this.describePool(poolId) },
      );
    }

    poolState.pool = pool;
    poolState.isInitialized = true;
    poolState.healthStatus = "healthy";
    poolState.lastActivityAt = new Date();

    // Start idle timer (idempotent — safe to call on every init)
    this.startIdleTimer();

    logger.info(
      context,
      `Connection pool initialized successfully: ${this.describePool(poolId)}`,
    );
  }

  /**
   * Pick the connection a statement runs on: a ready one, else the busy one
   * with the fewest requests queued. When that one has more than two queued
   * and the pool is not full, one more connection is opened for the statements
   * that follow, as mapepire's own Pool.getJob() would (see jobsOf).
   * @returns undefined when the pool has no usable connection
   */
  private takeJob(
    poolId: TId,
    poolState: PoolInstanceState,
    pool: MapepirePool,
    context: RequestContext,
  ): MapepireJob | undefined {
    const jobs = jobsOf(pool);
    const ready = jobs.find((job) => statusOf(job) === "ready");
    if (ready) {
      return ready;
    }
    const [leastBusy] = jobs
      .filter((job) => statusOf(job) === "busy")
      .sort((a, b) => a.getRunningCount() - b.getRunningCount());
    if (leastBusy && leastBusy.getRunningCount() > 2 && pool.hasSpace()) {
      this.growPool(poolId, poolState, pool, context);
    }
    return leastBusy;
  }

  /**
   * Open one more connection for a pool that has none ready, without making
   * a request wait for it. It is a sign-on like the ones at initialization:
   * one at a time per set of credentials, none while a failure with them is
   * remembered, and a failure starts the same cool-down.
   */
  private growPool(
    poolId: TId,
    poolState: PoolInstanceState,
    pool: MapepirePool,
    context: RequestContext,
  ): void {
    const signOnKey = BaseConnectionPool.signOnKey(poolState.config);
    if (
      BaseConnectionPool.signOns.has(signOnKey) ||
      BaseConnectionPool.recentInitFailure(signOnKey)
    ) {
      return;
    }

    const signOn = pool
      .waitForJob()
      .then(
        (job) => {
          if (poolState.pool !== pool) {
            // The pool was closed meanwhile; Pool.end() missed this job
            void job.close();
          }
        },
        (error: unknown) => {
          const failure = BaseConnectionPool.rememberInitFailure(
            signOnKey,
            error,
          );
          // mapepire leaves the job that failed in the pool as "connecting",
          // where it would count against the pool's size for good. No other
          // job of this pool can be connecting: see the signOns check above.
          for (const job of jobsOf(pool)) {
            if (statusOf(job) === "connecting") {
              void job.close();
            }
          }
          logger.warning(
            {
              ...context,
              poolId: this.describePool(poolId),
              error: failure.message,
              signOnRejected: failure.signOnRejected,
            },
            `Could not add a connection to pool '${this.describePool(poolId)}'`,
          );
        },
      )
      .finally(() => {
        BaseConnectionPool.signOns.delete(signOnKey);
      });
    BaseConnectionPool.signOns.set(signOnKey, signOn);
  }

  /**
   * Start a statement on a pool on behalf of one request.
   *
   * Initializes the pool if needed. A pool whose every connection has dropped
   * (IPL, Mapepire restart, network reset) is replaced once before the
   * statement is started, and a second failure is reported as a connection
   * error.
   *
   * The request is registered as in flight until closeQuery() is called, so
   * that closing the pool rejects it and the idle timer leaves the pool alone.
   */
  private async openQuery(
    poolId: TId,
    sql: string,
    params: BindingValue[] | undefined,
    context: RequestContext,
  ): Promise<PoolLease> {
    for (let attempt = 1; ; attempt++) {
      const poolState = this.pools.get(poolId);
      if (!poolState) {
        throw new McpError(
          JsonRpcErrorCode.ConfigurationError,
          `Pool '${this.describePool(poolId)}' not found. Please register the pool first.`,
          { poolId: this.describePool(poolId) },
        );
      }

      await this.initializePool(poolId, poolState.config, context);

      const pool = poolState.pool;
      const job = pool && this.takeJob(poolId, poolState, pool, context);
      if (pool && job) {
        const query = job.query(sql, { parameters: params });
        let cancel!: (reason: McpError) => void;
        const cancelled = new Promise<never>((_, reject) => {
          cancel = reject;
        });
        cancelled.catch(() => {
          // observed through settle() only
        });
        poolState.inFlight.add(cancel);
        poolState.lastActivityAt = new Date();
        return { state: poolState, pool, job, query, cancelled, cancel };
      }

      if (pool) {
        logger.warning(
          { ...context, poolId: this.describePool(poolId), attempt },
          `Pool '${this.describePool(poolId)}' has no usable connection. Closing it for re-initialization.`,
        );
        this.endPool(poolId, poolState, "unhealthy", "its connections dropped");
      }

      if (attempt === 2) {
        throw new McpError(
          JsonRpcErrorCode.ServiceUnavailable,
          `Connection to IBM i was lost and could not be re-established on pool '${this.describePool(poolId)}'.`,
          { poolId: this.describePool(poolId) },
        );
      }
    }
  }

  /**
   * Await one Mapepire call on behalf of a request.
   *
   * mapepire never settles a call whose connection hangs or whose pool is
   * closed, so the call is raced against the request being cancelled, and a
   * timer cancels the request when the call exceeds the query timeout
   * (queryTimeoutMs <= 0 disables the timer). After a timeout the pool is
   * closed so the next request re-initializes it.
   */
  private async settle<T>(
    poolId: TId,
    lease: PoolLease,
    call: Promise<T>,
    context: RequestContext,
  ): Promise<T> {
    const timeoutMs = config.poolTimeouts.queryTimeoutMs;
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            lease.cancel(
              new McpError(
                JsonRpcErrorCode.Timeout,
                `Query timed out after ${timeoutMs}ms on pool '${this.describePool(poolId)}'. The connection may be stale. Pool will be re-initialized on the next request.`,
                { poolId: this.describePool(poolId), timeoutMs },
              ),
            );
            // Only the pool this request ran on: one re-created since then
            // belongs to other requests.
            if (lease.state.pool === lease.pool) {
              logger.error(
                { ...context, timeoutMs, poolId: this.describePool(poolId) },
                `Query timed out on pool '${this.describePool(poolId)}'. Closing pool for re-initialization.`,
              );
              this.endPool(
                poolId,
                lease.state,
                "unhealthy",
                "another statement on it timed out",
              );
            }
          }, timeoutMs)
        : undefined;

    try {
      return await Promise.race([call, lease.cancelled]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Finish a request started with openQuery(): close its query, drop the
   * query from mapepire's global list and take the request out of the pool's
   * in-flight set.
   */
  private async closeQuery(
    poolId: TId,
    lease: PoolLease,
    context: RequestContext,
  ): Promise<void> {
    if (statusOf(lease.job) === "ended") {
      // The connection is gone (dropped, or its pool was closed) and its
      // cursors with it. Query.close() is still called, because it is what
      // marks the query finished so that it is pruned below; but it sends the
      // close request on the dead socket, which is never answered and makes
      // the job look busy again. Closing the job once more undoes that.
      lease.query.close().catch(() => {
        // nothing to release
      });
      void lease.job.close();
    } else {
      try {
        // Query.close() marks the query finished before it sends anything,
        // so the query is pruned below even when the round trip that releases
        // its cursor is cut short (hung connection).
        await this.settle(poolId, lease, lease.query.close(), context);
      } catch (closeErr) {
        logger.warning(
          {
            ...context,
            error:
              closeErr instanceof Error ? closeErr.message : String(closeErr),
          },
          "Failed to close query object after execution",
        );
      }
    }
    this.pruneClosedQueries(lease.query);
    lease.state.inFlight.delete(lease.cancel);
    lease.state.lastActivityAt = new Date();
  }

  /**
   * Start the idle pool check timer. Idempotent — safe to call multiple times.
   * Uses interval of max(10s, timeout/2).
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
   * A pool with a request in flight is not idle, however long that request
   * has been running.
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
      if (
        !poolState.isInitialized ||
        !poolState.pool ||
        poolState.inFlight.size > 0
      ) {
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
        const lease = await this.openQuery(
          poolId,
          query,
          params,
          operationContext,
        );
        let result: QueryResult<T>;
        try {
          result = await this.settle(
            poolId,
            lease,
            (rowsToFetch !== undefined
              ? lease.query.execute(rowsToFetch)
              : lease.query.execute()) as Promise<QueryResult<T>>,
            operationContext,
          );
          lease.state.healthStatus = "healthy";
        } finally {
          await this.closeQuery(poolId, lease, operationContext);
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

        return result;
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

        const lease = await this.openQuery(
          poolId,
          query,
          params,
          operationContext,
        );

        const allData: unknown[] = [];
        let fetchCount = 1;
        let result: QueryResult<unknown>;
        let initialMetadata: QueryMetaData | undefined;
        try {
          result = await this.settle(
            poolId,
            lease,
            lease.query.execute(fetchSize),
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

            // A request sent on a connection that has dropped since the last
            // page is never answered.
            if (statusOf(lease.job) === "ended") {
              throw new McpError(
                JsonRpcErrorCode.ServiceUnavailable,
                `Connection to IBM i was lost while fetching results on pool '${this.describePool(poolId)}'.`,
                { poolId: this.describePool(poolId) },
              );
            }

            result = await this.settle(
              poolId,
              lease,
              lease.query.fetchMore(fetchSize),
              operationContext,
            );

            if (result.success && result.data) {
              allData.push(...result.data);
            }

            fetchCount++;
          }
          lease.state.healthStatus = "healthy";
        } finally {
          // Close the query even when a fetch fails, so its cursor is released
          await this.closeQuery(poolId, lease, operationContext);
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
   * End a pool's connections and reset its state so the next request
   * re-initializes it.
   *
   * mapepire's Pool.end() drops the response listeners of its jobs, so a
   * request still waiting on one of them would never settle: every request in
   * flight on the pool is rejected first.
   * @param healthStatus - Health to report until the pool is initialized again
   * @param reason - Why the pool is closing, for the requests it cancels
   */
  private endPool(
    poolId: TId,
    poolState: PoolInstanceState,
    healthStatus: PoolHealthStatus,
    reason: string,
  ): void {
    const pool = poolState.pool;
    if (!pool) {
      return;
    }

    poolState.pool = null;
    poolState.isInitialized = false;
    poolState.healthStatus = healthStatus;

    for (const cancel of poolState.inFlight) {
      cancel(
        new McpError(
          JsonRpcErrorCode.ServiceUnavailable,
          `Request cancelled: connection pool '${this.describePool(poolId)}' was closed while the statement was running (${reason}). The statement had already been sent to IBM i and may or may not have completed: check before running it again.`,
          { poolId: this.describePool(poolId) },
        ),
      );
    }
    poolState.inFlight.clear();

    try {
      pool.end();
    } catch (error) {
      logger.error(
        {
          poolId: this.describePool(poolId),
          error: error instanceof Error ? error.message : String(error),
        },
        `Error closing connection pool: ${this.describePool(poolId)}`,
      );
    }
  }

  /**
   * Close a specific pool's connections. Requests still running on the pool
   * are rejected.
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
    if (!poolState) {
      return;
    }
    if (!poolState.pool) {
      // Nothing to end yet; performInitialization() ends what it connects
      poolState.closedWhileConnecting = poolState.isConnecting;
      return;
    }

    logger.info(
      operationContext,
      `Closing connection pool: ${this.describePool(poolId)}`,
    );
    this.endPool(poolId, poolState, "unknown", "the pool was closed");
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

    BaseConnectionPool.initFailures.clear();
    BaseConnectionPool.signOns.clear();

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
}

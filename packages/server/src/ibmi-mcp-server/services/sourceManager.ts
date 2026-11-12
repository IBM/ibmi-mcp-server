/**
 * @fileoverview Multi-source connection manager for YAML-based tools
 * Manages multiple named IBM i connection pools based on YAML source configurations
 *
 * @module src/services/yaml-sources/sourceManager
 */

import { BindingValue, QueryResult } from "@ibm/mapepire-js";
import type { JDBCOptions } from "@ibm/mapepire-js";
import { config } from "@/config/index.js";
import {
  SourceConfig,
  SqlToolSecurityConfig,
  DEFAULT_MAPEPIRE_PORT,
} from "@/ibmi-mcp-server/schemas/index.js";
import { ErrorHandler, logger } from "@/utils/internal/index.js";
import {
  requestContextService,
  RequestContext,
} from "@/utils/internal/requestContext.js";
import { JsonRpcErrorCode, McpError } from "@/types-global/errors.js";
import {
  BaseConnectionPool,
  PoolConnectionConfig,
  PoolHealth,
  PoolHealthStatus,
} from "./baseConnectionPool.js";

/**
 * Source health information
 */
export interface SourceHealth extends PoolHealth {
  sourceName: string;
}

/**
 * Multi-source connection manager
 * Manages multiple named IBM i connection pools for YAML-based tools
 */
export class SourceManager extends BaseConnectionPool<string> {
  private static instance: SourceManager | undefined;
  private sourceConfigs: Map<string, SourceConfig> = new Map();

  /**
   * Get the singleton instance of the SourceManager
   */
  static getInstance(): SourceManager {
    if (!SourceManager.instance) {
      SourceManager.instance = new SourceManager();
    }
    return SourceManager.instance;
  }

  /**
   * Compare effective pool connection settings for YAML auto-reload reuse.
   * Returns true when an existing live pool can be kept.
   */
  private static poolConfigsEqual(
    a: PoolConnectionConfig,
    b: PoolConnectionConfig,
  ): boolean {
    if (
      a.host !== b.host ||
      a.user !== b.user ||
      a.password !== b.password ||
      (a.port ?? DEFAULT_MAPEPIRE_PORT) !== (b.port ?? DEFAULT_MAPEPIRE_PORT) ||
      (a.ignoreUnauthorized ?? true) !== (b.ignoreUnauthorized ?? true)
    ) {
      return false;
    }

    // JDBCOptions is a flat key/value bag; JSON equality is sufficient.
    return (
      JSON.stringify(a.jdbcOptions ?? null) ===
      JSON.stringify(b.jdbcOptions ?? null)
    );
  }

  /**
   * Register a new source configuration.
   * On re-registration (YAML auto-reload), keeps the existing pool when
   * connection settings are unchanged; otherwise closes the old pool first
   * so Mapepire jobs are not leaked.
   * @param sourceName - Name of the source
   * @param sourceConfig - Source configuration from YAML
   * @param context - Request context for logging
   */
  async registerSource(
    sourceName: string,
    sourceConfig: SourceConfig,
    context?: RequestContext,
  ): Promise<void> {
    const operationContext =
      context ||
      requestContextService.createRequestContext({
        operation: "RegisterSource",
        sourceName,
      });

    return ErrorHandler.tryCatch(
      async () => {
        logger.info(
          {
            ...operationContext,
            host: sourceConfig.host,
            port: sourceConfig.port ?? DEFAULT_MAPEPIRE_PORT,
            user: sourceConfig.user.substring(0, 3) + "***", // Mask username for security
          },
          `Registering source: ${sourceName}`,
        );

        // ENV overrides YAML: operators can enforce a fleet-wide JDBC config
        // without editing YAML files per deployment. Shallow merge is
        // sufficient — JDBCOptions is a flat object with no nested fields.
        //
        // `as JDBCOptions` cast: Zod's `.passthrough()` infers
        // `{ libraries?: string[] } & { [key: string]: unknown }`, which is
        // structurally compatible but not identical to the interface.
        const yamlJdbc = sourceConfig["jdbc-options"] as
          | JDBCOptions
          | undefined;
        const envJdbc = config.db2iJdbcOptions;
        const mergedJdbc: JDBCOptions | undefined =
          yamlJdbc || envJdbc
            ? { ...(yamlJdbc ?? {}), ...(envJdbc ?? {}) }
            : undefined;

        // With DB2i_TRANSPORT=ssh every YAML source is served over the shared
        // SSH credentials from the environment (the source's host/user/port
        // describe the Mapepire daemon and are not used).
        const sshCreds =
          config.db2iTransport === "ssh" ? config.db2iSsh : undefined;
        if (config.db2iTransport === "ssh" && !sshCreds) {
          throw new McpError(
            JsonRpcErrorCode.ConfigurationError,
            "DB2i_TRANSPORT=ssh but SSH configuration is incomplete. Set DB2i_HOST, DB2i_USER and DB2i_SSH_PRIVATE_KEY_PATH (or DB2i_PASS).",
            { sourceName },
          );
        }
        if (sshCreds) {
          logger.info(
            {
              ...operationContext,
              sourceName,
              sshHost: sshCreds.host,
              yamlHost: sourceConfig.host,
            },
            `Source '${sourceName}' will use the SSH transport (YAML host/port ignored)`,
          );
        }

        // Convert YAML source to pool connection config
        const poolConfig: PoolConnectionConfig = {
          host: sourceConfig.host,
          user: sourceConfig.user,
          password: sourceConfig.password,
          port: sourceConfig.port,
          ignoreUnauthorized: sourceConfig["ignore-unauthorized"],
          ...(mergedJdbc && Object.keys(mergedJdbc).length > 0
            ? { jdbcOptions: mergedJdbc }
            : {}),
          ...(sshCreds ? { ssh: sshCreds } : {}),
        };

        const existing = this.pools.get(sourceName);
        if (
          existing &&
          SourceManager.poolConfigsEqual(existing.config, poolConfig)
        ) {
          // Keep the live Mapepire pool; only refresh the YAML source snapshot.
          this.sourceConfigs.set(sourceName, sourceConfig);
          logger.info(
            operationContext,
            `Source unchanged, keeping existing pool: ${sourceName}`,
          );
          return;
        }

        if (existing) {
          logger.info(
            operationContext,
            `Source connection settings changed, closing existing pool: ${sourceName}`,
          );
          await this.closePool(sourceName, operationContext);
        }

        // Store the original source config for reference
        this.sourceConfigs.set(sourceName, sourceConfig);

        // Store the pool config for lazy initialization (don't initialize yet)
        this.pools.set(sourceName, {
          pool: null,
          isInitialized: false,
          isConnecting: false,
          healthStatus: "unknown",
          config: poolConfig,
          lastActivityAt: new Date(),
        });

        logger.info(
          operationContext,
          `Source registered successfully: ${sourceName}`,
        );
      },
      {
        operation: "RegisterSource",
        context: operationContext,
        errorCode: JsonRpcErrorCode.ConfigurationError,
      },
    );
  }

  /**
   * Execute a SQL query on a specific source
   * @param sourceName - Name of the source to query
   * @param query - SQL query string
   * @param params - Query parameters
   * @param context - Request context for logging
   */
  async executeQuery<T = unknown>(
    sourceName: string,
    query: string,
    params?: BindingValue[],
    context?: RequestContext,
    securityConfig?: SqlToolSecurityConfig,
    rowsToFetch?: number,
  ): Promise<QueryResult<T>> {
    return super.executeQuery<T>(
      sourceName,
      query,
      params,
      context,
      securityConfig,
      rowsToFetch,
    );
  }

  /**
   * Execute a SQL query with automatic pagination on a specific source
   * Fetches all available rows via repeated fetchMore calls (bounded by
   * the base pool's internal safety cap, ~30k rows).
   * @param sourceName - Name of the source to query
   * @param query - SQL query string
   * @param params - Query parameters
   * @param context - Request context for logging
   * @param securityConfig - Optional security configuration
   */
  async executeQueryWithPagination(
    sourceName: string,
    query: string,
    params?: BindingValue[],
    context?: RequestContext,
    fetchSize?: number,
    securityConfig?: SqlToolSecurityConfig,
  ) {
    return super.executeQueryWithPagination(
      sourceName,
      query,
      params,
      context,
      fetchSize,
      securityConfig,
    );
  }

  /**
   * Check the health of a specific source
   * @param sourceName - Name of the source to check
   * @param context - Request context for logging
   */
  async checkSourceHealth(
    sourceName: string,
    context?: RequestContext,
  ): Promise<SourceHealth> {
    const baseHealth = await super.checkPoolHealth(sourceName, context);
    return {
      sourceName,
      ...baseHealth,
    };
  }

  /**
   * Get health status for all registered sources
   * @param context - Request context for logging
   */
  async getAllSourcesHealth(context?: RequestContext): Promise<SourceHealth[]> {
    const operationContext =
      context ||
      requestContextService.createRequestContext({
        operation: "GetAllSourcesHealth",
      });

    const healthPromises = Array.from(this.getRegisteredPools()).map(
      (sourceName) => this.checkSourceHealth(sourceName, operationContext),
    );

    return Promise.all(healthPromises);
  }

  /**
   * Close a specific source's connection pool
   * @param sourceName - Name of the source to close
   * @param context - Request context for logging
   */
  async closeSource(
    sourceName: string,
    context?: RequestContext,
  ): Promise<void> {
    await super.closePool(sourceName, context);
    // Also clean up the source config
    this.sourceConfigs.delete(sourceName);
  }

  /**
   * Close all connection pools gracefully
   * @param context - Request context for logging
   */
  async closeAllSources(context?: RequestContext): Promise<void> {
    await super.closeAllPools(context);
    // Clean up all source configs
    this.sourceConfigs.clear();
  }

  /**
   * Graceful shutdown: close all pools and clear source configs.
   * @param context - Request context for logging
   */
  async shutdown(context?: RequestContext): Promise<void> {
    await super.shutdown(context);
    this.sourceConfigs.clear();
  }

  /**
   * Get list of registered source names
   */
  getRegisteredSources(): string[] {
    return this.getRegisteredPools();
  }

  /**
   * Get a lightweight health summary for all sources.
   * Reads cached pool state only — no SQL queries executed.
   * Suitable for health probe endpoints.
   */
  getHealthSummary(): Record<
    string,
    {
      initialized: boolean;
      connecting: boolean;
      healthStatus: PoolHealthStatus;
      lastActivityAt?: Date;
    }
  > {
    const summary: Record<
      string,
      {
        initialized: boolean;
        connecting: boolean;
        healthStatus: PoolHealthStatus;
        lastActivityAt?: Date;
      }
    > = {};

    for (const sourceName of this.getRegisteredPools()) {
      const poolStatus = this.getPoolStatus(sourceName);
      if (poolStatus) {
        summary[sourceName] = poolStatus;
      }
    }

    return summary;
  }

  /**
   * Clear all registered sources (for testing)
   */
  clearAllSources(): void {
    this.clearAllPools();
    this.sourceConfigs.clear();
  }
}

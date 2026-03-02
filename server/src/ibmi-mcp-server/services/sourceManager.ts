/**
 * @fileoverview Multi-source connection manager for YAML-based tools
 * Manages multiple named IBM i connection pools based on YAML source configurations
 *
 * @module src/services/yaml-sources/sourceManager
 */

import { BindingValue, QueryResult } from "@ibm/mapepire-js";
import {
  SourceConfig,
  SqlToolSecurityConfig,
} from "@/ibmi-mcp-server/schemas/index.js";
import { ErrorHandler, logger } from "@/utils/internal/index.js";
import {
  requestContextService,
  RequestContext,
} from "@/utils/internal/requestContext.js";
import { JsonRpcErrorCode } from "@/types-global/errors.js";
import {
  BaseConnectionPool,
  PoolConnectionConfig,
  PoolHealth,
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
   * Register a new source configuration
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
            port: sourceConfig.port || 8471,
            user: sourceConfig.user.substring(0, 3) + "***", // Mask username for security
          },
          `Registering source: ${sourceName}`,
        );

        // Convert YAML source to pool connection config
        const poolConfig: PoolConnectionConfig = {
          host: sourceConfig.host,
          user: sourceConfig.user,
          password: sourceConfig.password,
          port: sourceConfig.port,
          ignoreUnauthorized: sourceConfig["ignore-unauthorized"],
        };

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
  ): Promise<QueryResult<T>> {
    return super.executeQuery<T>(
      sourceName,
      query,
      params,
      context,
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
   * Get detailed status of all sources
   */
  getSourcesStatus(): Record<
    string,
    { initialized: boolean; connecting: boolean; healthStatus: string }
  > {
    const status: Record<
      string,
      { initialized: boolean; connecting: boolean; healthStatus: string }
    > = {};

    for (const sourceName of this.getRegisteredPools()) {
      const poolStatus = this.getPoolStatus(sourceName);
      if (poolStatus) {
        status[sourceName] = poolStatus;
      }
    }

    return status;
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
      healthStatus: string;
      lastActivityAt?: Date;
    }
  > {
    const summary: Record<
      string,
      {
        initialized: boolean;
        connecting: boolean;
        healthStatus: string;
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

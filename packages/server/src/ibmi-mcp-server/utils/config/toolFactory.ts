/**
 * @fileoverview SQL execution engine for YAML-defined tools
 * Processes SQL parameters and executes queries using SourceManager
 *
 * @module src/utils/yaml/yamlSqlExecutor
 */

import { SourceManager } from "../../services/sourceManager.js";
import { AuthenticatedPoolManager } from "../../services/authenticatedPoolManager.js";
import {
  SqlToolParameter,
  SqlToolSecurityConfig,
  SqlToolExecutionResult,
} from "@/ibmi-mcp-server/schemas/index.js";
import { ErrorHandler, logger } from "@/utils/internal/index.js";
import {
  requestContextService,
  RequestContext,
} from "@/utils/internal/requestContext.js";
import { JsonRpcErrorCode, McpError } from "@/types-global/errors.js";
import { ParameterProcessor } from "../sql/parameterProcessor.js";
import { authContext } from "@/mcp-server/transports/auth/index.js";
import { QueryResult } from "@ibm/mapepire-js";
import { SqlSecurityValidator } from "../security/sqlSecurityValidator.js";

/**
 * SQL execution engine for YAML-defined tools
 * Handles parameter binding and multi-source query execution
 */
export class SQLToolFactory {
  private static sourceManager: SourceManager;

  /**
   * Initialize the SQL executor with a source manager
   * @param sourceManager - Source manager instance
   */
  static initialize(sourceManager: SourceManager): void {
    this.sourceManager = sourceManager;
    logger.info(
      {
        requestId: "sql-executor-init",
        timestamp: new Date().toISOString(),
      },
      "YAML SQL Executor initialized successfully",
    );
  }

  /**
   * Execute a SQL statement with parameter binding
   * @param toolName - Name of the tool
   * @param sourceName - Source to execute against
   * @param sqlStatement - SQL statement with parameter placeholders
   * @param parameters - Parameters for processing
   * @param parameterDefinitions - Parameter definitions for validation
   * @param context - Request context (optional)
   * @param securityConfig - Security configuration for validation (optional)
   * @returns Execution result
   */
  static async executeStatementWithParameters<T = Record<string, unknown>>(
    toolName: string,
    sourceName: string,
    sqlStatement: string,
    parameters: Record<string, unknown>,
    parameterDefinitions: SqlToolParameter[] = [],
    context?: RequestContext,
    securityConfig?: SqlToolSecurityConfig,
    rowsToFetch?: number,
    fetchAllRows?: boolean,
  ): Promise<SqlToolExecutionResult> {
    const operationContext =
      context ||
      requestContextService.createRequestContext({
        operation: "ExecuteYamlStatementWithParameters",
        toolName,
        sourceName,
      });

    const startTime = Date.now();

    return ErrorHandler.tryCatch(
      async () => {
        if (!this.sourceManager) {
          throw new McpError(
            JsonRpcErrorCode.InternalError,
            "YAML SQL executor not initialized. Call YamlSqlExecutor.initialize() first.",
          );
        }

        logger.debug(
          {
            ...operationContext,
            sqlLength: sqlStatement.length,
            parameterCount: Object.keys(parameters).length,
            definitionCount: parameterDefinitions.length,
          },
          `Processing SQL statement with parameters for tool: ${toolName}`,
        );

        let processedSql: string;
        let bindingParameters: (string | number | (string | number)[])[] = [];

        // Special handling for direct SQL substitution (e.g., execute_sql tool)
        if (
          parameterDefinitions.length === 1 &&
          parameterDefinitions[0] &&
          sqlStatement.trim() === `:${parameterDefinitions[0].name}`
        ) {
          // This is a direct SQL substitution case (like execute_sql)
          const paramName = parameterDefinitions[0].name;
          if (
            paramName in parameters &&
            typeof parameters[paramName] === "string"
          ) {
            processedSql = parameters[paramName] as string;
            bindingParameters = [];

            logger.debug(
              {
                ...operationContext,
                originalStatement: sqlStatement,
                substitutedSql:
                  processedSql.substring(0, 100) +
                  (processedSql.length > 100 ? "..." : ""),
                parameterName: paramName,
              },
              `Applied direct SQL substitution for tool: ${toolName}`,
            );
          } else {
            throw new McpError(
              JsonRpcErrorCode.ValidationError,
              `Missing or invalid SQL parameter '${paramName}' for direct substitution`,
              { paramName, toolName },
            );
          }
        } else if (parameterDefinitions.length > 0) {
          // Process with unified parameter validation and binding
          const result = await ParameterProcessor.process(
            sqlStatement,
            parameters,
            parameterDefinitions,
            {
              detailedLogging: true,
              validateSyntax: true,
              context: operationContext,
              strictTypeValidation: true,
            },
          );

          processedSql = result.sql;
          bindingParameters = result.parameters;

          if (result.missingParameters.length > 0) {
            logger.warning(
              {
                ...operationContext,
                missingParameters: result.missingParameters,
              },
              `Missing parameters for tool ${toolName}`,
            );
          }

          logger.debug(
            {
              ...operationContext,
              mode: result.mode,
              parameterCount: bindingParameters.length,
              parametersUsed: result.parameterNames,
            },
            `SQL processed with parameter binding`,
          );
        } else {
          // No parameter definitions - use SQL as-is
          processedSql = sqlStatement;
          bindingParameters = [];
          logger.debug(
            {
              ...operationContext,
              sqlLength: sqlStatement.length,
            },
            `SQL used as-is (no parameters defined)`,
          );
        }

        // Execute the query with auth-aware routing
        // SECURITY: Always validate the *runtime* SQL before routing.
        // The authenticated (IBMi token) execution path historically did not
        // receive `securityConfig`, allowing bypass of YAML tool security.
        if (securityConfig) {
          SqlSecurityValidator.validateQuery(
            processedSql,
            securityConfig,
            operationContext,
          );
        }

        const result = await this.executeWithAuthRouting<T>(
          processedSql,
          bindingParameters,
          sourceName,
          operationContext,
          securityConfig,
          rowsToFetch,
          fetchAllRows,
        );

        const executionTime = Date.now() - startTime;

        logger.debug(
          {
            ...operationContext,
            executionTime,
            rowCount: result.data?.length || 0,
            success: result.success,
          },
          `SQL executed successfully for tool: ${toolName}`,
        );

        const simplifiedColumns = (result.metadata?.columns ?? []).map(
          (column, index) => {
            const record = column as {
              name?: string;
              type?: string;
              label?: string;
            };

            const name = record.name ?? record.label ?? `column_${index}`;

            return {
              name,
              type: record.type,
              label: record.label ?? record.name,
            };
          },
        );

        return {
          data: result.data || [],
          rowCount: result.data?.length || 0,
          affectedRows: (result.metadata as { affectedRows?: number })
            ?.affectedRows,
          columns: simplifiedColumns,
          executionTime,
          parameterMetadata: {
            mode: parameterDefinitions.length > 0 ? "parameters" : "none",
            parameterCount: bindingParameters.length,
            processedParameters: parameterDefinitions.map((p) => p.name),
          },
        };
      },
      {
        operation: "ExecuteYamlStatementWithParameters",
        context: operationContext,
        errorCode: JsonRpcErrorCode.InternalError,
      },
    );
  }

  /**
   * Execute a query with auth-aware routing
   * Routes to authenticated pools when IBM i tokens are present, otherwise uses source manager
   * @param sql - Processed SQL statement
   * @param parameters - Binding parameters
   * @param sourceName - Source name for fallback routing
   * @param context - Request context
   * @param securityConfig - Optional security configuration
   * @returns Query execution result
   * @private
   */
  private static async executeWithAuthRouting<T>(
    sql: string,
    parameters: (string | number | (string | number)[])[],
    sourceName: string,
    context: RequestContext,
    securityConfig?: SqlToolSecurityConfig,
    rowsToFetch?: number,
    fetchAllRows?: boolean,
  ): Promise<QueryResult<T>> {
    // Check for IBM i authentication context
    const authInfo = authContext.getStore()?.authInfo;

    // rowsToFetch wins over fetchAllRows. A deliberate row cap should never
    // be silently overridden by an unbounded fetch, so we only take the
    // paginated path when fetchAllRows is the sole directive.
    if (fetchAllRows && rowsToFetch !== undefined) {
      logger.warning(
        {
          ...context,
          sourceName,
          rowsToFetch,
          fetchAllRows: true,
        },
        "Both rowsToFetch and fetchAllRows are set; honoring rowsToFetch and ignoring fetchAllRows (safer default).",
      );
    }

    if (fetchAllRows && rowsToFetch === undefined) {
      logger.debug(
        {
          ...context,
          sourceName,
          routingMode: authInfo?.ibmiToken ? "authenticated" : "environment",
          fetchMode: "paginated-all-rows",
        },
        "Executing SQL with fetchAllRows via pagination path",
      );

      const paginated = authInfo?.ibmiToken
        ? await AuthenticatedPoolManager.getInstance().executeQueryWithPagination(
            authInfo.ibmiToken,
            sql,
            parameters,
            context,
            undefined,
            securityConfig,
          )
        : await this.sourceManager.executeQueryWithPagination(
            sourceName,
            sql,
            parameters,
            context,
            undefined,
            securityConfig,
          );

      // Adapt the paginated shape to QueryResult<T> so downstream
      // executeStatementWithParameters can read .data and .metadata uniformly.
      return {
        success: paginated.success,
        data: paginated.data as T[],
        metadata: paginated.metadata ?? { columns: [] },
        sql_rc: paginated.sql_rc as number,
        execution_time: paginated.execution_time ?? 0,
        is_done: true,
        has_results: paginated.data.length > 0,
        update_count: 0,
        id: "",
        sql_state: "",
      } as QueryResult<T>;
    }

    if (authInfo?.ibmiToken) {
      // Use authenticated pool manager when IBM i token is present
      logger.debug(
        {
          ...context,
          authClientId: authInfo.clientId,
          ibmiHost: authInfo.ibmiHost,
          routingMode: "authenticated",
        },
        "Executing SQL via authenticated pool",
      );

      const poolManager = AuthenticatedPoolManager.getInstance();
      return poolManager.executeQuery<T>(
        authInfo.ibmiToken,
        sql,
        parameters,
        context,
        securityConfig,
        rowsToFetch,
      );
    } else {
      // Fall back to regular source manager (environment credentials)
      logger.debug(
        {
          ...context,
          sourceName,
          routingMode: "environment",
          rowsToFetch,
        },
        "Executing SQL via source manager",
      );

      // Preserve the existing conditional call shape so downstream tests
      // that assert exact arity keep passing. rowsToFetch/securityConfig are
      // optional trailing args in sourceManager.executeQuery and safe to omit.
      if (rowsToFetch !== undefined) {
        return this.sourceManager.executeQuery<T>(
          sourceName,
          sql,
          parameters,
          context,
          securityConfig,
          rowsToFetch,
        );
      }
      return securityConfig
        ? this.sourceManager.executeQuery<T>(
            sourceName,
            sql,
            parameters,
            context,
            securityConfig,
          )
        : this.sourceManager.executeQuery<T>(
            sourceName,
            sql,
            parameters,
            context,
          );
    }
  }

  /**
   * Get initialized state
   * @returns Whether the executor is initialized
   */
  static isInitialized(): boolean {
    return !!this.sourceManager;
  }

  /**
   * Get the source manager instance (for testing)
   * @returns Source manager instance
   * @internal
   */
  static getSourceManager(): SourceManager | undefined {
    return this.sourceManager;
  }
}

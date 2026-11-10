/**
 * @fileoverview YAML configuration parser with validation and environment variable interpolation
 * Handles parsing, validation, and processing of YAML tool configurations
 *
 * @module src/utils/yaml/yamlParser
 */

import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { load as yamlLoad } from "js-yaml";
import { ParsingResult, SqlToolsConfig } from "../../schemas/index.js";
import { ErrorHandler, logger } from "@/utils/internal/index.js";
import {
  requestContextService,
  RequestContext,
} from "@/utils/internal/requestContext.js";

// Import schemas from centralized location
import {
  SqlToolsConfigSchema,
  SqlToolSecurityConfig,
} from "@/ibmi-mcp-server/schemas/index.js";
import { JsonRpcErrorCode, McpError } from "@/types-global/errors.js";
import { SqlSecurityValidator } from "../security/sqlSecurityValidator.js";

/**
 * YAML configuration parser with validation and environment variable interpolation
 */
export class ConfigParser {
  /**
   * Parse and validate a YAML tools configuration file
   * @param filePath - Path to the YAML configuration file
   * @param context - Request context for logging
   * @returns Parsing result with validation information
   */
  static async parseYamlFile(
    filePath: string,
    context?: RequestContext,
  ): Promise<ParsingResult> {
    const operationContext =
      context ||
      requestContextService.createRequestContext({
        operation: "ParseYamlFile",
        filePath,
      });

    return ErrorHandler.tryCatch(
      async () => {
        logger.info(
          {
            ...operationContext,
            filePath,
          },
          "Parsing YAML configuration file",
        );

        // Check if file exists
        const resolvedPath = resolve(filePath);
        if (!existsSync(resolvedPath)) {
          throw new McpError(
            JsonRpcErrorCode.ValidationError,
            `YAML configuration file not found: ${resolvedPath}`,
          );
        }

        // Read file content
        const fileContent = readFileSync(resolvedPath, "utf8");
        logger.debug(
          {
            ...operationContext,
            contentLength: fileContent.length,
          },
          "YAML file content loaded",
        );

        // Interpolate environment variables at startup
        // TODO: In the future, this should use client-provided environment variables
        // instead of server-side environment variables
        const interpolatedContent = this.interpolateEnvironmentVariables(
          fileContent,
          operationContext,
        );

        // Parse YAML
        const parsedYaml = yamlLoad(interpolatedContent);

        // Validate against schema
        const validationResult = SqlToolsConfigSchema.safeParse(parsedYaml);

        if (!validationResult.success) {
          const errors = validationResult.error.issues.map(
            (err) => `${err.path.join(".")}: ${err.message}`,
          );

          logger.error(
            {
              ...operationContext,
              errors,
            },
            "YAML validation failed",
          );

          return {
            success: false,
            errors,
          };
        }

        const config = validationResult.data as SqlToolsConfig;

        // Additional validation - check tool source references
        const sourceValidationErrors =
          this.validateToolSourceReferences(config);
        if (sourceValidationErrors.length > 0) {
          logger.error(
            {
              ...operationContext,
              errors: sourceValidationErrors,
            },
            "Source reference validation failed",
          );

          return {
            success: false,
            errors: sourceValidationErrors,
          };
        }

        // Note: Toolset validation is intentionally deferred to post-merge validation
        // in YamlConfigBuilder to support cross-file tool references with YAML_MERGE_ARRAYS

        // Additional validation - check tool-specific requirements
        const toolValidationErrors = this.validateToolRequirements(config);
        if (toolValidationErrors.length > 0) {
          logger.error(
            {
              ...operationContext,
              errors: toolValidationErrors,
            },
            "Tool requirements validation failed",
          );

          return {
            success: false,
            errors: toolValidationErrors,
          };
        }

        // Validate SQL security at load time (fail-fast)
        const securityValidationErrors = this.validateSqlSecurity(
          config,
          operationContext,
        );
        if (securityValidationErrors.length > 0) {
          logger.error(
            {
              ...operationContext,
              errors: securityValidationErrors,
            },
            "SQL security validation failed at load time",
          );

          return {
            success: false,
            errors: securityValidationErrors,
          };
        }

        // Count disabled tools
        const totalTools = config.tools ? Object.keys(config.tools).length : 0;
        const disabledTools = config.tools
          ? Object.values(config.tools).filter((tool) => tool.enabled === false)
              .length
          : 0;
        const enabledTools = totalTools - disabledTools;

        // Generate statistics
        const stats = {
          sourceCount: config.sources ? Object.keys(config.sources).length : 0,
          toolCount: totalTools,
          enabledToolCount: enabledTools,
          disabledToolCount: disabledTools,
          toolsetCount: config.toolsets
            ? Object.keys(config.toolsets).length
            : 0,
          totalParameterCount: config.tools
            ? Object.values(config.tools).reduce(
                (sum, tool) => sum + (tool.parameters?.length || 0),
                0,
              )
            : 0,
        };

        logger.info(
          {
            ...operationContext,
            stats,
          },
          "YAML configuration parsed successfully",
        );

        return {
          success: true,
          config,
          stats,
        };
      },
      {
        operation: "ParseYamlFile",
        context: operationContext,
        errorCode: JsonRpcErrorCode.ConfigurationError,
      },
    );
  }

  /**
   * Interpolate environment variables in YAML content
   * Supports ${VAR_NAME} syntax
   * @param content - YAML content string
   * @param context - Request context for logging
   * @returns Content with environment variables interpolated
   * @private
   */
  private static interpolateEnvironmentVariables(
    content: string,
    context: RequestContext,
  ): string {
    return content.replace(/\$\{([^}]+)\}/g, (match, varName) => {
      const envValue = process.env[varName];
      if (envValue === undefined) {
        logger.debug(
          {
            ...context,
            varName,
          },
          `Environment variable ${varName} not found, keeping placeholder`,
        );
        return match;
      }
      logger.debug(
        {
          ...context,
          varName,
        },
        `Environment variable ${varName} found and substituted`,
      );
      return envValue;
    });
  }

  /**
   * Validate that all tool source references exist in the sources section
   * @param config - Parsed YAML configuration
   * @returns Array of validation errors
   * @private
   */
  private static validateToolSourceReferences(
    config: SqlToolsConfig,
  ): string[] {
    const errors: string[] = [];

    // Skip validation if either section is missing
    if (!config.sources || !config.tools) {
      return errors;
    }

    const sourceNames = Object.keys(config.sources);

    Object.entries(config.tools).forEach(([toolName, tool]) => {
      if (!sourceNames.includes(tool.source)) {
        errors.push(
          `Tool '${toolName}' references unknown source '${tool.source}'. Available sources: ${sourceNames.join(", ")}`,
        );
      }
    });

    return errors;
  }

  /**
   * Validate tool-specific requirements
   * @param config - Parsed YAML configuration
   * @returns Array of validation errors
   * @private
   */
  private static validateToolRequirements(config: SqlToolsConfig): string[] {
    const errors: string[] = [];

    // Skip validation if tools section is missing
    if (!config.tools) {
      return errors;
    }

    Object.entries(config.tools).forEach(([toolName, tool]) => {
      // All tools must have a statement
      if (!tool.statement || tool.statement.trim().length === 0) {
        errors.push(`Tool '${toolName}' must have a non-empty statement field`);
      }
    });

    return errors;
  }

  /**
   * Validate SQL statements for security at load time
   * Fails server startup if security violations found
   * @param config - Parsed YAML configuration
   * @param context - Request context for logging
   * @returns Array of validation errors
   * @private
   */
  private static validateSqlSecurity(
    config: SqlToolsConfig,
    context: RequestContext,
  ): string[] {
    const errors: string[] = [];

    // Skip if no tools defined
    if (!config.tools) {
      return errors;
    }

    Object.entries(config.tools).forEach(([toolName, tool]) => {
      // Skip disabled tools
      if (tool.enabled === false) {
        return;
      }

      // Skip tools without statements
      if (!tool.statement?.trim()) {
        return;
      }

      try {
        // Build security config from tool
        const securityConfig: SqlToolSecurityConfig = {
          readOnly: tool.security?.readOnly ?? true,
          maxQueryLength: tool.security?.maxQueryLength ?? 10000,
          forbiddenKeywords: tool.security?.forbiddenKeywords,
        };

        // Validate SQL statement at load time
        SqlSecurityValidator.validateQuery(
          tool.statement,
          securityConfig,
          context,
        );

        logger.debug(
          { ...context, toolName },
          `SQL security validation passed at load time for tool: ${toolName}`,
        );
      } catch (error) {
        if (error instanceof McpError) {
          errors.push(
            `Tool '${toolName}' has security violation: ${error.message}`,
          );
        } else {
          errors.push(
            `Tool '${toolName}' validation failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    });

    return errors;
  }
}

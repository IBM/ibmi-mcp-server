/**
 * @fileoverview YAML configuration parser with validation and environment variable interpolation
 * Handles parsing, validation, and processing of YAML tool configurations
 *
 * @module src/utils/yaml/yamlParser
 */

import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { load as yamlLoad } from "js-yaml";
import { ProcessedSQLTool } from "./types.js";
import { ParsingResult, SqlToolsConfig } from "../../schemas/index.js";
import { SqlToolParameter } from "../../schemas/index.js";
import { ErrorHandler, logger } from "@/utils/internal/index.js";
import {
  requestContextService,
  RequestContext,
} from "@/utils/internal/requestContext.js";

// Import schemas from centralized location
import {
  SqlToolsConfigSchema,
  SqlToolParameterSchema,
} from "@/ibmi-mcp-server/schemas/index.js";
import { JsonRpcErrorCode, McpError } from "@/types-global/errors.js";

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
          const errors = validationResult.error.errors.map(
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

        // Process tools
        const processedTools = this.processTools(config);

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
          processedTools,
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
          envValue: envValue.substring(0, 10) + "...", // Only show first 10 chars for security
        },
        `Environment variable ${varName} found and substituted`,
      );
      return envValue;
    });
  }

  /**
   * Interpolate environment variables using client-provided environment
   * Supports ${VAR_NAME} syntax
   *
   * NOT USED CURRENTLY
   * @param content - Content string with environment variable placeholders
   * @param clientEnvironment - Environment variables provided by the client
   * @param context - Request context for logging
   * @returns Content with environment variables interpolated
   */
  static interpolateClientEnvironmentVariables(
    content: string,
    clientEnvironment: Record<string, string> = {},
    context?: RequestContext,
  ): string {
    const operationContext =
      context ||
      requestContextService.createRequestContext({
        operation: "InterpolateClientEnvironmentVariables",
      });

    logger.debug(
      {
        ...operationContext,
        contentLength: content.length,
        availableClientVars: Object.keys(clientEnvironment),
      },
      "Starting client environment variable interpolation",
    );

    return content.replace(/\$\{([^}]+)\}/g, (match, varName) => {
      const envValue = clientEnvironment[varName];
      if (envValue === undefined) {
        logger.debug(
          {
            ...operationContext,
            match,
            varName,
            availableClientVars: Object.keys(clientEnvironment),
          },
          `Client environment variable ${varName} not found, keeping placeholder`,
        );
        return match;
      }
      logger.debug(
        {
          ...operationContext,
          varName,
          envValue: envValue.substring(0, 10) + "...", // Only show first 10 chars for security
        },
        `Client environment variable ${varName} found and substituted`,
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
   * Process tools from YAML configuration into runtime format
   * @param config - Validated YAML configuration
   * @returns Array of processed tools
   * @private
   */
  private static processTools(config: SqlToolsConfig): ProcessedSQLTool[] {
    const processedTools: ProcessedSQLTool[] = [];

    // Return empty array if tools section is missing
    if (!config.tools) {
      return processedTools;
    }

    // Build toolset membership map
    const toolToToolsets: Record<string, string[]> = {};
    if (config.toolsets) {
      Object.entries(config.toolsets).forEach(([toolsetName, toolset]) => {
        toolset.tools.forEach((toolName) => {
          if (!toolToToolsets[toolName]) {
            toolToToolsets[toolName] = [];
          }
          toolToToolsets[toolName].push(toolsetName);
        });
      });
    }

    // Process each tool
    Object.entries(config.tools).forEach(([toolName, tool]) => {
      // Skip disabled tools
      if (tool.enabled === false) {
        logger.debug(
          {
            toolName,
            enabled: false,
          },
          `Skipping disabled tool: ${toolName}`,
        );
        return;
      }

      const source = config.sources?.[tool.source];
      const toolsets = toolToToolsets[toolName] || [];

      processedTools.push({
        name: toolName,
        config: tool,
        source: source!,
        toolsets,
        metadata: {
          name: toolName,
          description: tool.description,
          domain: tool.domain,
          category: tool.category,
          toolsets,
        },
      });
    });

    return processedTools;
  }

  /**
   * Validate a single tool parameter definition
   * @param parameter - Parameter definition to validate
   * @returns Validation result
   */
  static validateParameter(parameter: SqlToolParameter): {
    valid: boolean;
    errors: string[];
  } {
    const result = SqlToolParameterSchema.safeParse(parameter);

    if (result.success) {
      return { valid: true, errors: [] };
    }

    const errors = result.error.errors.map((err) => err.message);
    return { valid: false, errors };
  }

  /**
   * Get available parameter types
   * @returns Array of supported parameter types
   */
  static getAvailableParameterTypes(): string[] {
    return ["string", "number", "boolean", "integer"];
  }
}

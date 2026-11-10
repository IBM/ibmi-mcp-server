/**
 * @fileoverview YAML configuration parser with validation and environment variable interpolation
 * Handles parsing, validation, and processing of YAML tool configurations
 *
 * @module src/utils/yaml/yamlParser
 */

import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { load as yamlLoad } from "js-yaml";
import { ErrorHandler, logger } from "@/utils/internal/index.js";
import {
  requestContextService,
  RequestContext,
} from "@/utils/internal/requestContext.js";

// Import schemas from centralized location
import {
  SqlToolsConfig,
  SqlToolsConfigSchema,
  SqlToolSecurityConfig,
} from "@/ibmi-mcp-server/schemas/index.js";
import { JsonRpcErrorCode, McpError } from "@/types-global/errors.js";
import { SqlSecurityValidator } from "../security/sqlSecurityValidator.js";
import { ParameterProcessor } from "../sql/parameterProcessor.js";

/** A YAML tools file that parsed and validated. */
export interface ParsedYamlFile {
  config: SqlToolsConfig;
  stats: {
    sourceCount: number;
    toolCount: number;
    enabledToolCount: number;
    disabledToolCount: number;
    toolsetCount: number;
    totalParameterCount: number;
  };
}

/**
 * YAML configuration parser with validation and environment variable interpolation
 */
export class ConfigParser {
  /**
   * Parse and validate a YAML tools configuration file
   * @param filePath - Path to the YAML configuration file
   * @param context - Request context for logging
   * @param allowUnsetVariables - Leave a `${VAR}` whose variable is not set as
   *   written instead of failing. For callers that never connect.
   * @returns The validated configuration and its statistics
   * @throws {McpError} naming the file and the problems found in it, when the
   *   file cannot be read, parsed or validated
   */
  static async parseYamlFile(
    filePath: string,
    context?: RequestContext,
    allowUnsetVariables = false,
  ): Promise<ParsedYamlFile> {
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

        const fail = (errors: string[]): never => {
          throw new McpError(
            JsonRpcErrorCode.ConfigurationError,
            `Invalid tool configuration in ${resolvedPath}: ${errors.join("; ")}`,
            { filePath: resolvedPath, errors },
          );
        };

        // Read file content
        const fileContent = readFileSync(resolvedPath, "utf8");
        logger.debug(
          {
            ...operationContext,
            contentLength: fileContent.length,
          },
          "YAML file content loaded",
        );

        let parsedYaml: unknown;
        try {
          parsedYaml = yamlLoad(fileContent);
        } catch (error) {
          fail([error instanceof Error ? error.message : String(error)]);
        }

        // Interpolate after parsing, so that a value can change neither the
        // structure of the document nor its own type.
        // TODO: In the future, this should use client-provided environment variables
        // instead of server-side environment variables
        const substituted = new Set<string>();
        const unset = new Set<string>();
        const interpolated = this.interpolateEnvironmentVariables(
          parsedYaml,
          substituted,
          unset,
        );
        if (unset.size > 0 && !allowUnsetVariables) {
          fail([`environment variable(s) not set: ${[...unset].join(", ")}`]);
        }
        // Names only, never values: they are credentials.
        logger.debug(
          { ...operationContext, variables: [...substituted] },
          "Environment variables substituted",
        );

        // Validate against schema
        const validationResult = SqlToolsConfigSchema.safeParse(interpolated);
        if (!validationResult.success) {
          fail(
            validationResult.error.issues.map(
              (err) => `${err.path.join(".")}: ${err.message}`,
            ),
          );
        }

        const config = validationResult.data as SqlToolsConfig;

        // Note: Toolset validation is intentionally deferred to post-merge validation
        // in YamlConfigBuilder to support cross-file tool references with YAML_MERGE_ARRAYS

        const errors = [
          ...this.validateToolSourceReferences(config),
          ...this.validateParameterMarkers(config),
          ...this.validateSqlSecurity(config, operationContext),
        ];
        if (errors.length > 0) {
          fail(errors);
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

        return { config, stats };
      },
      {
        operation: "ParseYamlFile",
        context: operationContext,
        errorCode: JsonRpcErrorCode.ConfigurationError,
      },
    );
  }

  /**
   * Replace `${VAR_NAME}` in every string value of a parsed YAML document.
   * Keys and non-string values are left alone.
   * @param value - Parsed YAML value
   * @param substituted - Receives the names of the variables substituted
   * @param unset - Receives the names of referenced variables that are not set
   * @returns The value with environment variables interpolated
   * @private
   */
  private static interpolateEnvironmentVariables(
    value: unknown,
    substituted: Set<string>,
    unset: Set<string>,
  ): unknown {
    if (typeof value === "string") {
      return value.replace(/\$\{([^}]+)\}/g, (match, varName: string) => {
        const envValue = process.env[varName];
        if (envValue === undefined) {
          unset.add(varName);
          return match;
        }
        substituted.add(varName);
        return envValue;
      });
    }
    if (Array.isArray(value)) {
      return value.map((item) =>
        this.interpolateEnvironmentVariables(item, substituted, unset),
      );
    }
    if (typeof value === "object" && value?.constructor === Object) {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          this.interpolateEnvironmentVariables(item, substituted, unset),
        ]),
      );
    }
    return value;
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
   * A statement binds by name (:name) or by position (?), never both
   * @param config - Parsed YAML configuration
   * @returns Array of validation errors
   * @private
   */
  private static validateParameterMarkers(config: SqlToolsConfig): string[] {
    return Object.entries(config.tools ?? {})
      .filter(([, tool]) =>
        ParameterProcessor.mixesMarkerStyles(tool.statement),
      )
      .map(
        ([toolName]) =>
          `Tool '${toolName}': ${ParameterProcessor.MIXED_MARKERS_MESSAGE}`,
      );
  }

  /**
   * Validate SQL statements for security at load time
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

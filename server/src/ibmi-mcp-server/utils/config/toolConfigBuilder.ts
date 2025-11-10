/**
 * @fileoverview Tool Configuration Builder - Standardized tool configuration creation
 * Unifies all tool configuration creation logic into a single, consistent class
 * Eliminates duplicate logic between cached and regular tool creation paths
 *
 * @module src/ibmi-mcp-server/utils/yaml/toolConfigBuilder
 */

import { z } from "zod";
import { resolve, join } from "path";
import { existsSync } from "fs";
import { glob } from "glob";
import {
  ProcessedSQLTool,
  CachedToolConfig,
  ConfigSource,
  ConfigBuildResult,
} from "./types.js";
import {
  SqlToolConfig,
  SqlToolParameter,
  SqlToolsConfig,
  StandardSqlToolOutput,
  ToolAnnotations,
} from "@/ibmi-mcp-server/schemas/index.js";
import { ConfigParser } from "./configParser.js";
import { ErrorHandler, logger } from "@/utils/internal/index.js";
import {
  requestContextService,
  RequestContext,
} from "@/utils/internal/requestContext.js";
import { JsonRpcErrorCode, McpError } from "@/types-global/errors.js";
import { SQLToolFactory } from "./toolFactory.js";
import {
  sqlResponseFormatter,
  defaultResponseFormatter,
  standardSqlToolOutputSchema,
} from "./toolDefinitions.js";
import { config } from "@/config/index.js";

/**
 * Configuration merging options
 */
export interface ConfigMergeOptions {
  /** Whether to merge arrays (true) or replace them (false) */
  mergeArrays?: boolean;
  /** Whether to allow duplicate tool names */
  allowDuplicateTools?: boolean;
  /** Whether to allow duplicate source names */
  allowDuplicateSources?: boolean;
  /** Whether to validate merged config */
  validateMerged?: boolean;
}

/**
 * Tool Configuration Builder
 * Standardized tool configuration creation with consistent error handling,
 * schema generation, and handler creation logic
 */
export class ToolConfigBuilder {
  private static instance: ToolConfigBuilder;

  /**
   * Get the singleton instance
   */
  static getInstance(): ToolConfigBuilder {
    if (!ToolConfigBuilder.instance) {
      ToolConfigBuilder.instance = new ToolConfigBuilder();
    }
    return ToolConfigBuilder.instance;
  }

  /**
   * Generate a Zod schema from SQL parameter definitions
   * @param parameters - SQL parameter definitions (using standardized types)
   * @param toolName - Tool name for error reporting
   * @returns Generated Zod schema
   */
  generateZodSchema(
    parameters: SqlToolParameter[],
    toolName: string,
  ): z.ZodObject<Record<string, z.ZodTypeAny>> {
    const schemaShape: Record<string, z.ZodTypeAny> = {};

    // Process parameters
    for (const param of parameters) {
      let zodType: z.ZodTypeAny;

      // Generate Zod type based on parameter type
      switch (param.type) {
        case "string": {
          let stringType = z.string();

          // Apply string-specific constraints using native Zod methods
          if (param.minLength !== undefined) {
            stringType = stringType.min(
              param.minLength,
              `Length must be >= ${param.minLength}`,
            );
          }
          if (param.maxLength !== undefined) {
            stringType = stringType.max(
              param.maxLength,
              `Length must be <= ${param.maxLength}`,
            );
          }
          if (param.pattern) {
            stringType = stringType.regex(
              new RegExp(param.pattern),
              `Value does not match pattern: ${param.pattern}`,
            );
          }

          zodType = stringType;
          break;
        }
        case "integer": {
          let intType = z.number().int("Value must be an integer");

          // Apply numeric constraints using native Zod methods
          if (param.min !== undefined) {
            intType = intType.min(param.min, `Value must be >= ${param.min}`);
          }
          if (param.max !== undefined) {
            intType = intType.max(param.max, `Value must be <= ${param.max}`);
          }

          zodType = intType;
          break;
        }
        case "float": {
          let floatType = z.number();

          // Apply numeric constraints using native Zod methods
          if (param.min !== undefined) {
            floatType = floatType.min(
              param.min,
              `Value must be >= ${param.min}`,
            );
          }
          if (param.max !== undefined) {
            floatType = floatType.max(
              param.max,
              `Value must be <= ${param.max}`,
            );
          }

          zodType = floatType;
          break;
        }
        case "boolean":
          zodType = z.boolean();
          break;
        case "array": {
          // For array parameters, create array of the specified item type
          let itemType: z.ZodTypeAny;
          if (param.itemType === "string") {
            itemType = z.string();
          } else if (param.itemType === "integer") {
            itemType = z.number().int("Array items must be integers");
          } else if (param.itemType === "float") {
            itemType = z.number();
          } else if (param.itemType === "boolean") {
            itemType = z.boolean();
          } else {
            itemType = z.unknown();
          }

          let arrayType = z.array(itemType);

          // Apply array length constraints using native Zod methods
          if (param.minLength !== undefined) {
            arrayType = arrayType.min(
              param.minLength,
              `Array length must be >= ${param.minLength}`,
            );
          }
          if (param.maxLength !== undefined) {
            arrayType = arrayType.max(
              param.maxLength,
              `Array length must be <= ${param.maxLength}`,
            );
          }

          zodType = arrayType;
          break;
        }
        default:
          throw new McpError(
            JsonRpcErrorCode.InvalidParams,
            `Unsupported parameter type '${param.type}' for parameter '${param.name}' in tool '${toolName}'`,
            { toolName, parameterName: param.name, parameterType: param.type },
          );
      }

      // Handle enum constraints for all types (except boolean which is already constrained)
      if (
        param.enum &&
        Array.isArray(param.enum) &&
        param.enum.length > 0 &&
        param.type !== "boolean"
      ) {
        // For enums, we need to replace the base type with a union of literals
        // This properly translates to JSON Schema with "enum" keyword
        const enumValues = param.enum as Array<string | number>;

        if (enumValues.length === 1) {
          // Single value enum becomes a literal
          zodType = z.literal(enumValues[0] as string | number | boolean);
        } else if (enumValues.every((v) => typeof v === "string")) {
          // All strings: use z.enum for optimal JSON Schema generation
          zodType = z.enum(enumValues as [string, ...string[]]);
        } else {
          // Mixed types or numbers: use union of literals
          // Construct the tuple directly to satisfy TypeScript's type requirements
          const [first, second, ...rest] = enumValues;
          zodType = z.union([
            z.literal(first as string | number | boolean),
            z.literal(second as string | number | boolean),
            ...rest.map((val) => z.literal(val as string | number | boolean)),
          ] as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
        }
      }

      // Build enhanced description with enum values for LLM clarity
      let finalDescription = param.description || "";

      // Append enum constraint to description for LLM understanding
      if (param.enum && Array.isArray(param.enum) && param.enum.length > 0) {
        const formattedValues = param.enum
          .map((v) => (typeof v === "string" ? `'${v}'` : String(v)))
          .join(", ");

        const enumClause = `Must be one of: ${formattedValues}`;

        if (finalDescription) {
          // Append to existing description with proper punctuation
          finalDescription = finalDescription.trim();
          if (
            !finalDescription.endsWith(".") &&
            !finalDescription.endsWith("?") &&
            !finalDescription.endsWith("!")
          ) {
            finalDescription += ".";
          }
          finalDescription += ` ${enumClause}`;
        } else {
          // Use as the sole description
          finalDescription = enumClause;
        }
      }

      // Add description (now includes enum info if applicable)
      if (finalDescription) {
        zodType = zodType.describe(finalDescription);
      }

      // Add default value if provided (must be done last)
      if (param.default !== undefined) {
        zodType = zodType.default(param.default);
      }

      // Mark as optional if not required and no default provided
      if (param.required === false && param.default === undefined) {
        zodType = zodType.optional();
      }

      schemaShape[param.name] = zodType;
    }

    return z.object(schemaShape).strict();
  }

  /**
   * Filter processed tools by allowed toolsets
   * @param processedTools - Array of processed tools to filter
   * @param allowedToolsets - List of toolset names to include
   * @returns Filtered array containing only tools that belong to allowed toolsets
   */
  filterToolsByToolsets(
    processedTools: ProcessedSQLTool[],
    allowedToolsets: string[],
  ): ProcessedSQLTool[] {
    if (!allowedToolsets || allowedToolsets.length === 0) {
      return processedTools;
    }

    return processedTools.filter(
      (tool) =>
        tool.toolsets &&
        tool.toolsets.some((toolset: string) =>
          allowedToolsets.includes(toolset),
        ),
    );
  }

  /**
   * Build a complete tool configuration
   * This is the single, unified method for creating all tool configurations
   * @param toolName - Name of the tool
   * @param config - Tool configuration from YAML
   * @param toolsets - Toolsets this tool belongs to
   * @param context - Request context
   * @returns Complete cached tool configuration
   */
  async buildToolConfig(
    toolName: string,
    config: SqlToolConfig,
    toolsets: string[],
    context: RequestContext,
  ): Promise<CachedToolConfig> {
    const buildContext = requestContextService.createRequestContext({
      parentRequestId: context.requestId,
      operation: "ToolConfigBuilder.buildToolConfig",
      toolName,
    });

    return ErrorHandler.tryCatch(
      async () => {
        logger.debug(
          {
            ...buildContext,
            description: config.description,
            toolsets,
            domain: config.domain,
            category: config.category,
          },
          `Building tool configuration: ${toolName}`,
        );

        // Generate Zod schema for parameters
        const inputSchema = this.generateZodSchema(
          config.parameters || [],
          toolName,
        );

        const toolLogic = this.createToolLogic(
          toolName,
          config,
          inputSchema,
          buildContext,
        );

        const annotations = this.buildAnnotations(toolName, config, toolsets);
        const responseFormatter = this.getResponseFormatter(config);

        const toolConfig: CachedToolConfig = {
          name: toolName,
          title: this.formatToolTitle(toolName),
          description: config.description,
          inputSchema,
          outputSchema: standardSqlToolOutputSchema,
          annotations,
          logic: toolLogic,
          responseFormatter,
        };

        logger.debug(
          buildContext,
          `Tool configuration built successfully: ${toolName}`,
        );

        return toolConfig;
      },
      {
        operation: "ToolConfigBuilder.buildToolConfig",
        context: buildContext,
        errorCode: JsonRpcErrorCode.InternalError,
      },
    );
  }

  /**
   * Create a unified tool handler function
   * This replaces the duplicate handler logic in yamlToolFactory
   * @param toolName - Name of the tool
   * @param config - Tool configuration
   * @param context - Request context
   * @returns Tool handler function
   * @private
   */
  private createToolLogic(
    toolName: string,
    config: SqlToolConfig,
    inputSchema: z.ZodObject<Record<string, z.ZodTypeAny>>,
    context: RequestContext,
  ) {
    return async (
      params: z.infer<typeof inputSchema>,
      requestContext: RequestContext,
    ): Promise<StandardSqlToolOutput> => {
      const executionContext = requestContextService.createRequestContext({
        parentRequestId: context.requestId,
        operation: `ExecuteYamlTool_${toolName}`,
        toolName,
        input: params,
        requestContext,
      });

      return ErrorHandler.tryCatch(
        async () => {
          if (!config.statement) {
            throw new McpError(
              JsonRpcErrorCode.InvalidParams,
              `Tool ${toolName} has no SQL statement defined`,
              { toolName },
            );
          }

          const result = await SQLToolFactory.executeStatementWithParameters(
            toolName,
            config.source,
            config.statement,
            params,
            config.parameters || [],
            executionContext,
            config.security,
          );

          const simplifiedColumns = (result.columns ?? []).map(
            (column: unknown, index: number) => {
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
            success: true,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            data: result.data as Record<string, any>[],
            metadata: {
              executionTime: result.executionTime,
              rowCount: result.rowCount,
              affectedRows: result.affectedRows,
              columns:
                simplifiedColumns.length > 0 ? simplifiedColumns : undefined,
              parameterMode: result.parameterMetadata?.mode,
              parameterCount: result.parameterMetadata?.parameterCount,
              processedParameters:
                result.parameterMetadata?.processedParameters,
              toolName,
              sqlStatement: config.statement,
              parameters: params,
            },
          } satisfies StandardSqlToolOutput;
        },
        {
          operation: `ExecuteYamlTool_${toolName}`,
          context: executionContext,
          input: params,
          errorCode: JsonRpcErrorCode.InternalError,
        },
      );
    };
  }

  /**
   * Determines the appropriate response formatter based on tool configuration.
   * For SQL formatters, extracts and passes formatting configuration (tableFormat, maxDisplayRows).
   */
  private getResponseFormatter(config: SqlToolConfig) {
    if (config.responseFormat === "markdown") {
      // Extract formatting configuration from tool config
      const formatterConfig = {
        tableFormat: config.tableFormat,
        maxDisplayRows: config.maxDisplayRows,
      };

      // Return a wrapper that passes the config to sqlResponseFormatter
      return (result: StandardSqlToolOutput) =>
        sqlResponseFormatter(result, formatterConfig);
    }

    return defaultResponseFormatter;
  }

  private buildAnnotations(
    toolName: string,
    config: SqlToolConfig,
    toolsets: string[],
  ): ToolAnnotations {
    const annotationInput: ToolAnnotations = {
      ...(config.annotations ?? {}),
    };

    const legacyReadOnly = config.readOnlyHint;
    const legacyOpenWorld = config.openWorldHint;
    const legacyIdempotent = config.idempotentHint;
    const legacyDestructive = config.destructiveHint;

    if (
      Array.isArray(annotationInput.toolsets) &&
      annotationInput.toolsets.length > 0
    ) {
      logger.warning(
        {
          toolName,
          providedToolsets: annotationInput.toolsets,
          resolvedToolsets: toolsets,
        },
        "Tool annotations specified 'toolsets', but toolset membership is derived from YAML toolset mappings. Ignoring provided values.",
      );
    }

    // Remove any externally provided toolsets to prevent divergence from configured mappings
    delete annotationInput.toolsets;

    const mergedCustomMetadata = this.mergeCustomMetadata(
      annotationInput.customMetadata,
      config.metadata,
    );

    const resolvedAnnotations: ToolAnnotations = {
      ...annotationInput,
      title: annotationInput.title ?? this.formatToolTitle(toolName),
      domain: annotationInput.domain ?? config.domain,
      category: annotationInput.category ?? config.category,
      readOnlyHint:
        annotationInput.readOnlyHint ??
        legacyReadOnly ??
        config.security?.readOnly ??
        true,
      openWorldHint: annotationInput.openWorldHint ?? legacyOpenWorld,
      idempotentHint: annotationInput.idempotentHint ?? legacyIdempotent,
      destructiveHint: annotationInput.destructiveHint ?? legacyDestructive,
      toolsets,
    };

    if (mergedCustomMetadata) {
      resolvedAnnotations.customMetadata = mergedCustomMetadata;
    }

    return resolvedAnnotations;
  }

  private mergeCustomMetadata(
    annotationsMetadata: unknown,
    toolMetadata?: Record<string, unknown>,
  ): Record<string, unknown> | undefined {
    const candidates = [annotationsMetadata, toolMetadata].filter(
      (value): value is Record<string, unknown> =>
        value !== null && typeof value === "object" && !Array.isArray(value),
    );

    if (candidates.length === 0) {
      return undefined;
    }

    return Object.assign({}, ...candidates);
  }

  /**
   * Format tool name into a human-readable title
   * @param toolName - Tool name
   * @returns Formatted title
   * @private
   */
  private formatToolTitle(toolName: string): string {
    return toolName
      .split(/[_-]/)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  }

  // ============================================================================
  // Configuration Parsing Methods (moved from YamlConfigBuilder)
  // ============================================================================

  /**
   * Build configuration from multiple sources
   * @param sources - Array of configuration sources
   * @param options - Merge options
   * @param context - Request context
   * @returns Built configuration
   */
  async buildFromSources(
    sources: ConfigSource[],
    options?: ConfigMergeOptions,
    context?: RequestContext,
  ): Promise<ConfigBuildResult> {
    const operationContext =
      context ||
      requestContextService.createRequestContext({
        operation: "ToolConfigBuilder.buildFromSources",
      });

    return ErrorHandler.tryCatch(
      async () => {
        logger.info(
          operationContext,
          `Building YAML configuration from sources: ${sources.length} sources`,
        );

        const filePaths = await this.resolveAllFilePaths(
          sources,
          operationContext,
        );
        const configs = await this.loadAllConfigurations(
          filePaths,
          operationContext,
        );
        const mergedConfig = await this.mergeConfigurations(
          configs,
          options,
          operationContext,
        );

        const stats = {
          sourcesLoaded: filePaths.length,
          sourcesMerged: configs.length,
          toolsTotal: Object.keys(mergedConfig.tools || {}).length,
          toolsetsTotal: Object.keys(mergedConfig.toolsets || {}).length,
          sourcesTotal: Object.keys(mergedConfig.sources || {}).length,
        };

        logger.info(
          {
            ...operationContext,
            ...stats,
          },
          "YAML configuration built successfully",
        );

        return {
          success: true,
          config: mergedConfig,
          stats,
          resolvedFilePaths: filePaths,
        };
      },
      {
        operation: "ToolConfigBuilder.buildFromSources",
        context: operationContext,
        errorCode: JsonRpcErrorCode.ConfigurationError,
      },
    );
  }

  /**
   * Resolve all file paths from sources
   * @private
   */
  private async resolveAllFilePaths(
    sources: ConfigSource[],
    context: RequestContext,
  ): Promise<string[]> {
    const allPaths: string[] = [];

    for (const source of sources) {
      try {
        const paths = await this.resolveSourcePaths(source);
        allPaths.push(...paths);
      } catch (error) {
        if (source.required) {
          throw error;
        }
        logger.warning(
          context,
          `Optional source not found: ${source.path} (${source.type})`,
        );
      }
    }

    // Remove duplicates
    return [...new Set(allPaths)];
  }

  /**
   * Resolve paths for a single source
   * @private
   */
  private async resolveSourcePaths(source: ConfigSource): Promise<string[]> {
    switch (source.type) {
      case "file":
        return this.resolveFilePath(source.path);

      case "directory":
        return this.resolveDirectoryPaths(source.path);

      case "glob":
        return this.resolveGlobPaths(source.path, source.baseDir);

      default:
        throw new McpError(
          JsonRpcErrorCode.ConfigurationError,
          `Unknown source type: ${(source as unknown as { type: string }).type}`,
        );
    }
  }

  /**
   * Resolve a single file path
   * @private
   */
  private resolveFilePath(filePath: string): string[] {
    const resolvedPath = resolve(filePath);
    if (!existsSync(resolvedPath)) {
      throw new McpError(
        JsonRpcErrorCode.ConfigurationError,
        `Configuration file not found: ${resolvedPath}`,
      );
    }
    return [resolvedPath];
  }

  /**
   * Resolve directory paths
   * @private
   */
  private resolveDirectoryPaths(directoryPath: string): string[] {
    const resolvedDir = resolve(directoryPath);
    if (!existsSync(resolvedDir)) {
      throw new McpError(
        JsonRpcErrorCode.ConfigurationError,
        `Configuration directory not found: ${resolvedDir}`,
      );
    }

    const pattern = join(resolvedDir, "**/*.{yaml,yml}");
    return glob.sync(pattern, { absolute: true });
  }

  /**
   * Resolve glob paths
   * @private
   */
  private resolveGlobPaths(pattern: string, baseDir?: string): string[] {
    const searchPattern = baseDir ? join(baseDir, pattern) : pattern;
    const paths = glob.sync(searchPattern, { absolute: true });

    if (paths.length === 0) {
      throw new McpError(
        JsonRpcErrorCode.ConfigurationError,
        `No files found matching pattern: ${searchPattern}`,
      );
    }

    return paths;
  }

  /**
   * Load all configurations from file paths
   * @private
   */
  private async loadAllConfigurations(
    filePaths: string[],
    context: RequestContext,
  ): Promise<SqlToolsConfig[]> {
    const configs: SqlToolsConfig[] = [];

    for (const filePath of filePaths) {
      try {
        logger.debug(context, `Loading configuration from: ${filePath}`);
        const result = await ConfigParser.parseYamlFile(filePath, context);

        if (result.success && result.config) {
          configs.push(result.config);
        } else {
          logger.error(
            context,
            `Failed to load configuration from: ${filePath}`,
          );
        }
      } catch (error) {
        logger.error(
          context,
          `Error loading configuration from: ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
      }
    }

    return configs;
  }

  /**
   * Merge multiple configurations
   * Uses environment-configured merge options from config.yamlMergeOptions as defaults
   * @private
   */
  private async mergeConfigurations(
    configs: SqlToolsConfig[],
    options?: ConfigMergeOptions,
    context?: RequestContext,
  ): Promise<SqlToolsConfig> {
    if (configs.length === 0) {
      throw new McpError(
        JsonRpcErrorCode.ConfigurationError,
        "No valid configurations to merge",
      );
    }

    if (configs.length === 1) {
      return configs[0]!;
    }

    // Use environment-configured merge options as defaults, allow explicit overrides
    const mergeOptions: ConfigMergeOptions = {
      ...config.yamlMergeOptions,
      ...options,
    };

    logger.debug(
      context || {},
      `Merging ${configs.length} configurations with options: ${JSON.stringify(mergeOptions)}`,
    );

    const mergedConfig: SqlToolsConfig = {
      sources: {},
      tools: {},
      toolsets: {},
      metadata: {},
    };

    // Merge each configuration
    for (const configToMerge of configs) {
      await this.mergeIntoTarget(
        mergedConfig,
        configToMerge,
        mergeOptions,
        context,
      );
    }

    // Validate merged configuration if requested
    if (mergeOptions.validateMerged) {
      await this.validateMergedConfiguration(mergedConfig, context);
    }

    return mergedConfig;
  }

  /**
   * Merge a configuration into the target
   * @private
   */
  private async mergeIntoTarget(
    target: SqlToolsConfig,
    source: SqlToolsConfig,
    options: ConfigMergeOptions,
    context?: RequestContext,
  ): Promise<void> {
    // Merge sources
    if (source.sources) {
      if (!target.sources) {
        target.sources = {};
      }
      for (const [sourceName, sourceConfig] of Object.entries(source.sources)) {
        if (target.sources[sourceName]) {
          if (!options.allowDuplicateSources) {
            throw new McpError(
              JsonRpcErrorCode.ConfigurationError,
              `Duplicate source name: ${sourceName}`,
            );
          }
          logger.warning(
            context || {},
            `Overriding existing source: ${sourceName}`,
          );
        }
        target.sources[sourceName] = sourceConfig;
      }
    }

    // Merge tools
    if (source.tools) {
      if (!target.tools) {
        target.tools = {};
      }
      for (const [toolName, toolConfig] of Object.entries(source.tools)) {
        if (target.tools[toolName]) {
          if (!options.allowDuplicateTools) {
            throw new McpError(
              JsonRpcErrorCode.ConfigurationError,
              `Duplicate tool name: ${toolName}`,
            );
          }
          logger.warning(
            context || {},
            `Overriding existing tool: ${toolName}`,
          );
        }
        target.tools[toolName] = toolConfig;
      }
    }

    // Merge toolsets
    if (source.toolsets) {
      if (!target.toolsets) {
        target.toolsets = {};
      }
      for (const [toolsetName, toolsetConfig] of Object.entries(
        source.toolsets,
      )) {
        if (target.toolsets[toolsetName]) {
          if (options.mergeArrays) {
            // Merge tool arrays
            target.toolsets[toolsetName].tools = [
              ...target.toolsets[toolsetName].tools,
              ...toolsetConfig.tools,
            ];
          } else {
            // Replace with new toolset
            target.toolsets[toolsetName] = toolsetConfig;
          }
        } else {
          target.toolsets[toolsetName] = toolsetConfig;
        }
      }
    }

    // Merge metadata
    if (source.metadata) {
      if (!target.metadata) {
        target.metadata = {};
      }
      target.metadata = { ...target.metadata, ...source.metadata };
    }
  }

  /**
   * Validate the merged configuration
   * @private
   */
  private async validateMergedConfiguration(
    config: SqlToolsConfig,
    context?: RequestContext,
  ): Promise<void> {
    // Validate that all tool sources exist (only if both sections exist)
    if (config.tools && config.sources) {
      for (const [toolName, toolConfig] of Object.entries(config.tools)) {
        if (!config.sources[toolConfig.source]) {
          throw new McpError(
            JsonRpcErrorCode.ConfigurationError,
            `Tool '${toolName}' references non-existent source '${toolConfig.source}'`,
          );
        }
      }
    }

    // Validate that all toolset tools exist (only if both sections exist)
    if (config.toolsets && config.tools) {
      for (const [toolsetName, toolsetConfig] of Object.entries(
        config.toolsets,
      )) {
        for (const toolName of toolsetConfig.tools) {
          if (!config.tools[toolName]) {
            throw new McpError(
              JsonRpcErrorCode.ConfigurationError,
              `Toolset '${toolsetName}' references non-existent tool '${toolName}'`,
            );
          }
        }
      }
    }

    logger.debug(context || {}, "Merged configuration validated successfully");
  }

  // Static factory methods for convenience
  static async fromFile(
    filePath: string,
    context?: RequestContext,
  ): Promise<ConfigBuildResult> {
    const builder = ToolConfigBuilder.getInstance();
    return builder.buildFromSources(
      [{ type: "file", path: filePath, required: true }],
      undefined,
      context,
    );
  }

  static async fromFiles(
    filePaths: string[],
    context?: RequestContext,
  ): Promise<ConfigBuildResult> {
    const builder = ToolConfigBuilder.getInstance();
    const sources = filePaths.map((path) => ({
      type: "file" as const,
      path,
      required: true,
    }));
    return builder.buildFromSources(sources, undefined, context);
  }

  static async fromDirectory(
    directoryPath: string,
    context?: RequestContext,
  ): Promise<ConfigBuildResult> {
    const builder = ToolConfigBuilder.getInstance();
    return builder.buildFromSources(
      [{ type: "directory", path: directoryPath, required: true }],
      undefined,
      context,
    );
  }

  static async fromGlob(
    pattern: string,
    baseDir?: string,
    context?: RequestContext,
  ): Promise<ConfigBuildResult> {
    const builder = ToolConfigBuilder.getInstance();
    return builder.buildFromSources(
      [{ type: "glob", path: pattern, baseDir, required: true }],
      undefined,
      context,
    );
  }
}

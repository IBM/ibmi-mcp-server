/**
 * @fileoverview YAML Tool Processor - Simplified pipeline for YAML tool processing
 * Consolidates YAML parsing, tool configuration creation, and dependency management
 * into a single, cohesive class with a simple 3-step workflow: parse → create → cache
 *
 * @module src/ibmi-mcp-server/utils/yaml/yamlToolProcessor
 */

import { createHash } from "crypto";
import { watch, FSWatcher, existsSync, statSync, readFileSync } from "fs";
import { readFile } from "fs/promises";
import { resolve } from "path";
import { config } from "@/config/index.js";
import { SourceManager } from "../../services/sourceManager.js";
import { SQLToolFactory } from "./toolFactory.js";
import { ToolsetManager } from "./toolsetManager.js";
import { ErrorHandler, logger } from "@/utils/internal/index.js";
import {
  requestContextService,
  RequestContext,
} from "@/utils/internal/requestContext.js";
import { JsonRpcErrorCode, McpError } from "@/types-global/errors.js";
import {
  ProcessedSQLTool,
  CachedToolConfig,
  ConfigSource,
  ConfigBuildResult,
} from "./types.js";
import { SqlToolsConfig } from "../../schemas/index.js";
import { SourceConfig } from "../../schemas/index.js";
import { ToolConfigBuilder } from "./toolConfigBuilder.js";

/**
 * Result of tool processing operation
 */
export interface ToolProcessingResult {
  /** Whether processing was successful */
  success: boolean;
  /** Number of tools processed */
  toolCount: number;
  /** Number of sources registered */
  sourceCount: number;
  /** Error message if processing failed */
  error?: string;
  /** Processing statistics */
  stats?: {
    toolsProcessed: number;
    sourcesRegistered: number;
    toolsetMappings: number;
  };
}

/**
 * YAML Tool Processor - Simplified pipeline for YAML tool processing
 *
 * Provides a clean, simple workflow:
 * 1. Parse YAML tools from configuration
 * 2. Create standardized tool configurations
 * 3. Cache configurations for fast registration
 *
 * Internally manages all dependencies and complexity, exposing only a simple API.
 */
export class ToolProcessor {
  private sourceManager: SourceManager;
  private toolsetManager: ToolsetManager;
  private isInitialized: boolean = false;
  private yamlConfig: SqlToolsConfig | null = null;
  private processedTools: ProcessedSQLTool[] = [];
  private toolConfigs: CachedToolConfig[] = [];

  // File watching capabilities
  private static changeCallbacks: Map<
    string,
    (filePath: string, eventType: string, context?: RequestContext) => void
  > = new Map();
  private static nextCallbackId = 1;
  private static watchers: Map<string, FSWatcher> = new Map();
  private static watchedPaths: Set<string> = new Set();
  /** Debounce timers keyed by watched file path (editors often emit multiple events). */
  private static reloadDebounceTimers: Map<string, NodeJS.Timeout> = new Map();
  /** SHA-256 of last observed file content; used to skip no-op reloads. */
  private static watchedFileHashes: Map<string, string> = new Map();
  /** Settle window before hashing/reloading after a filesystem event. */
  private static readonly RELOAD_DEBOUNCE_MS = 300;

  constructor() {
    // Initialize internal dependencies
    this.sourceManager = SourceManager.getInstance();
    this.toolsetManager = ToolsetManager.getInstance();
  }

  /**
   * Initialize the processor and all internal dependencies
   * @param context - Request context for logging
   */
  async initialize(context?: RequestContext): Promise<void> {
    const operationContext =
      context ||
      requestContextService.createRequestContext({
        operation: "ToolProcessor.initialize",
      });

    return ErrorHandler.tryCatch(
      async () => {
        if (this.isInitialized) {
          logger.debug(operationContext, "ToolProcessor already initialized");
          return;
        }

        logger.info(operationContext, "Initializing YAML Tool Processor");

        // Validate configuration
        if (!config.toolsYamlPath) {
          throw new McpError(
            JsonRpcErrorCode.InvalidParams,
            "YAML tools path not configured. Please set TOOLS_YAML_PATH.",
            { toolsYamlPath: config.toolsYamlPath },
          );
        }

        // Parse YAML configuration
        this.yamlConfig = await this.parseYamlConfig(operationContext);

        // Register sources with source manager
        if (this.yamlConfig.sources) {
          await this.registerSources(this.yamlConfig.sources, operationContext);
        }

        // Initialize SQL executor
        SQLToolFactory.initialize(this.sourceManager);

        // Initialize toolset manager
        await this.toolsetManager.initialize(this.yamlConfig, operationContext);

        this.isInitialized = true;
        logger.info(
          operationContext,
          "YAML Tool Processor initialized successfully",
        );
      },
      {
        operation: "ToolProcessor.initialize",
        context: operationContext,
        errorCode: JsonRpcErrorCode.InternalError,
      },
    );
  }

  /**
   * Process YAML tools into standardized configurations
   * @param context - Request context for logging
   * @returns Tool processing result
   */
  async processTools(context?: RequestContext): Promise<ToolProcessingResult> {
    const operationContext =
      context ||
      requestContextService.createRequestContext({
        operation: "ToolProcessor.processTools",
      });

    return ErrorHandler.tryCatch(
      async () => {
        if (!this.isInitialized) {
          throw new McpError(
            JsonRpcErrorCode.InternalError,
            "ToolProcessor not initialized. Call initialize() first.",
          );
        }

        logger.info(
          operationContext,
          "Processing YAML tools into configurations",
        );

        // Process tools from YAML config
        this.processedTools = await this.processYamlTools(operationContext);

        // Apply toolsets filtering if specified
        let filteredTools = this.processedTools;

        const selectedToolsets = config.selectedToolsets;
        if (
          selectedToolsets &&
          Array.isArray(selectedToolsets) &&
          selectedToolsets.length > 0
        ) {
          const availableToolsets = Object.keys(
            this.yamlConfig?.toolsets || {},
          );
          const unknownToolsets = selectedToolsets.filter(
            (name) => !availableToolsets.includes(name),
          );
          if (unknownToolsets.length > 0) {
            logger.warning(
              operationContext,
              `Unknown toolsets requested: ${unknownToolsets.join(", ")}. Available toolsets: ${availableToolsets.join(", ")}`,
            );
          }

          const configBuilder = ToolConfigBuilder.getInstance();
          filteredTools = configBuilder.filterToolsByToolsets(
            this.processedTools,
            selectedToolsets,
          );

          logger.info(
            operationContext,
            `Filtered tools by toolsets [${selectedToolsets.join(", ")}]: ${filteredTools.length}/${this.processedTools.length} tools selected`,
          );
        }

        // Create tool configurations
        this.toolConfigs = await this.createToolConfigurations(
          filteredTools,
          operationContext,
        );

        const result: ToolProcessingResult = {
          success: true,
          toolCount: this.toolConfigs.length,
          sourceCount: Object.keys(this.yamlConfig?.sources || {}).length,
          stats: {
            toolsProcessed: this.processedTools.length,
            sourcesRegistered: this.sourceManager.getRegisteredSources().length,
            toolsetMappings: this.toolsetManager.getToolsetStats().totalTools,
          },
        };

        logger.info(
          { ...operationContext, result },
          `YAML tools processed successfully: ${result.toolCount} tools, ${result.sourceCount} sources`,
        );

        return result;
      },
      {
        operation: "ToolProcessor.processTools",
        context: operationContext,
        errorCode: JsonRpcErrorCode.InternalError,
      },
    );
  }

  /**
   * Get processed tool configurations (for caching)
   * @returns Array of cached tool configurations
   */
  getToolConfigurations(): CachedToolConfig[] {
    return [...this.toolConfigs];
  }

  /**
   * Parse YAML configuration from configured path
   * @param context - Request context for logging
   * @returns Parsed YAML configuration
   * @private
   */
  private async parseYamlConfig(
    context: RequestContext,
  ): Promise<SqlToolsConfig> {
    const configBuilder = ToolConfigBuilder.getInstance();

    // Configure sources based on configured path
    const sources = this.buildConfigSources(config.toolsYamlPath!, context);

    // Build configuration using ToolConfigBuilder
    const configResult = await configBuilder.buildFromSources(
      sources,
      undefined,
      context,
    );

    if (!configResult.success || !configResult.config) {
      const errorMessage = configResult.errors
        ? configResult.errors.join(", ")
        : "Unknown build error";
      throw new McpError(
        JsonRpcErrorCode.InvalidParams,
        `Failed to build YAML configuration: ${errorMessage}`,
        {
          toolsYamlPath: config.toolsYamlPath,
          errors: configResult.errors,
        },
      );
    }

    if (configResult.resolvedFilePaths?.length) {
      ToolProcessor.startWatching(configResult.resolvedFilePaths, context);
    }

    return configResult.config;
  }

  /**
   * Build configuration sources based on YAML tools path type
   * @param yamlToolsPath - Path to YAML tools
   * @param context - Request context
   * @private
   */
  private buildConfigSources(
    yamlToolsPath: string | string[],
    context: RequestContext,
  ): ConfigSource[] {
    if (Array.isArray(yamlToolsPath)) {
      return yamlToolsPath.map((path) => ({
        type: "file" as const,
        path,
        required: true,
      }));
    }

    const resolvedPath = resolve(yamlToolsPath);
    if (existsSync(resolvedPath)) {
      const stats = statSync(resolvedPath);
      if (stats.isDirectory()) {
        logger.debug(context, `Detected directory path: ${yamlToolsPath}`);
        return [{ type: "directory", path: yamlToolsPath, required: true }];
      } else {
        logger.debug(context, `Detected file path: ${yamlToolsPath}`);
        return [{ type: "file", path: yamlToolsPath, required: true }];
      }
    } else {
      // Path doesn't exist, treat as file (ToolConfigBuilder will validate appropriately)
      return [{ type: "file", path: yamlToolsPath, required: true }];
    }
  }

  /**
   * Register sources from YAML configuration
   * @param sources - Source configurations
   * @param context - Request context
   * @private
   */
  private async registerSources(
    sources: Record<string, SourceConfig>,
    context: RequestContext,
  ): Promise<void> {
    logger.info(context, `Registering ${Object.keys(sources).length} sources`);

    for (const [sourceName, sourceConfig] of Object.entries(sources)) {
      await this.sourceManager.registerSource(
        sourceName,
        sourceConfig,
        context,
      );
    }
  }

  /**
   * Process tools from YAML configuration
   * @param context - Request context
   * @returns Array of processed tools
   * @private
   */
  private async processYamlTools(
    context: RequestContext,
  ): Promise<ProcessedSQLTool[]> {
    const processedTools: ProcessedSQLTool[] = [];

    if (!this.yamlConfig?.tools) {
      return processedTools;
    }

    for (const [toolName, toolConfig] of Object.entries(
      this.yamlConfig.tools,
    )) {
      if (toolConfig.enabled === false) {
        logger.debug(context, `Skipping disabled tool: ${toolName}`);
        continue;
      }

      const sourceConfig = this.yamlConfig.sources?.[toolConfig.source];
      if (!sourceConfig) {
        throw new McpError(
          JsonRpcErrorCode.InvalidParams,
          `Tool '${toolName}' references non-existent source '${toolConfig.source}'`,
        );
      }

      // Find toolsets that contain this tool
      const toolsets: string[] = [];
      if (this.yamlConfig.toolsets) {
        for (const [toolsetName, toolsetConfig] of Object.entries(
          this.yamlConfig.toolsets,
        )) {
          if (toolsetConfig.tools.includes(toolName)) {
            toolsets.push(toolsetName);
          }
        }
      }

      processedTools.push({
        name: toolName,
        config: toolConfig,
        source: sourceConfig,
        toolsets,
        metadata: {
          name: toolName,
          description: toolConfig.description,
          domain: toolConfig.domain,
          category: toolConfig.category,
          toolsets,
        },
      });
    }

    return processedTools;
  }

  /**
   * Create tool configurations from processed tools using standardized builder
   * @param processedTools - Array of processed tools
   * @param context - Request context
   * @returns Array of cached tool configurations
   * @private
   */
  private async createToolConfigurations(
    processedTools: ProcessedSQLTool[],
    context: RequestContext,
  ): Promise<CachedToolConfig[]> {
    const configBuilder = ToolConfigBuilder.getInstance();

    const toolConfigs: CachedToolConfig[] = [];

    for (const processedTool of processedTools) {
      const toolConfig = await configBuilder.buildToolConfig(
        processedTool.name,
        processedTool.config,
        processedTool.toolsets,
        context,
      );

      toolConfigs.push(toolConfig);
    }

    return toolConfigs;
  }

  // ============================================================================
  // Simplified File Watching (moved from YamlConfigBuilder)
  // ============================================================================

  /**
   * Register a callback to be called when YAML configuration files change
   * @param callback - Function to call when files change
   * @returns Callback ID for unregistering
   */
  static registerChangeCallback(
    callback: (
      filePath: string,
      eventType: string,
      context?: RequestContext,
    ) => void,
  ): string {
    const id = `callback_${ToolProcessor.nextCallbackId++}`;
    ToolProcessor.changeCallbacks.set(id, callback);
    return id;
  }

  /** SHA-256 hash of YAML file contents for change detection. */
  private static hashFileContent(content: Buffer | string): string {
    return createHash("sha256").update(content).digest("hex");
  }

  /**
   * After debounce, skip reload when file content is unchanged; otherwise notify.
   */
  private static async handleWatchedFileChange(
    filePath: string,
    eventType: string,
    context?: RequestContext,
  ): Promise<void> {
    const logContext = context || {};

    try {
      const content = await readFile(filePath);
      const hash = ToolProcessor.hashFileContent(content);
      const previous = ToolProcessor.watchedFileHashes.get(filePath);
      if (previous === hash) {
        logger.debug(
          logContext,
          `YAML file unchanged (content hash match), skipping reload: ${filePath}`,
        );
        return;
      }
      ToolProcessor.watchedFileHashes.set(filePath, hash);
    } catch (error) {
      logger.warning(
        logContext,
        `Could not hash YAML file for change detection: ${filePath}. ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    logger.info(logContext, `YAML file changed (${eventType}): ${filePath}`);

    for (const callback of ToolProcessor.changeCallbacks.values()) {
      try {
        callback(filePath, eventType, context);
      } catch (error) {
        logger.error(
          logContext,
          `Error in YAML change callback: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /**
   * Attach an fs watcher to one file. Throws if the file cannot be watched.
   */
  private static armWatcher(filePath: string, context?: RequestContext): void {
    const watcher = watch(filePath, { persistent: false }, (eventType) => {
      const existingTimer = ToolProcessor.reloadDebounceTimers.get(filePath);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      const timer = setTimeout(() => {
        ToolProcessor.reloadDebounceTimers.delete(filePath);
        ToolProcessor.rearmWatcher(filePath, context);
        void ToolProcessor.handleWatchedFileChange(
          filePath,
          eventType,
          context,
        );
      }, ToolProcessor.RELOAD_DEBOUNCE_MS);

      ToolProcessor.reloadDebounceTimers.set(filePath, timer);
    });

    ToolProcessor.watchers.set(filePath, watcher);
    ToolProcessor.watchedPaths.add(filePath);
  }

  /**
   * Replace the watcher on a path. Atomic saves (write a temp file, then
   * rename it over the original) leave the old watcher attached to the
   * replaced inode, so it never fires again unless it is re-created.
   */
  private static rearmWatcher(
    filePath: string,
    context?: RequestContext,
  ): void {
    try {
      ToolProcessor.watchers.get(filePath)?.close();
    } catch {
      // Ignore errors when closing watchers
    }
    ToolProcessor.watchers.delete(filePath);
    ToolProcessor.watchedPaths.delete(filePath);

    try {
      ToolProcessor.armWatcher(filePath, context);
    } catch (error) {
      logger.warning(
        context || {},
        `Failed to re-watch YAML file: ${filePath}. ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Start watching YAML configuration files for changes
   * @param filePaths - Array of file paths to watch
   * @param context - Request context for logging
   */
  static startWatching(filePaths: string[], context?: RequestContext): void {
    if (!config.yamlAutoReload) {
      return;
    }

    for (const filePath of filePaths) {
      if (ToolProcessor.watchedPaths.has(filePath)) {
        continue; // Already watching this path
      }

      try {
        // Seed hash so the first no-op save after watch starts is skipped.
        try {
          const initial = readFileSync(filePath);
          ToolProcessor.watchedFileHashes.set(
            filePath,
            ToolProcessor.hashFileContent(initial),
          );
        } catch {
          // Best-effort; first readable event establishes the baseline.
        }

        ToolProcessor.armWatcher(filePath, context);

        logger.debug(context || {}, `Started watching YAML file: ${filePath}`);
      } catch (error) {
        logger.warning(
          context || {},
          `Failed to watch YAML file: ${filePath}. ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /**
   * Stop watching all files and clear watchers
   */
  static clearWatchers(): void {
    for (const timer of ToolProcessor.reloadDebounceTimers.values()) {
      clearTimeout(timer);
    }
    ToolProcessor.reloadDebounceTimers.clear();
    ToolProcessor.watchedFileHashes.clear();

    for (const watcher of ToolProcessor.watchers.values()) {
      try {
        watcher.close();
      } catch {
        // Ignore errors when closing watchers
      }
    }
    ToolProcessor.watchers.clear();
    ToolProcessor.watchedPaths.clear();
    ToolProcessor.changeCallbacks.clear();
  }

  // Static factory methods for convenience (replaces YamlConfigBuilder static methods)
  static async fromFile(
    filePath: string,
    context?: RequestContext,
  ): Promise<ConfigBuildResult> {
    return ToolConfigBuilder.fromFile(filePath, context);
  }

  static async fromDirectory(
    directoryPath: string,
    context?: RequestContext,
  ): Promise<ConfigBuildResult> {
    return ToolConfigBuilder.fromDirectory(directoryPath, context);
  }

  static async fromGlob(
    pattern: string,
    baseDir?: string,
    context?: RequestContext,
  ): Promise<ConfigBuildResult> {
    return ToolConfigBuilder.fromGlob(pattern, baseDir, context);
  }
}

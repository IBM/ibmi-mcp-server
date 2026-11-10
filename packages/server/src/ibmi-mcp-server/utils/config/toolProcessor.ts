/**
 * @fileoverview YAML Tool Processor - Simplified pipeline for YAML tool processing
 * Consolidates YAML parsing, tool configuration creation, and dependency management
 * into a single, cohesive class with a simple 3-step workflow: parse → create → cache
 *
 * @module src/ibmi-mcp-server/utils/yaml/yamlToolProcessor
 */

import { createHash } from "crypto";
import { watch, FSWatcher, readFileSync } from "fs";
import { dirname, resolve } from "path";
import { config } from "@/config/index.js";
import { SourceManager } from "../../services/sourceManager.js";
import { getAllToolDefinitions } from "../../tools/index.js";
import { SQLToolFactory } from "./toolFactory.js";
import { ToolsetManager } from "./toolsetManager.js";
import { ErrorHandler, logger } from "@/utils/internal/index.js";
import {
  requestContextService,
  RequestContext,
} from "@/utils/internal/requestContext.js";
import { JsonRpcErrorCode, McpError } from "@/types-global/errors.js";
import { ProcessedSQLTool, CachedToolConfig } from "./types.js";
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
  /** The processed tools that will be registered. */
  private selectedTools: ProcessedSQLTool[] = [];
  private toolConfigs: CachedToolConfig[] = [];

  // File watching capabilities
  private static changeCallbacks: Map<string, () => unknown> = new Map();
  private static nextCallbackId = 1;
  /** One watcher per watched directory. */
  private static watchers: Map<string, FSWatcher> = new Map();
  /** The one debounce timer: a burst of file events is one reload. */
  private static reloadDebounceTimer: NodeJS.Timeout | undefined;
  /** Reloads run one after another, never concurrently. */
  private static reloadQueue: Promise<void> = Promise.resolve();
  /** Hash of the tool files as last loaded; used to skip no-op reloads. */
  private static loadedFingerprint: string | undefined;
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

        // Parse and check everything before touching the source and toolset
        // managers: a configuration that is rejected (at startup or on a
        // reload) must leave the previous one in place. Building the tool
        // configurations is a check too (an invalid `pattern` fails there),
        // and the toolset manager checks its references before it replaces
        // anything.
        this.yamlConfig = await this.parseYamlConfig(operationContext);
        this.processedTools = this.processYamlTools(operationContext);
        this.selectedTools = this.selectTools(operationContext);
        this.assertNoBuiltinToolNames();
        this.toolConfigs = await this.createToolConfigurations(
          this.selectedTools,
          operationContext,
        );
        await this.toolsetManager.initialize(this.yamlConfig, operationContext);

        // Register sources with source manager
        if (this.yamlConfig.sources) {
          await this.registerSources(this.yamlConfig.sources, operationContext);
        }

        // Initialize SQL executor
        SQLToolFactory.initialize(this.sourceManager);

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
   * Summarize and log the tool configurations that initialize() built
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
    const configResult = await ToolConfigBuilder.fromPath(
      config.toolsYamlPath!,
      context,
    );

    ToolProcessor.startWatching(
      config.toolsYamlPath!,
      configResult.resolvedFilePaths,
    );

    return configResult.config;
  }

  /**
   * Narrow the processed tools to the selected toolsets (`--toolsets`,
   * `SELECTED_TOOLSETS`), when there is a selection.
   * @param context - Request context
   * @throws {McpError} when a selected toolset does not exist
   * @private
   */
  private selectTools(context: RequestContext): ProcessedSQLTool[] {
    const selectedToolsets = config.selectedToolsets;
    if (!selectedToolsets || selectedToolsets.length === 0) {
      return this.processedTools;
    }

    const availableToolsets = Object.keys(this.yamlConfig?.toolsets || {});
    const unknownToolsets = selectedToolsets.filter(
      (name) => !availableToolsets.includes(name),
    );
    if (unknownToolsets.length > 0) {
      throw new McpError(
        JsonRpcErrorCode.ConfigurationError,
        `Unknown toolsets requested: ${unknownToolsets.join(", ")}. Available toolsets: ${availableToolsets.join(", ")}`,
      );
    }

    const selectedTools = ToolConfigBuilder.getInstance().filterToolsByToolsets(
      this.processedTools,
      selectedToolsets,
    );

    logger.info(
      context,
      `Filtered tools by toolsets [${selectedToolsets.join(", ")}]: ${selectedTools.length}/${this.processedTools.length} tools selected`,
    );

    return selectedTools;
  }

  /**
   * A YAML tool must not take the name of a built-in tool that is registered
   * with the current settings.
   * @throws {McpError} naming the tools at fault
   * @private
   */
  private assertNoBuiltinToolNames(): void {
    const builtinNames = getAllToolDefinitions()
      .filter(({ enabled = true }) =>
        typeof enabled === "function" ? enabled() : enabled,
      )
      .map((tool) => tool.name);
    const collisions = this.selectedTools
      .map((tool) => tool.name)
      .filter((name) => builtinNames.includes(name));

    if (collisions.length > 0) {
      throw new McpError(
        JsonRpcErrorCode.ConfigurationError,
        collisions
          .map(
            (name) =>
              `YAML tool '${name}' has the same name as the built-in tool '${name}'.`,
          )
          .join(" ") + " Rename the YAML tool or leave the built-in tool off.",
      );
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
  private processYamlTools(context: RequestContext): ProcessedSQLTool[] {
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
  // File watching
  //
  // Directories are watched, not files: a directory watcher survives atomic
  // saves (write a temp file, rename it over the original) and reports files
  // that are added or removed.
  // ============================================================================

  /**
   * Register a callback to be called when the YAML tool files have changed
   * @param callback - Function to call; the next reload waits for it to settle
   * @returns Callback ID for unregistering
   */
  static registerChangeCallback(callback: () => unknown): string {
    const id = `callback_${ToolProcessor.nextCallbackId++}`;
    ToolProcessor.changeCallbacks.set(id, callback);
    return id;
  }

  /** SHA-256 over the paths and contents of the tool files. */
  private static fingerprint(filePaths: string[]): string {
    const hash = createHash("sha256");
    for (const filePath of filePaths) {
      hash.update(filePath).update("\0").update(readFileSync(filePath));
    }
    return hash.digest("hex");
  }

  /**
   * Run the change callbacks, unless the tools path still resolves to the
   * same files with the same content.
   */
  private static async reloadIfChanged(toolsPath: string): Promise<void> {
    let fingerprint: string | undefined;
    try {
      fingerprint = ToolProcessor.fingerprint(
        ToolConfigBuilder.getInstance().resolveToolsPath(toolsPath),
      );
    } catch {
      // The path no longer resolves (its file was removed, say). That is a
      // change; the reload reports what is wrong.
    }
    // Nothing is logged for a no-op: the log may be in a watched directory.
    if (fingerprint === ToolProcessor.loadedFingerprint) {
      return;
    }
    ToolProcessor.loadedFingerprint = fingerprint;

    // Each reload is its own operation in the log.
    const context = requestContextService.createRequestContext({
      operation: "YamlToolFilesChanged",
      toolsPath,
    });
    logger.info(context, `YAML tool files changed: ${toolsPath}`);

    for (const callback of ToolProcessor.changeCallbacks.values()) {
      try {
        await callback();
      } catch (error) {
        logger.error(
          context,
          `Error in YAML change callback: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /**
   * Watch the directories that hold the YAML tool files. Called after every
   * successful load, so the watched directories follow the loaded files.
   * @param toolsPath - The configured tools path (file, directory or glob)
   * @param filePaths - The files it resolved to
   */
  static startWatching(toolsPath: string, filePaths: string[]): void {
    if (!config.yamlAutoReload) {
      return;
    }

    try {
      ToolProcessor.loadedFingerprint = ToolProcessor.fingerprint(filePaths);
    } catch {
      // Best-effort; the first event establishes the baseline.
    }

    // A directory source is watched as a whole, so that files added anywhere
    // under it are seen. For a file or a glob, the directories of its files.
    const recursive =
      ToolConfigBuilder.sourceForPath(toolsPath).type === "directory";
    const directories = new Set(
      recursive ? [resolve(toolsPath)] : filePaths.map((file) => dirname(file)),
    );

    for (const [directory, watcher] of ToolProcessor.watchers) {
      if (!directories.has(directory)) {
        watcher.close();
        ToolProcessor.watchers.delete(directory);
      }
    }

    for (const directory of directories) {
      if (ToolProcessor.watchers.has(directory)) {
        continue;
      }

      try {
        const watcher = watch(
          directory,
          { persistent: false, recursive },
          () => {
            clearTimeout(ToolProcessor.reloadDebounceTimer);
            ToolProcessor.reloadDebounceTimer = setTimeout(() => {
              ToolProcessor.reloadQueue = ToolProcessor.reloadQueue.then(() =>
                ToolProcessor.reloadIfChanged(toolsPath),
              );
            }, ToolProcessor.RELOAD_DEBOUNCE_MS);
          },
        );
        // Without a listener, a watcher error (the directory was removed)
        // would be an uncaught exception.
        watcher.on("error", (error) => {
          logger.warning(
            {},
            `Stopped watching YAML directory: ${directory}. ${error.message}`,
          );
          watcher.close();
          ToolProcessor.watchers.delete(directory);
        });
        ToolProcessor.watchers.set(directory, watcher);

        logger.debug({}, `Started watching YAML directory: ${directory}`);
      } catch (error) {
        logger.warning(
          {},
          `Failed to watch YAML directory: ${directory}. ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /**
   * Stop watching all files and clear watchers
   */
  static clearWatchers(): void {
    clearTimeout(ToolProcessor.reloadDebounceTimer);
    ToolProcessor.loadedFingerprint = undefined;

    for (const watcher of ToolProcessor.watchers.values()) {
      try {
        watcher.close();
      } catch {
        // Ignore errors when closing watchers
      }
    }
    ToolProcessor.watchers.clear();
    ToolProcessor.changeCallbacks.clear();
  }
}

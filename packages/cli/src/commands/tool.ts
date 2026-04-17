/**
 * @fileoverview Dynamic YAML tool execution command.
 *
 * `ibmi tool <name> [options]` — run any YAML-defined tool from the CLI.
 *
 * The command uses allowUnknownOption() to accept arbitrary tool-specific
 * options, then resolves them against the YAML parameter definitions.
 *
 * Supports --dry-run to show the resolved SQL and parameters without executing.
 *
 * @module cli/commands/tool
 */

import { Command } from "commander";
import {
  loadYamlTools,
  type YamlToolConfig,
} from "../utils/yaml-loader.js";
import {
  registerToolOptions,
  optsToParams,
  validateRequiredParams,
} from "../utils/yaml-to-commander.js";
import {
  getFormat,
  isStreaming,
  createCliContext,
} from "../utils/command-helpers.js";
import { resolveSystem } from "../config/resolver.js";
import { connectSystem } from "../utils/connection.js";
import {
  renderOutput,
  renderNdjson,
  renderError,
} from "../formatters/output.js";
import { ExitCode, classifyError, ErrorCode } from "../utils/exit-codes.js";

/**
 * Register `ibmi tool <name>` — dynamic YAML tool execution.
 */
export function registerToolCommand(program: Command): void {
  program
    .command("tool <name>")
    .description("Run a YAML-defined tool by name")
    .option("--dry-run", "Show resolved SQL and parameters without executing")
    .allowUnknownOption()
    .allowExcessArguments()
    .action(async (name: string, _opts: Record<string, unknown>, cmd: Command) => {
      const format = getFormat(cmd);

      try {
        // Resolve --tools paths from global options
        const globalOpts = cmd.optsWithGlobals();
        const toolsOpt = globalOpts["tools"] as string | undefined;
        if (!toolsOpt) {
          renderError(
            new Error(
              "No tools path specified. Use --tools <path> to specify YAML tool file(s).",
            ),
            format,
            undefined,
            ErrorCode.USAGE_ERROR,
          );
          process.exitCode = ExitCode.USAGE;
          return;
        }

        const paths = toolsOpt.split(",").map((p) => p.trim());
        const config = loadYamlTools(paths);

        // Find the tool
        const tool = config.tools[name];
        if (!tool) {
          const available = Object.keys(config.tools).join(", ");
          renderError(
            new Error(
              `Tool '${name}' not found. Available tools: ${available || "(none)"}`,
            ),
            format,
            undefined,
            ErrorCode.NOT_FOUND,
          );
          process.exitCode = ExitCode.USAGE;
          return;
        }

        // Build a sub-command with tool-specific options and re-parse
        const toolParams = resolveToolParams(cmd, tool);

        // Validate required parameters
        const missing = validateRequiredParams(toolParams, tool.parameters);
        if (missing.length > 0) {
          const flags = missing.map((n) => `--${n.replace(/_/g, "-")}`).join(", ");
          renderError(
            new Error(`Missing required parameter(s): ${flags}`),
            format,
            undefined,
            ErrorCode.USAGE_ERROR,
          );
          process.exitCode = ExitCode.USAGE;
          return;
        }

        // Dry-run: show SQL and parameters
        const dryRun = globalOpts["dryRun"] || _opts["dryRun"];
        if (dryRun) {
          await handleDryRun(name, tool, toolParams, cmd);
          return;
        }

        // Execute the tool
        await executeTool(name, tool, toolParams, cmd);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        const classified = classifyError(error);
        renderError(error, format, undefined, classified.errorCode);
        process.exitCode = classified.exitCode;
      }
    });
}

/**
 * Parse tool-specific options from the raw argv using a dynamic Commander sub-command.
 */
function resolveToolParams(
  cmd: Command,
  tool: YamlToolConfig,
): Record<string, unknown> {
  if (tool.parameters.length === 0) return {};

  // Build a temporary command used only to absorb dynamic tool-specific options.
  // allowExcessArguments: cmd.args still contains the bound <name> positional,
  //   which this throwaway parser doesn't declare. Without this, Commander
  //   emits "too many arguments. Expected 0 arguments but got 1." to stderr.
  // configureOutput: suppress any diagnostic writes from this internal parser —
  //   real user-facing errors surface through validateRequiredParams below.
  const tempCmd = new Command("temp");
  tempCmd.exitOverride();
  tempCmd.allowUnknownOption();
  tempCmd.allowExcessArguments();
  tempCmd.configureOutput({
    writeErr: () => {},
    writeOut: () => {},
  });
  registerToolOptions(tempCmd, tool.parameters);

  const rawArgs = cmd.args ?? [];
  try {
    tempCmd.parse(rawArgs, { from: "user" });
  } catch {
    // Commander may throw for unrecognized options or type coercion failures;
    // validateRequiredParams surfaces missing values with actionable flag names.
  }

  return optsToParams(tempCmd.opts(), tool.parameters);
}

/**
 * Handle --dry-run: show resolved SQL and parameters.
 */
async function handleDryRun(
  name: string,
  tool: YamlToolConfig,
  params: Record<string, unknown>,
  cmd: Command,
): Promise<void> {
  const format = getFormat(cmd);

  if (!tool.statement) {
    renderError(
      new Error(`Tool '${name}' has no SQL statement defined.`),
      format,
      undefined,
      ErrorCode.USAGE_ERROR,
    );
    process.exitCode = ExitCode.USAGE;
    return;
  }

  if (format === "json") {
    renderOutput(
      [
        {
          tool: name,
          dry_run: true,
          sql: tool.statement.trim(),
          parameters: params,
        },
      ],
      format,
      { rowCount: 1, command: `tool:${name}` },
    );
    return;
  }

  // Human-readable dry-run output
  const globalOpts = cmd.optsWithGlobals();
  const systemName = globalOpts["system"] as string | undefined;
  const lines: string[] = [];

  if (systemName) {
    lines.push(`Would execute on [${systemName}]:`);
  } else {
    lines.push("Would execute:");
  }

  lines.push("────────────────────────────────────────");
  lines.push(tool.statement.trim());

  if (Object.keys(params).length > 0) {
    lines.push("");
    lines.push(`Parameters: ${JSON.stringify(params)}`);
  }

  lines.push("────────────────────────────────────────");
  process.stdout.write(lines.join("\n") + "\n");
}

/**
 * Execute a YAML tool against the connected system.
 */
async function executeTool(
  name: string,
  tool: YamlToolConfig,
  params: Record<string, unknown>,
  cmd: Command,
): Promise<void> {
  const format = getFormat(cmd);
  const stream = isStreaming(cmd);
  const globalOpts = cmd.optsWithGlobals();

  if (!tool.statement) {
    renderError(
      new Error(`Tool '${name}' has no SQL statement defined.`),
      format,
      undefined,
      ErrorCode.USAGE_ERROR,
    );
    process.exitCode = ExitCode.USAGE;
    return;
  }

  // Resolve system and connect
  const resolved = resolveSystem(globalOpts["system"] as string | undefined);
  const cleanup = await connectSystem(resolved);

  try {
    const ctx = createCliContext(name);
    const startTime = Date.now();

    // Dynamic import to avoid loading server infrastructure until execution time
    const { ParameterProcessor, IBMiConnectionPool } = await import(
      "@ibm/ibmi-mcp-server/services"
    );

    // Process SQL parameters (BindingValue from mapepire-js)
    let processedSql: string;
    let bindingParams: (string | number | (string | number)[])[] = [];

    if (tool.parameters.length > 0 && Object.keys(params).length > 0) {
      // Convert YamlToolParameter[] to the SqlToolParameter shape expected by ParameterProcessor
      const result = await ParameterProcessor.process(
        tool.statement,
        params,
        tool.parameters,
        { context: ctx },
      );
      processedSql = result.sql;
      bindingParams = result.parameters;
    } else {
      processedSql = tool.statement;
    }

    // Execute the query
    const result = await IBMiConnectionPool.executeQuery(
      processedSql,
      bindingParams,
      ctx,
    );

    const elapsedMs = Date.now() - startTime;
    const data = (result.data ?? []) as Record<string, unknown>[];

    // NDJSON streaming: one JSON object per line
    if (stream && format === "json") {
      renderNdjson(data);
      return;
    }

    renderOutput(data, format, {
      rowCount: data.length,
      elapsedMs,
      system: resolved,
      command: `tool:${name}`,
    });
  } finally {
    await cleanup();
  }
}

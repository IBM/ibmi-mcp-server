/**
 * @fileoverview Dynamic YAML tool execution command.
 *
 * `ibmi tool <name> [options]` — run any YAML-defined tool from the CLI.
 *
 * The command uses allowUnknownOption() to accept arbitrary tool-specific
 * options, then resolves them against the YAML parameter definitions;
 * options the tool does not define are rejected as usage errors.
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
  withConnection,
  withOutput,
} from "../utils/command-helpers.js";
import {
  renderOutput,
  renderError,
  renderMessage,
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
        let toolParams: Record<string, unknown>;
        try {
          toolParams = resolveToolParams(cmd, tool);
        } catch (err) {
          // Unknown flag, missing option value, or a value of the wrong type
          const message = err instanceof Error ? err.message : String(err);
          renderError(
            new Error(message.replace(/^error: /, "")),
            format,
            undefined,
            ErrorCode.USAGE_ERROR,
          );
          process.exitCode = ExitCode.USAGE;
          return;
        }

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
 * Throws when an option is not defined by the tool, is missing its value, or
 * has a value of the wrong type.
 */
function resolveToolParams(
  cmd: Command,
  tool: YamlToolConfig,
): Record<string, unknown> {
  // Build a temporary command used only to parse dynamic tool-specific options.
  // allowExcessArguments: cmd.args still contains the bound <name> positional,
  //   which this throwaway parser doesn't declare. Without this, Commander
  //   emits "too many arguments. Expected 0 arguments but got 1." to stderr.
  // exitOverride + configureOutput: parse errors are thrown to the caller,
  //   which renders them, instead of being printed by this internal parser.
  const tempCmd = new Command("temp");
  tempCmd.exitOverride();
  tempCmd.allowExcessArguments();
  tempCmd.configureOutput({
    writeErr: () => {},
    writeOut: () => {},
  });
  registerToolOptions(tempCmd, tool.parameters);

  tempCmd.parse(cmd.args ?? [], { from: "user" });

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
  const statement = tool.statement.trim();

  await withOutput(cmd, async () => {
    if (format === "json") {
      renderOutput(
        [
          {
            tool: name,
            dry_run: true,
            sql: statement,
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
    lines.push(statement);

    if (Object.keys(params).length > 0) {
      lines.push("");
      lines.push(`Parameters: ${JSON.stringify(params)}`);
    }

    lines.push("────────────────────────────────────────");
    renderMessage(lines.join("\n"), format);
  });
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
  if (!tool.statement) {
    renderError(
      new Error(`Tool '${name}' has no SQL statement defined.`),
      getFormat(cmd),
      undefined,
      ErrorCode.USAGE_ERROR,
    );
    process.exitCode = ExitCode.USAGE;
    return;
  }
  const statement = tool.statement;

  // withConnection applies --output, --watch and --stream like every other command
  await withConnection(cmd, `tool:${name}`, async (resolved, ctx) => {
    // Confirm execution if system requires it
    if (resolved.config.confirm && process.stdin.isTTY) {
      const { promptLine } = await import("../config/credentials.js");
      const answer = await promptLine(
        `Execute tool '${name}' on [${resolved.name}]? (y/N) `,
      );
      if (answer.toLowerCase() !== "y") {
        throw new Error("Execution cancelled by user");
      }
    }

    // Dynamic import to avoid loading server infrastructure until execution time
    const { ParameterProcessor, IBMiConnectionPool } = await import(
      "@ibm/ibmi-mcp-server/services"
    );

    // Process SQL parameters (BindingValue from mapepire-js)
    let processedSql: string;
    let bindingParams: (string | number | (string | number)[])[] = [];

    // Always process when the tool defines parameters (as the server does), so
    // an optional parameter that was not passed is still bound.
    if (tool.parameters.length > 0) {
      const result = await ParameterProcessor.process(
        statement,
        params,
        tool.parameters,
        { context: ctx },
      );
      processedSql = result.sql;
      bindingParams = result.parameters;
    } else {
      processedSql = statement;
    }

    // Enforce read-only: tool security config + system readOnly override
    const effectiveReadOnly =
      (tool.security?.readOnly ?? true) || resolved.config.readOnly;

    if (effectiveReadOnly) {
      const { SqlSecurityValidator } = await import(
        "@ibm/ibmi-mcp-server/services"
      );
      SqlSecurityValidator.validateQuery(
        processedSql,
        {
          readOnly: true,
          maxQueryLength: tool.security?.maxQueryLength,
          forbiddenKeywords: tool.security?.forbiddenKeywords,
        },
        ctx,
      );
    }

    // Execute the query, honoring YAML-declared fetch controls. When
    // fetchAllRows is set we paginate; rowsToFetch (if present) becomes
    // the per-fetch page size. Otherwise rowsToFetch caps the single-shot
    // execute() call.
    const result = tool.fetchAllRows
      ? await IBMiConnectionPool.executeQueryWithPagination(
          processedSql,
          bindingParams,
          ctx,
          tool.rowsToFetch,
        )
      : await IBMiConnectionPool.executeQuery(
          processedSql,
          bindingParams,
          ctx,
          tool.rowsToFetch,
        );

    // The paginated path returns a `truncated` flag when the server hit
    // MAX_PAGINATION_ROWS. Surface it in the output footer so users know
    // the result set was clipped and how to get more.
    const truncated = "truncated" in result && result.truncated === true;

    return {
      data: (result.data ?? []) as Record<string, unknown>[],
      meta: {
        hasMore: truncated,
        truncationHint: truncated
          ? "(result capped — raise IBMI_PAGINATION_MAX_ROWS or narrow the query)"
          : undefined,
      },
    };
  });
}

/**
 * @fileoverview Discovery commands for YAML-defined tools.
 *
 * - `ibmi tools` — List all available tools
 * - `ibmi tools show <name>` — Show detailed info for a single tool
 * - `ibmi toolsets` — List all toolsets
 *
 * These are read-only commands that parse YAML files without connecting to a system.
 * @module cli/commands/tools-list
 */

import { Command } from "commander";
import {
  loadYamlTools,
  buildToolsetMap,
  type YamlToolsConfig,
  type YamlToolParameter,
} from "../utils/yaml-loader.js";
import { getFormat } from "../utils/command-helpers.js";
import {
  renderOutput,
  renderError,
  renderMessage,
} from "../formatters/output.js";
import { ExitCode } from "../utils/exit-codes.js";

/**
 * Resolve the --tools paths from command options.
 * Falls back to the default tools/ directory relative to the package root.
 */
function resolveToolsPaths(cmd: Command): string[] {
  const opts = cmd.optsWithGlobals();
  const toolsOpt = opts["tools"] as string | undefined;
  if (toolsOpt) {
    return toolsOpt.split(",").map((p) => p.trim());
  }
  return [];
}

/**
 * Load YAML tools config from CLI options, with error handling.
 */
function loadToolsConfig(cmd: Command): YamlToolsConfig | null {
  const paths = resolveToolsPaths(cmd);
  if (paths.length === 0) {
    process.stderr.write(
      "No tools path specified. Use --tools <path> to specify YAML tool file(s) or directory.\n",
    );
    return null;
  }
  return loadYamlTools(paths);
}

/**
 * Register `ibmi tools` — list available YAML tools.
 */
export function registerToolsCommand(program: Command): void {
  const toolsCmd = program
    .command("tools")
    .description("List available YAML-defined tools")
    .option("--toolset <name>", "Filter by toolset name");

  // ibmi tools (default: list all)
  toolsCmd.action((opts, cmd: Command) => {
    const format = getFormat(cmd);
    try {
      const config = loadToolsConfig(cmd);
      if (!config) {
        process.exitCode = ExitCode.USAGE;
        return;
      }

      const toolsetMap = buildToolsetMap(config.toolsets);
      const toolsetFilter = opts["toolset"] as string | undefined;

      const rows: Record<string, unknown>[] = [];
      for (const [name, tool] of Object.entries(config.tools)) {
        if (tool.enabled === false) continue;

        const toolsets = toolsetMap.get(name) ?? [];

        // Filter by toolset if specified
        if (toolsetFilter && !toolsets.includes(toolsetFilter)) continue;

        rows.push({
          TOOL: name,
          TOOLSET: toolsets.join(", ") || "-",
          DESCRIPTION: tool.description,
          PARAMS: tool.parameters.length,
          READ_ONLY: tool.security?.readOnly ?? tool.annotations?.["readOnlyHint"] ?? true,
        });
      }

      if (rows.length === 0) {
        renderMessage(
          toolsetFilter
            ? `No tools found in toolset '${toolsetFilter}'.`
            : "No tools found.",
          format,
        );
        return;
      }

      renderOutput(rows, format, { rowCount: rows.length });
    } catch (err) {
      renderError(
        err instanceof Error ? err : new Error(String(err)),
        format,
      );
      process.exitCode = ExitCode.GENERAL;
    }
  });

  // ibmi tools show <name>
  toolsCmd
    .command("show <name>")
    .description("Show detailed information for a tool")
    .action((name: string, _opts: unknown, cmd: Command) => {
      const format = getFormat(cmd);
      try {
        const config = loadToolsConfig(cmd);
        if (!config) {
          process.exitCode = ExitCode.USAGE;
          return;
        }

        const tool = config.tools[name];
        if (!tool) {
          renderError(
            new Error(
              `Tool '${name}' not found. Use 'ibmi tools --tools <path>' to list available tools.`,
            ),
            format,
          );
          process.exitCode = ExitCode.USAGE;
          return;
        }

        const toolsetMap = buildToolsetMap(config.toolsets);
        const toolsets = toolsetMap.get(name) ?? [];

        if (format === "json") {
          // JSON: output structured data
          renderOutput(
            [
              {
                name,
                description: tool.description,
                source: tool.source,
                toolsets,
                readOnly: tool.security?.readOnly ?? true,
                parameters: tool.parameters,
                sql: tool.statement ?? null,
              },
            ],
            format,
            { rowCount: 1 },
          );
        } else {
          // Human-readable detail view
          const lines: string[] = [];
          lines.push(`Tool: ${name}`);
          lines.push(`Description: ${tool.description}`);
          lines.push(`Source: ${tool.source}`);
          if (toolsets.length > 0) {
            lines.push(`Toolsets: ${toolsets.join(", ")}`);
          }
          lines.push(
            `Read-only: ${tool.security?.readOnly ?? tool.annotations?.["readOnlyHint"] ?? true}`,
          );
          lines.push("");

          // Parameters
          if (tool.parameters.length > 0) {
            lines.push("Parameters:");
            for (const p of tool.parameters) {
              lines.push(formatParameter(p));
            }
          } else {
            lines.push("Parameters: (none)");
          }
          lines.push("");

          // SQL
          if (tool.statement) {
            lines.push("SQL:");
            lines.push(tool.statement.trim());
          }

          process.stdout.write(lines.join("\n") + "\n");
        }
      } catch (err) {
        renderError(
          err instanceof Error ? err : new Error(String(err)),
          format,
        );
        process.exitCode = ExitCode.GENERAL;
      }
    });
}

/**
 * Format a parameter for human-readable display.
 */
function formatParameter(p: YamlToolParameter): string {
  const parts: string[] = [];
  parts.push(`  --${p.name.replace(/_/g, "-")}`);
  parts.push(`(${p.type})`);

  if (p.required) parts.push("[required]");
  if (p.default !== undefined) parts.push(`default: ${JSON.stringify(p.default)}`);
  if (p.enum && p.enum.length > 0) {
    parts.push(`choices: ${p.enum.join(", ")}`);
  }
  if (p.description) parts.push(`— ${p.description}`);

  return parts.join(" ");
}

/**
 * Register `ibmi toolsets` — list available toolsets.
 */
export function registerToolsetsCommand(program: Command): void {
  program
    .command("toolsets")
    .description("List available toolsets")
    .action((_opts, cmd: Command) => {
      const format = getFormat(cmd);
      try {
        const config = loadToolsConfig(cmd);
        if (!config) {
          process.exitCode = ExitCode.USAGE;
          return;
        }

        const rows: Record<string, unknown>[] = [];
        for (const [name, ts] of Object.entries(config.toolsets)) {
          rows.push({
            TOOLSET: name,
            TOOLS: ts.tools.length,
            DESCRIPTION: ts.description ?? ts.title ?? "-",
          });
        }

        if (rows.length === 0) {
          renderMessage("No toolsets found.", format);
          return;
        }

        renderOutput(rows, format, { rowCount: rows.length });
      } catch (err) {
        renderError(
          err instanceof Error ? err : new Error(String(err)),
          format,
        );
        process.exitCode = ExitCode.GENERAL;
      }
    });
}

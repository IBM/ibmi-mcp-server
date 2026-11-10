/**
 * @fileoverview Shared utilities for CLI command implementations.
 * Provides the `withConnection` wrapper that handles the full lifecycle
 * of system resolution, connection setup, execution, rendering, and cleanup,
 * and the `withOutput` wrapper that applies --output and --watch.
 *
 * @module cli/utils/command-helpers
 */

import { Command } from "commander";
import type { OutputFormat, ResolvedSystem } from "../config/types.js";
import type { RequestContext } from "@ibm/ibmi-mcp-server/context";
import { loadConfig } from "../config/loader.js";
import { resolveSystem } from "../config/resolver.js";
import { connectSystem } from "./connection.js";
import {
  classifyError,
  ErrorCode,
  ExitCode,
  type ExitCodeValue,
} from "./exit-codes.js";
import {
  detectFormat,
  renderOutput,
  renderNdjson,
  renderError,
  setOutputFile,
  finalizeOutput,
  type OutputMeta,
} from "../formatters/output.js";

/**
 * Get the effective output format from parent command options and config.
 *
 * Priority: --raw → --format → config format → TTY auto-detect.
 */
export function getFormat(cmd: Command): OutputFormat {
  const opts = cmd.optsWithGlobals();
  let configFormat: OutputFormat | undefined;
  try {
    configFormat = loadConfig().format;
  } catch {
    // Config may not exist — fall through to auto-detect
  }
  return detectFormat(
    opts["format"] as OutputFormat | undefined,
    opts["raw"] as boolean | undefined,
    configFormat,
  );
}

/**
 * Check if --stream mode is enabled.
 */
export function isStreaming(cmd: Command): boolean {
  const opts = cmd.optsWithGlobals();
  return opts["stream"] === true;
}

/**
 * Create a minimal RequestContext for CLI tool execution.
 * Avoids importing the full server utils (which would trigger OpenTelemetry).
 */
export function createCliContext(toolName: string): RequestContext {
  return {
    requestId: `cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    operation: "CliToolExecution",
    toolName,
  };
}

/** Result shape expected from command actions. */
export interface CommandResult {
  data: Record<string, unknown>[];
  meta?: Partial<OutputMeta>;
  /**
   * Exit code to set after rendering, for a command that ran but whose
   * result reports a failure (e.g. `validate` finding a syntax error).
   */
  exitCode?: ExitCodeValue;
}

/**
 * Run a command body with the global --output and --watch options applied.
 *
 * With --output, everything the body renders is written to the file instead
 * of stdout. With --watch <seconds>, the body repeats at that interval until
 * Ctrl+C; combined with --output, the file is overwritten on every run.
 */
export async function withOutput(
  cmd: Command,
  run: () => Promise<void>,
): Promise<void> {
  const opts = cmd.optsWithGlobals();
  const outputPath = opts["output"] as string | undefined;
  const watchInterval =
    opts["watch"] !== undefined
      ? parseInt(opts["watch"] as string, 10)
      : undefined;

  // An unusable interval would otherwise silently run the command once
  if (watchInterval !== undefined && !(watchInterval > 0)) {
    renderError(
      new Error(
        `Invalid --watch value: "${opts["watch"]}". Must be a positive integer (seconds).`,
      ),
      getFormat(cmd),
      undefined,
      ErrorCode.USAGE_ERROR,
    );
    process.exitCode = ExitCode.USAGE;
    return;
  }

  const runOnce = async () => {
    setOutputFile(outputPath);
    try {
      await run();
    } finally {
      finalizeOutput();
    }
  };

  if (watchInterval === undefined) {
    await runOnce();
    return;
  }

  // Clear the screen between runs for human-readable formats; leave
  // JSON/NDJSON clean for piping, and stdout alone when writing to a file.
  const clearScreen = getFormat(cmd) !== "json" && !outputPath;
  await runWithWatch(runOnce, clearScreen, watchInterval);
}

/**
 * Standard command action wrapper.
 *
 * Handles the full lifecycle:
 * 1. Resolve target system from --system flag / env / config
 * 2. Connect (set env vars for IBMiConnectionPool)
 * 3. Run the action callback
 * 4. Render output in the requested format (or NDJSON if --stream)
 * 5. Cleanup (close pool) in finally block
 * 6. Set semantic exit code on error
 *
 * --output and --watch are applied by {@link withOutput}; when watching, the
 * whole connect-execute-render cycle repeats.
 */
export async function withConnection(
  cmd: Command,
  toolName: string,
  action: (
    resolved: ResolvedSystem,
    ctx: RequestContext,
  ) => Promise<CommandResult>,
): Promise<void> {
  const format = getFormat(cmd);
  const stream = isStreaming(cmd);
  const opts = cmd.optsWithGlobals();

  await withOutput(cmd, async () => {
    let cleanup: (() => Promise<void>) | undefined;
    let resolved: ResolvedSystem | undefined;

    try {
      resolved = resolveSystem(opts["system"] as string | undefined);
      cleanup = await connectSystem(resolved);

      const ctx = createCliContext(toolName);
      const startTime = Date.now();
      const result = await action(resolved, ctx);
      const elapsedMs = Date.now() - startTime;

      if (stream && format === "json") {
        // NDJSON streaming: one JSON object per line, no envelope
        renderNdjson(result.data);
      } else {
        renderOutput(result.data, format, {
          rowCount: result.data.length,
          elapsedMs,
          system: resolved,
          command: toolName,
          ...result.meta,
        });
      }
      if (result.exitCode) process.exitCode = result.exitCode;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const classified = classifyError(error);
      renderError(error, format, resolved, classified.errorCode);
      process.exitCode = classified.exitCode;
    } finally {
      if (cleanup) await cleanup();
    }
  });
}

/**
 * Strip sensitive flags (e.g. --password) from argv before displaying.
 */
function sanitizeArgsForDisplay(args: string[]): string {
  const sensitiveFlags = ["--password"];
  const sanitized: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (sensitiveFlags.some((f) => arg === f || arg.startsWith(`${f}=`))) {
      if (!arg.includes("=")) i++; // skip next arg (the value)
      sanitized.push("--password ****");
      continue;
    }
    sanitized.push(arg);
  }
  return sanitized.join(" ");
}

/**
 * Run `runOnce` repeatedly at the specified interval.
 * Shows a timestamp header on stderr before each run. A failed run is
 * reported like any other and the watch continues. Ctrl+C exits cleanly.
 */
async function runWithWatch(
  runOnce: () => Promise<void>,
  clearScreen: boolean,
  intervalSeconds: number,
): Promise<void> {
  let running = true;

  // Primary SIGINT handler to stop the loop
  const handler = () => {
    running = false;
  };
  process.on("SIGINT", handler);

  try {
    while (running) {
      if (clearScreen) {
        process.stdout.write("\x1b[2J\x1b[H");
      }

      // Show timestamp header so the user knows when the last refresh happened
      const now = new Date().toLocaleString();
      const args = sanitizeArgsForDisplay(process.argv.slice(2));
      process.stderr.write(
        `Every ${intervalSeconds}s: ibmi ${args}  ${now}\n\n`,
      );

      await runOnce();
      // A failed run does not fail the watch
      process.exitCode = undefined;

      // Wait for the interval, but allow SIGINT to break out immediately
      if (running) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, intervalSeconds * 1000);
          const sigHandler = () => {
            clearTimeout(timer);
            running = false;
            resolve();
          };
          process.once("SIGINT", sigHandler);
          // Remove the per-iteration handler once the timer fires naturally
          setTimeout(
            () => {
              process.removeListener("SIGINT", sigHandler);
            },
            intervalSeconds * 1000 + 10,
          );
        });
      }
    }
  } finally {
    process.removeListener("SIGINT", handler);
  }
}

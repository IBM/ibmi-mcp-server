/**
 * @fileoverview Shared utilities for CLI command implementations.
 * Provides the `withConnection` wrapper that handles the full lifecycle
 * of system resolution, connection setup, execution, rendering, and cleanup.
 *
 * @module cli/utils/command-helpers
 */

import { Command } from "commander";
import type { OutputFormat, ResolvedSystem } from "../config/types.js";
import type { RequestContext } from "../../utils/internal/requestContext.js";
import { resolveSystem } from "../config/resolver.js";
import { connectSystem } from "./connection.js";
import { classifyError } from "./exit-codes.js";
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
 * Get the effective output format from parent command options.
 */
export function getFormat(cmd: Command): OutputFormat {
  const opts = cmd.optsWithGlobals();
  return detectFormat(
    opts["format"] as OutputFormat | undefined,
    opts["raw"] as boolean | undefined,
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
 * When --watch <seconds> is set, the connect-execute-render cycle repeats
 * at the given interval until Ctrl+C is received.
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
  const outputPath = opts["output"] as string | undefined;
  const watchInterval = opts["watch"] ? parseInt(opts["watch"] as string, 10) : undefined;

  if (outputPath) {
    setOutputFile(outputPath);
  }

  if (watchInterval && watchInterval > 0) {
    try {
      await runWithWatch(cmd, toolName, action, format, stream, watchInterval);
    } finally {
      if (outputPath) finalizeOutput();
    }
    return;
  }

  let cleanup: (() => Promise<void>) | undefined;
  let resolved: ResolvedSystem | undefined;

  try {
    resolved = resolveSystem(opts["system"] as string | undefined);
    cleanup = await connectSystem(resolved);

    const ctx = createCliContext(toolName);
    const startTime = Date.now();
    const result = await action(resolved, ctx);
    const elapsedMs = Date.now() - startTime;

    // NDJSON streaming: one JSON object per line, no envelope
    if (stream && format === "json") {
      renderNdjson(result.data);
      return;
    }

    renderOutput(result.data, format, {
      rowCount: result.data.length,
      elapsedMs,
      system: resolved,
      command: toolName,
      ...result.meta,
    });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    const classified = classifyError(error);
    renderError(error, format, resolved, classified.errorCode);
    process.exitCode = classified.exitCode;
  } finally {
    if (cleanup) await cleanup();
    if (outputPath) finalizeOutput();
  }
}

/**
 * Run a command repeatedly at the specified interval.
 * Clears the screen between runs in table/markdown/csv mode (not JSON/NDJSON,
 * which are intended for piping). Shows a timestamp header on stderr.
 * Ctrl+C exits cleanly.
 */
async function runWithWatch(
  cmd: Command,
  toolName: string,
  action: (resolved: ResolvedSystem, ctx: RequestContext) => Promise<CommandResult>,
  format: OutputFormat,
  stream: boolean,
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
      // Clear screen for human-readable formats; leave JSON/NDJSON clean for piping
      if (format !== "json") {
        process.stdout.write("\x1b[2J\x1b[H");
      }

      // Show timestamp header so the user knows when the last refresh happened
      const now = new Date().toLocaleString();
      const args = process.argv.slice(2).join(" ");
      process.stderr.write(`Every ${intervalSeconds}s: ibmi ${args}  ${now}\n\n`);

      // Run one connect-execute-render cycle
      let cleanup: (() => Promise<void>) | undefined;
      try {
        const opts = cmd.optsWithGlobals();
        const resolved = resolveSystem(opts["system"] as string | undefined);
        cleanup = await connectSystem(resolved);
        const ctx = createCliContext(toolName);
        const startTime = Date.now();
        const result = await action(resolved, ctx);
        const elapsedMs = Date.now() - startTime;

        if (stream && format === "json") {
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
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        const classified = classifyError(error);
        renderError(error, format, undefined, classified.errorCode);
      } finally {
        if (cleanup) await cleanup();
      }

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
          setTimeout(() => {
            process.removeListener("SIGINT", sigHandler);
          }, intervalSeconds * 1000 + 10);
        });
      }
    }
  } finally {
    process.removeListener("SIGINT", handler);
  }
}

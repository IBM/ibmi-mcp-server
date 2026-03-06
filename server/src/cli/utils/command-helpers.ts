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
import {
  detectFormat,
  renderOutput,
  renderError,
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
 * 4. Render output in the requested format
 * 5. Cleanup (close pool) in finally block
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
  let cleanup: (() => Promise<void>) | undefined;
  let resolved: ResolvedSystem | undefined;

  try {
    const opts = cmd.optsWithGlobals();
    resolved = resolveSystem(opts["system"] as string | undefined);
    cleanup = await connectSystem(resolved);

    const ctx = createCliContext(toolName);
    const startTime = Date.now();
    const result = await action(resolved, ctx);
    const elapsedMs = Date.now() - startTime;

    renderOutput(result.data, format, {
      rowCount: result.data.length,
      elapsedMs,
      system: resolved,
      ...result.meta,
    });
  } catch (err) {
    renderError(
      err instanceof Error ? err : new Error(String(err)),
      format,
      resolved,
    );
    process.exitCode = 1;
  } finally {
    if (cleanup) await cleanup();
  }
}

/**
 * @fileoverview Multi-system parallel execution for the IBM i CLI.
 * Creates a temporary SourceManager to run queries against multiple
 * systems in parallel using independent connection pools.
 * @module cli/utils/multi-connection
 */

import type { ResolvedSystem } from "../config/types.js";
import type { RequestContext } from "@ibm/ibmi-mcp-server/context";
import { resolvePassword } from "../config/credentials.js";
import { createCliContext, type CommandResult } from "./command-helpers.js";
import { classifyError, type ExitCodeValue } from "./exit-codes.js";

type SourceConfig = Parameters<
  InstanceType<
    typeof import("@ibm/ibmi-mcp-server/services").SourceManager
  >["registerSource"]
>[1];

/** Result from a single system in a multi-system execution. */
export interface MultiSystemResult {
  system: string;
  host: string;
  data: Record<string, unknown>[];
  rowCount: number;
  elapsedMs: number;
  error?: string;
  /** Exit code classified from the error, when the system failed. */
  exitCode?: ExitCodeValue;
}

/**
 * Execute an action against multiple systems in parallel using SourceManager.
 *
 * Creates a temporary SourceManager instance with one pool per system,
 * fans out the action via Promise.allSettled, and cleans up all pools.
 *
 * @param jdbcOptions - JDBC options for every system's pool
 *   (DB2i_JDBC_OPTIONS still overrides them, as for any source)
 */
export async function executeMultiSystem(
  systems: ResolvedSystem[],
  action: (
    sourceName: string,
    mgr: InstanceType<typeof import("@ibm/ibmi-mcp-server/services").SourceManager>,
    ctx: RequestContext,
  ) => Promise<CommandResult>,
  jdbcOptions?: SourceConfig["jdbc-options"],
): Promise<MultiSystemResult[]> {
  // Dynamic import to avoid pulling server modules into static CLI chain
  const { SourceManager } = await import("@ibm/ibmi-mcp-server/services");

  // Resolve passwords upfront (sequentially — interactive prompts can't interleave)
  const credentials: Map<string, string> = new Map();
  for (const sys of systems) {
    const password = await resolvePassword(
      sys.name,
      sys.config.password,
      sys.config.user,
      sys.config.host,
    );
    credentials.set(sys.name, password);
  }

  // Create a temporary SourceManager (not the singleton)
  const mgr = new SourceManager();

  try {
    // Register each system as a named source
    for (const sys of systems) {
      await mgr.registerSource(sys.name, {
        host: sys.config.host,
        user: sys.config.user,
        password: credentials.get(sys.name)!,
        port: sys.config.port,
        "ignore-unauthorized": sys.config.ignoreUnauthorized,
        ...(jdbcOptions ? { "jdbc-options": jdbcOptions } : {}),
      });
    }

    // Fan out in parallel
    const settled = await Promise.allSettled(
      systems.map(async (sys) => {
        const ctx = createCliContext(`multi_sql_${sys.name}`);
        const startTime = Date.now();
        const result = await action(sys.name, mgr, ctx);
        return {
          system: sys.name,
          host: sys.config.host,
          data: result.data,
          rowCount: result.data.length,
          elapsedMs: Date.now() - startTime,
        } satisfies MultiSystemResult;
      }),
    );

    // Map settled results
    return settled.map((outcome, i) => {
      if (outcome.status === "fulfilled") {
        return outcome.value;
      }
      const sys = systems[i]!;
      const error =
        outcome.reason instanceof Error
          ? outcome.reason
          : new Error(String(outcome.reason));
      return {
        system: sys.name,
        host: sys.config.host,
        data: [],
        rowCount: 0,
        elapsedMs: 0,
        error: error.message,
        exitCode: classifyError(error).exitCode,
      };
    });
  } finally {
    await mgr.closeAllSources();
  }
}

/**
 * @fileoverview Multi-system parallel execution for the IBM i CLI.
 * Creates a temporary SourceManager to run queries against multiple
 * systems in parallel using independent connection pools.
 * @module cli/utils/multi-connection
 */

import type { ResolvedSystem } from "../config/types.js";
import type { RequestContext } from "../../utils/internal/requestContext.js";
import { resolvePassword } from "../config/credentials.js";
import { createCliContext, type CommandResult } from "./command-helpers.js";

/** Result from a single system in a multi-system execution. */
export interface MultiSystemResult {
  system: string;
  host: string;
  data: Record<string, unknown>[];
  rowCount: number;
  elapsedMs: number;
  error?: string;
}

/**
 * Execute an action against multiple systems in parallel using SourceManager.
 *
 * Creates a temporary SourceManager instance with one pool per system,
 * fans out the action via Promise.allSettled, and cleans up all pools.
 */
export async function executeMultiSystem(
  systems: ResolvedSystem[],
  action: (
    sourceName: string,
    mgr: InstanceType<typeof import("../../ibmi-mcp-server/services/sourceManager.js").SourceManager>,
    ctx: RequestContext,
  ) => Promise<CommandResult>,
): Promise<MultiSystemResult[]> {
  // Dynamic import to avoid pulling server modules into static CLI chain
  const { SourceManager } = await import(
    "../../ibmi-mcp-server/services/sourceManager.js"
  );

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
      return {
        system: sys.name,
        host: sys.config.host,
        data: [],
        rowCount: 0,
        elapsedMs: 0,
        error:
          outcome.reason instanceof Error
            ? outcome.reason.message
            : String(outcome.reason),
      };
    });
  } finally {
    await mgr.closeAllSources();
  }
}

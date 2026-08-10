/**
 * @fileoverview Effective read-only policy for the singleton IBM i pool.
 *
 * The singleton pool's JDBC `access` backstop must reflect the *effective*
 * execute_sql read-only policy — which is seeded from the
 * `IBMI_EXECUTE_SQL_READONLY` env var but can be changed at runtime via
 * `configureExecuteSqlTool` (the CLI's only configuration path) — not a
 * snapshot of the env var alone. This module is the single shared source both
 * sides use: the tool config writes it, the pool reads it at (lazy) init.
 *
 * Lives in services/ (importing only config) so both `executeSql.tool.ts` and
 * `connectionPool.ts` can depend on it without a circular import.
 *
 * @module src/ibmi-mcp-server/services/executeSqlPolicy
 */

import { config } from "@/config/index.js";

let effectiveReadOnly: boolean = config.ibmi_executeSqlReadonly !== false;

/**
 * Record the effective read-only policy for the singleton pool.
 * Called by `configureExecuteSqlTool` whenever the tool config changes, and by
 * CLI commands (e.g. `ibmi tool`) that execute on the singleton pool without
 * going through execute_sql.
 */
export function setExecuteSqlReadOnlyPolicy(readOnly: boolean): void {
  effectiveReadOnly = readOnly;
}

/**
 * The effective read-only policy the singleton pool should enforce.
 * Read at pool initialization time (pools are created lazily, on first query,
 * after CLI/runtime configuration has been applied).
 */
export function isExecuteSqlReadOnlyPolicy(): boolean {
  return effectiveReadOnly;
}

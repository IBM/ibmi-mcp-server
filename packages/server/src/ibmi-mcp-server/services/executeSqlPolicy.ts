/**
 * @fileoverview Effective read-only policy for the singleton IBM i pool.
 *
 * The singleton pool's JDBC `access` backstop must reflect the *effective*
 * execute_sql read-only policy — which is seeded from the
 * `IBMI_EXECUTE_SQL_READONLY` env var but can be changed at runtime via
 * `configureExecuteSqlTool` (the CLI's only configuration path) — not a
 * snapshot of the env var alone. This module is the single shared source both
 * sides use: `configureExecuteSqlTool` writes it, the pool reads it at (lazy)
 * init.
 *
 * Operator pin: when `IBMI_EXECUTE_SQL_READONLY` is *explicitly set* to true
 * in the environment, it acts as a floor — runtime configuration cannot lower
 * the policy to write mode. When the variable is unset (the default), runtime
 * configuration is authoritative, which is what keeps CLI write paths
 * (`ibmi sql --no-read-only`, write-enabled YAML tools) working.
 *
 * Lives in services/ (importing only config) so both `executeSql.tool.ts` and
 * `connectionPool.ts` can depend on it without a circular import.
 *
 * @module src/ibmi-mcp-server/services/executeSqlPolicy
 */

import { config } from "@/config/index.js";

/**
 * True when the operator explicitly set IBMI_EXECUTE_SQL_READONLY=true.
 * An explicit pin cannot be overridden by runtime configuration — a shared
 * YAML tool declaring `security.readOnly: false` must not be able to strip
 * the JDBC backstop out from under an operator-level read-only guarantee.
 */
const ENV_PINNED_READONLY: boolean =
  process.env.IBMI_EXECUTE_SQL_READONLY !== undefined &&
  config.ibmi_executeSqlReadonly;

let effectiveReadOnly: boolean = config.ibmi_executeSqlReadonly;

/**
 * Record the effective read-only policy for the singleton pool.
 * Called by `configureExecuteSqlTool` whenever the tool config changes — the
 * single policy writer; other callers (e.g. the CLI's `ibmi tool`) go through
 * `configureExecuteSqlTool` so the tool config and the pool policy can never
 * disagree.
 */
export function setExecuteSqlReadOnlyPolicy(readOnly: boolean): void {
  effectiveReadOnly = ENV_PINNED_READONLY || readOnly;
}

/**
 * The effective read-only policy the singleton pool should enforce.
 * Read at pool initialization time (pools are created lazily, on first query,
 * after CLI/runtime configuration has been applied).
 */
export function isExecuteSqlReadOnlyPolicy(): boolean {
  return effectiveReadOnly;
}

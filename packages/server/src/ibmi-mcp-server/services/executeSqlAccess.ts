/**
 * @fileoverview execute_sql guardrail mode: the setting that decides which
 * statement shapes the ad-hoc `execute_sql` tool (MCP and `ibmi sql`) sends.
 *
 *   read       queries only (no side effects)               JDBC access=read call
 *   read-call  queries and CALL (routines may have effects)  JDBC access=read call
 *   write      anything the connection's user profile allows  JDBC access=all
 *
 * These are guardrails, not a security boundary: the IBM i user profile's
 * authority decides what a statement can actually do.
 *
 * Policy precedence: an explicitly set `IBMI_EXECUTE_SQL_ACCESS` is a ceiling
 * — runtime configuration (`configureExecuteSqlTool`, the CLI) can lower the
 * mode but never raise it. The deprecated `IBMI_EXECUTE_SQL_READONLY` only
 * seeds the default. With neither set, runtime configuration is authoritative.
 *
 * Lives in services/ (importing only config) so both `executeSql.tool.ts` and
 * `connectionPool.ts` can depend on it without a circular import.
 *
 * @module src/ibmi-mcp-server/services/executeSqlAccess
 */

import { config } from "@/config/index.js";
import {
  EXECUTE_SQL_ACCESS_LEVELS,
  type ExecuteSqlAccess,
} from "./executeSqlAccessLevels.js";

export {
  EXECUTE_SQL_ACCESS_LEVELS,
  parseExecuteSqlAccess,
  type ExecuteSqlAccess,
} from "./executeSqlAccessLevels.js";

/** Env var that sets the guardrail mode (a ceiling when set). */
export const EXECUTE_SQL_ACCESS_ENV = "IBMI_EXECUTE_SQL_ACCESS";

function rank(level: ExecuteSqlAccess): number {
  return EXECUTE_SQL_ACCESS_LEVELS.indexOf(level);
}

/** True when `a` permits at least everything `b` permits. */
export function accessAtLeast(
  a: ExecuteSqlAccess,
  b: ExecuteSqlAccess,
): boolean {
  return rank(a) >= rank(b);
}

/** The more restrictive of two modes. */
export function minAccess(
  a: ExecuteSqlAccess,
  b: ExecuteSqlAccess,
): ExecuteSqlAccess {
  return rank(a) <= rank(b) ? a : b;
}

/** Map the deprecated boolean `readOnly` flag onto a mode. */
export function accessFromLegacyReadOnly(
  readOnly: boolean | undefined,
): ExecuteSqlAccess | undefined {
  if (readOnly === undefined) return undefined;
  return readOnly ? "read" : "write";
}

/** The env ceiling (`IBMI_EXECUTE_SQL_ACCESS` when set), else `undefined`. */
export function getExecuteSqlAccessCeiling(): ExecuteSqlAccess | undefined {
  return config.ibmi_executeSqlAccessCeiling;
}

let effectiveAccess: ExecuteSqlAccess = config.ibmi_executeSqlAccess ?? "read";

/**
 * Record the requested mode, lowered to the env ceiling when one is set.
 * Called only by `configureExecuteSqlTool`, so the tool and the singleton
 * pool's JDBC access can never disagree.
 *
 * @returns The effective mode. Callers compare it with `requested` to detect
 *   (and surface) a downgrade.
 */
export function setExecuteSqlAccessPolicy(
  requested: ExecuteSqlAccess,
): ExecuteSqlAccess {
  const ceiling = getExecuteSqlAccessCeiling();
  effectiveAccess = ceiling ? minAccess(ceiling, requested) : requested;
  return effectiveAccess;
}

/**
 * The effective mode. The singleton pool reads it at (lazy) initialization,
 * after CLI/runtime configuration has been applied.
 */
export function getExecuteSqlAccessPolicy(): ExecuteSqlAccess {
  return effectiveAccess;
}

/**
 * JDBC `access` property for a mode. This is a first-keyword check inside
 * the jt400 driver in the Mapepire JVM, not a Db2 control: it does not see
 * writes inside a query (data-change table references, functions,
 * sequences). `read` keeps "read call" because the built-in tools share the
 * singleton pool and `generate_sql` issues `CALL QSYS2.GENERATE_SQL`.
 */
export function jdbcAccessFor(level: ExecuteSqlAccess): "read call" | "all" {
  return level === "write" ? "all" : "read call";
}

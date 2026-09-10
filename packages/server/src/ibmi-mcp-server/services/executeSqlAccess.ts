/**
 * @fileoverview execute_sql access mode: the single setting that decides what
 * the ad-hoc `execute_sql` tool (and the singleton IBM i pool it shares with
 * the built-in tools) may do.
 *
 *   read       SELECT and table/scalar functions only              JDBC access=read call
 *   read-call  read + CALL to stored procedures                    JDBC access=read call
 *   write      everything the connection user profile allows       JDBC access=all
 *
 * `read` keeps `read call` at the JDBC layer because `generate_sql` /
 * `describe_sql_object` share the singleton pool and issue
 * `CALL QSYS2.GENERATE_SQL`. The read vs read-call distinction is enforced by
 * the in-process parser and, when the parser cannot classify, by
 * QSYS2.PARSE_STATEMENT. An explicit `access` in `DB2i_JDBC_OPTIONS` remains
 * the final override of the JDBC value only; the SQL validator still enforces
 * the mode.
 *
 * Policy precedence: when `IBMI_EXECUTE_SQL_ACCESS` (or the deprecated
 * `IBMI_EXECUTE_SQL_READONLY`) is explicitly set in the environment it is a
 * ceiling — runtime configuration (`configureExecuteSqlTool`, the CLI, a YAML
 * tool's `security.readOnly`) can lower the level but never raise it. When the
 * variable is unset, runtime configuration is authoritative.
 *
 * Lives in services/ (importing only config) so both `executeSql.tool.ts` and
 * `connectionPool.ts` can depend on it without a circular import.
 *
 * @module src/ibmi-mcp-server/services/executeSqlAccess
 */

import { config } from "@/config/index.js";

/** Access levels, least to most permissive. */
export const EXECUTE_SQL_ACCESS_LEVELS = [
  "read",
  "read-call",
  "write",
] as const;

export type ExecuteSqlAccess = (typeof EXECUTE_SQL_ACCESS_LEVELS)[number];

/** Most restrictive level; the default and the fail-closed fallback. */
export const DEFAULT_EXECUTE_SQL_ACCESS: ExecuteSqlAccess = "read";

/** Env var that sets the access mode. */
export const EXECUTE_SQL_ACCESS_ENV = "IBMI_EXECUTE_SQL_ACCESS";

/** Deprecated boolean predecessor (true → read, false → write). */
export const LEGACY_READONLY_ENV = "IBMI_EXECUTE_SQL_READONLY";

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

/** The more restrictive of two levels. */
export function minAccess(
  a: ExecuteSqlAccess,
  b: ExecuteSqlAccess,
): ExecuteSqlAccess {
  return rank(a) <= rank(b) ? a : b;
}

/**
 * Parse a raw access-mode string (env var, CLI flag). Trims and lowercases.
 * Returns `undefined` for an unrecognised value so callers decide how loud to
 * be — the config layer falls back to `read` with a stderr warning.
 */
export function parseExecuteSqlAccess(
  raw: string | undefined,
): ExecuteSqlAccess | undefined {
  if (raw == null) return undefined;
  const v = raw.trim().toLowerCase();
  return (EXECUTE_SQL_ACCESS_LEVELS as readonly string[]).includes(v)
    ? (v as ExecuteSqlAccess)
    : undefined;
}

/** Map the deprecated boolean `readOnly` flag onto an access level. */
export function accessFromLegacyReadOnly(
  readOnly: boolean | undefined,
): ExecuteSqlAccess | undefined {
  if (readOnly === undefined) return undefined;
  return readOnly ? "read" : "write";
}

/**
 * Resolve an access level from a security config that may carry the new
 * `access` field, the deprecated `readOnly` boolean, or neither. `access`
 * wins when both are present; neither → `read` (fail-closed).
 */
export function resolveAccess(
  security: { access?: ExecuteSqlAccess; readOnly?: boolean } | undefined,
): ExecuteSqlAccess {
  return (
    security?.access ??
    accessFromLegacyReadOnly(security?.readOnly) ??
    DEFAULT_EXECUTE_SQL_ACCESS
  );
}

/**
 * Ceiling set by the operator's environment. Present only when
 * `IBMI_EXECUTE_SQL_ACCESS` or the deprecated `IBMI_EXECUTE_SQL_READONLY` is
 * explicitly set; `undefined` means runtime configuration is authoritative.
 * A shared YAML tool declaring `security.readOnly: false` must not be able to
 * widen access past what the operator pinned.
 */
const ENV_PINNED_ACCESS: ExecuteSqlAccess | undefined =
  process.env[EXECUTE_SQL_ACCESS_ENV] !== undefined ||
  process.env[LEGACY_READONLY_ENV] !== undefined
    ? config.ibmi_executeSqlAccess
    : undefined;

let effectiveAccess: ExecuteSqlAccess = config.ibmi_executeSqlAccess;

/** The env ceiling, if any (exposed for diagnostics and tests). */
export function getExecuteSqlAccessCeiling(): ExecuteSqlAccess | undefined {
  return ENV_PINNED_ACCESS;
}

/**
 * Record the access level the singleton pool should enforce. Called by
 * `configureExecuteSqlTool` whenever the tool config changes — the single
 * policy writer; other callers (e.g. the CLI's `ibmi tool`) go through
 * `configureExecuteSqlTool` so the tool config and the pool policy can never
 * disagree.
 *
 * @returns The effective level after applying the env ceiling. Callers compare
 *   it with `requested` to detect (and surface) a downgrade.
 */
export function setExecuteSqlAccessPolicy(
  requested: ExecuteSqlAccess,
): ExecuteSqlAccess {
  effectiveAccess = ENV_PINNED_ACCESS
    ? minAccess(ENV_PINNED_ACCESS, requested)
    : requested;
  return effectiveAccess;
}

/**
 * The effective access level. Read at pool initialization time (pools are
 * created lazily, on first query, after CLI/runtime configuration has been
 * applied).
 */
export function getExecuteSqlAccessPolicy(): ExecuteSqlAccess {
  return effectiveAccess;
}

/** Toolbox JDBC `access` property for a level. */
export function jdbcAccessFor(level: ExecuteSqlAccess): "read call" | "all" {
  return level === "write" ? "all" : "read call";
}

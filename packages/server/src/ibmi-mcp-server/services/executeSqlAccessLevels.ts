/**
 * @fileoverview The execute_sql guardrail mode names and their parser. A leaf
 * module (no imports) so config/index.ts can use it without a circular import
 * through executeSqlAccess.ts.
 *
 * @module src/ibmi-mcp-server/services/executeSqlAccessLevels
 */

/** Guardrail modes, least to most permissive. */
export const EXECUTE_SQL_ACCESS_LEVELS = [
  "read",
  "read-call",
  "write",
] as const;

export type ExecuteSqlAccess = (typeof EXECUTE_SQL_ACCESS_LEVELS)[number];

/**
 * Parse a raw mode string (env var, CLI flag). Trims and lowercases.
 * Returns `undefined` for an unrecognized value so callers decide how to
 * report it.
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

/**
 * @fileoverview execute_sql access mode helpers for the CLI.
 *
 * Mirrors the server's `read < read-call < write` lattice without importing
 * the server barrel (which would load the whole tool surface at startup).
 * The server remains the enforcement point; this module only decides what to
 * request and turns an operator-pinned downgrade into an explicit error.
 *
 * @module cli/utils/access-mode
 */

import type { SystemConfig } from "../config/types.js";

/** Access levels, least to most permissive. Keep in sync with the server. */
export const ACCESS_MODES = ["read", "read-call", "write"] as const;
export type AccessMode = (typeof ACCESS_MODES)[number];

/** Env var the server treats as an access ceiling. */
export const ACCESS_ENV = "IBMI_EXECUTE_SQL_ACCESS";

function rank(mode: AccessMode): number {
  return ACCESS_MODES.indexOf(mode);
}

/** The more restrictive of two modes. */
export function minAccess(a: AccessMode, b: AccessMode): AccessMode {
  return rank(a) <= rank(b) ? a : b;
}

/** Parse a user-supplied mode string; `undefined` when unrecognised. */
export function parseAccessMode(raw: unknown): AccessMode | undefined {
  if (typeof raw !== "string") return undefined;
  const v = raw.trim().toLowerCase();
  return (ACCESS_MODES as readonly string[]).includes(v)
    ? (v as AccessMode)
    : undefined;
}

/** Map the deprecated boolean `readOnly` onto a mode. */
export function accessFromReadOnly(
  readOnly: boolean | undefined,
): AccessMode | undefined {
  if (readOnly === undefined) return undefined;
  return readOnly ? "read" : "write";
}

/**
 * The access ceiling a configured system declares, if any.
 * `access` wins over the deprecated `readOnly`.
 */
export function resolveSystemAccess(
  system: Pick<SystemConfig, "access" | "readOnly">,
): AccessMode | undefined {
  return system.access ?? accessFromReadOnly(system.readOnly);
}

/**
 * Access mode requested on the command line. `--access` wins; the deprecated
 * `--read-only` / `--no-read-only` map to `read` / `write` with a stderr
 * notice. Throws on an unrecognised `--access` value.
 */
export function accessFromFlags(
  opts: Record<string, unknown>,
): AccessMode | undefined {
  if (opts["access"] !== undefined) {
    const mode = parseAccessMode(opts["access"]);
    if (!mode) {
      throw new Error(
        `Invalid --access value: "${String(opts["access"])}". Expected one of: ${ACCESS_MODES.join(", ")}.`,
      );
    }
    return mode;
  }
  if (typeof opts["readOnly"] === "boolean") {
    const mode = accessFromReadOnly(opts["readOnly"]) as AccessMode;
    process.stderr.write(
      `Warning: --read-only / --no-read-only are deprecated; use --access ${mode}.\n`,
    );
    return mode;
  }
  return undefined;
}

/**
 * Combine the requested mode with the ceilings of the target systems.
 *
 * - The request defaults to `read`; a system's `access` never raises it.
 * - A system ceiling lowers the request (a system configured as `read`
 *   cannot be widened from the command line).
 * - Several systems: the most restrictive declared ceiling applies.
 */
export function resolveEffectiveAccess(
  requested: AccessMode | undefined,
  systems: ReadonlyArray<Pick<SystemConfig, "access" | "readOnly">>,
): AccessMode {
  const ceilings = systems
    .map(resolveSystemAccess)
    .filter((m): m is AccessMode => m !== undefined);
  const ceiling = ceilings.length > 0 ? ceilings.reduce(minAccess) : undefined;
  const request = requested ?? "read";
  return ceiling ? minAccess(request, ceiling) : request;
}

/**
 * Fail loudly when the server lowered the requested mode because
 * IBMI_EXECUTE_SQL_ACCESS is pinned in the environment. Without this the
 * statement would pass the CLI and be rejected by Db2 with an opaque error.
 * The message contains "access mode" so it classifies as a SECURITY exit.
 */
export function assertAccessNotLowered(
  requested: AccessMode,
  effective: AccessMode,
): void {
  if (effective === requested) return;
  throw new Error(
    `Requested access mode '${requested}' but ${ACCESS_ENV}=${process.env[ACCESS_ENV] ?? "<legacy IBMI_EXECUTE_SQL_READONLY>"} in the environment caps execute_sql at '${effective}'. Unset ${ACCESS_ENV} (check .env in the current directory) or use --access ${effective}.`,
  );
}

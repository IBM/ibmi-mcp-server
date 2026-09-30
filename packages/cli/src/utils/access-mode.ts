/**
 * @fileoverview execute_sql guardrail mode selection for `ibmi sql`.
 *
 * Decides which mode to request (`--access`, default `read`) and refuses,
 * with a security exit, a request above a ceiling: a system's `access`
 * (or deprecated `readOnly: true`) or IBMI_EXECUTE_SQL_ACCESS. The server's
 * guardrail module enforces the mode; this module only picks it.
 *
 * @module cli/utils/access-mode
 */

import type { ExecuteSqlAccess } from "@ibm/ibmi-mcp-server/tools";
import { ACCESS_MODES } from "../config/schema.js";
import type { ResolvedSystem, SystemConfig } from "../config/types.js";
import { SecurityViolationError } from "./exit-codes.js";

function rank(mode: ExecuteSqlAccess): number {
  return ACCESS_MODES.indexOf(mode);
}

/**
 * The mode requested on the command line. `--access` wins; the deprecated
 * `--read-only` / `--no-read-only` map to `read` / `write` with a stderr
 * notice. Defaults to `read`.
 *
 * @throws Error on an unrecognized `--access` value (a usage error)
 */
export function accessFromFlags(
  opts: Record<string, unknown>,
): ExecuteSqlAccess {
  const raw = opts["access"];
  if (raw !== undefined) {
    const mode = String(raw).trim().toLowerCase();
    if (!(ACCESS_MODES as readonly string[]).includes(mode)) {
      throw new Error(
        `Invalid --access value: "${String(raw)}". Expected one of: ${ACCESS_MODES.join(", ")}.`,
      );
    }
    return mode as ExecuteSqlAccess;
  }
  if (typeof opts["readOnly"] === "boolean") {
    const mode: ExecuteSqlAccess = opts["readOnly"] ? "read" : "write";
    process.stderr.write(
      `Warning: --read-only / --no-read-only are deprecated; use --access ${mode}.\n`,
    );
    return mode;
  }
  return "read";
}

/**
 * The ceiling a system declares: `access`, or `read` for the deprecated
 * `readOnly: true`; the more restrictive when both are set.
 */
export function systemAccessCeiling(
  system: Pick<SystemConfig, "access" | "readOnly">,
): ExecuteSqlAccess | undefined {
  const legacy: ExecuteSqlAccess | undefined = system.readOnly
    ? "read"
    : undefined;
  if (!system.access) return legacy;
  if (!legacy) return system.access;
  return rank(system.access) <= rank(legacy) ? system.access : legacy;
}

/**
 * Refuse a requested mode above a target system's ceiling.
 *
 * @throws SecurityViolationError naming the system and its setting
 */
export function assertWithinSystemCeilings(
  requested: ExecuteSqlAccess,
  systems: readonly ResolvedSystem[],
): void {
  for (const { name, config } of systems) {
    const ceiling = systemAccessCeiling(config);
    if (ceiling && rank(requested) > rank(ceiling)) {
      const setting =
        config.access === ceiling ? `access: ${ceiling}` : "readOnly: true";
      throw new SecurityViolationError(
        `Guardrail mode '${requested}' is above the ceiling of system "${name}" (${setting} in its CLI config). Use --access ${ceiling} or change the system's access setting.`,
      );
    }
  }
}

/**
 * Refuse a request the server lowered because its env ceiling is set.
 *
 * @param envVar - The variable that holds the ceiling (IBMI_EXECUTE_SQL_ACCESS)
 * @throws SecurityViolationError naming the variable and its value
 */
export function assertNotLoweredByEnv(
  requested: ExecuteSqlAccess,
  effective: ExecuteSqlAccess,
  envVar: string,
): void {
  if (effective === requested) return;
  throw new SecurityViolationError(
    `Guardrail mode '${requested}' is above the ceiling ${envVar}=${process.env[envVar] ?? ""} (set in the environment or a .env file the server configuration loaded), which caps execute_sql at '${effective}'. Use --access ${effective} or unset ${envVar}.`,
  );
}

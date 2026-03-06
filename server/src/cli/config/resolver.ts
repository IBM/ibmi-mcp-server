/**
 * @fileoverview System resolution for the IBM i CLI.
 * Resolves which IBM i system to connect to based on:
 *   1. --system flag (highest priority)
 *   2. IBMI_SYSTEM environment variable
 *   3. Config file default
 *   4. DB2i_* environment variables (legacy fallback)
 * @module cli/config/resolver
 */

import { loadConfig } from "./loader.js";
import type { CliConfig, ResolvedSystem, SystemConfig } from "./types.js";

/**
 * Build a SystemConfig from legacy DB2i_* environment variables.
 * Returns null if the required env vars are not set.
 */
function buildLegacySystemConfig(): SystemConfig | null {
  const host = process.env["DB2i_HOST"];
  const user = process.env["DB2i_USER"];
  const password = process.env["DB2i_PASS"];

  if (!host || !user) {
    return null;
  }

  return {
    host,
    user,
    password,
    port: 8076,
    readOnly: false,
    confirm: false,
    timeout: 60,
    maxRows: 5000,
    ignoreUnauthorized:
      process.env["DB2i_IGNORE_UNAUTHORIZED"] !== "false",
  };
}

/**
 * Resolve which system to use for a CLI command.
 *
 * Resolution priority:
 * 1. --system <name> flag
 * 2. IBMI_SYSTEM environment variable
 * 3. Config file `default:` setting
 * 4. DB2i_* environment variables (creates implicit "env" system)
 *
 * @param systemFlag - The --system flag value, if provided.
 * @param config - Pre-loaded config (optional, will load if not provided).
 * @returns The resolved system context.
 * @throws If no system can be resolved.
 */
export function resolveSystem(
  systemFlag?: string,
  config?: CliConfig,
): ResolvedSystem {
  const cfg = config ?? loadConfig();

  // 1. --system flag
  if (systemFlag) {
    const system = cfg.systems[systemFlag];
    if (!system) {
      const available = Object.keys(cfg.systems);
      throw new Error(
        `System "${systemFlag}" not found in configuration. ` +
          (available.length > 0
            ? `Available systems: ${available.join(", ")}`
            : `No systems configured. Run "ibmi system add" to add one.`),
      );
    }
    return { name: systemFlag, config: system, source: "flag" };
  }

  // 2. IBMI_SYSTEM env var
  const envSystem = process.env["IBMI_SYSTEM"];
  if (envSystem) {
    const system = cfg.systems[envSystem];
    if (!system) {
      const available = Object.keys(cfg.systems);
      throw new Error(
        `System "${envSystem}" (from IBMI_SYSTEM env var) not found. ` +
          (available.length > 0
            ? `Available systems: ${available.join(", ")}`
            : `No systems configured.`),
      );
    }
    return { name: envSystem, config: system, source: "env" };
  }

  // 3. Config default
  if (cfg.default) {
    const system = cfg.systems[cfg.default];
    if (system) {
      return { name: cfg.default, config: system, source: "config-default" };
    }
  }

  // 4. If there's only one system, use it
  const systemNames = Object.keys(cfg.systems);
  if (systemNames.length === 1 && systemNames[0]) {
    return {
      name: systemNames[0],
      config: cfg.systems[systemNames[0]]!,
      source: "config-default",
    };
  }

  // 5. Legacy DB2i_* env vars
  const legacyConfig = buildLegacySystemConfig();
  if (legacyConfig) {
    return { name: "env", config: legacyConfig, source: "legacy-env" };
  }

  // Nothing found
  throw new Error(
    "No IBM i system configured. Options:\n" +
      "  1. Run: ibmi system add <name>\n" +
      "  2. Set IBMI_SYSTEM environment variable\n" +
      "  3. Set DB2i_HOST, DB2i_USER, DB2i_PASS environment variables",
  );
}

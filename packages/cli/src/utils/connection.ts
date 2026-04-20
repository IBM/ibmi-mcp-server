/**
 * @fileoverview Connection bridge for the IBM i CLI.
 * Maps resolved system config into DB2i_* environment variables that
 * IBMiConnectionPool reads via the global config singleton.
 *
 * Must be called BEFORE dynamic-importing any tool modules, since
 * the server's config/index.ts evaluates env vars at import time.
 *
 * @module cli/utils/connection
 */

import { resolvePassword } from "../config/credentials.js";
import type { ResolvedSystem } from "../config/types.js";

/**
 * Set DB2i_* environment variables from resolved system config and
 * return a cleanup function to close the connection pool.
 *
 * Call this before dynamically importing tool modules so the global
 * config singleton picks up the correct credentials.
 */
export async function connectSystem(
  resolved: ResolvedSystem,
): Promise<() => Promise<void>> {
  const password = await resolvePassword(
    resolved.name,
    resolved.config.password,
    resolved.config.user,
    resolved.config.host,
  );

  // Set env vars for IBMiConnectionPool (reads from global config singleton)
  process.env.DB2i_HOST = resolved.config.host;
  process.env.DB2i_USER = resolved.config.user;
  process.env.DB2i_PASS = password;
  process.env.DB2i_IGNORE_UNAUTHORIZED = String(
    resolved.config.ignoreUnauthorized,
  );

  // Return cleanup function
  return async () => {
    try {
      const { IBMiConnectionPool } = await import(
        "@ibm/ibmi-mcp-server/services"
      );
      await IBMiConnectionPool.close();
    } catch {
      // Ignore cleanup errors
    }
  };
}

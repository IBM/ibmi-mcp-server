/**
 * @fileoverview Connection bridge for the IBM i CLI.
 * Maps resolved system config into DB2i_* environment variables that
 * IBMiConnectionPool reads via the global config singleton.
 *
 * Must be called BEFORE the first query: the server's config reads the
 * DB2i_* env vars lazily, when the connection pool initializes.
 *
 * @module cli/utils/connection
 */

import { resolvePassword } from "../config/credentials.js";
import type { ResolvedSystem } from "../config/types.js";

/**
 * Set DB2i_* environment variables from resolved system config and
 * return a cleanup function to close the connection pool.
 *
 * This does not open a connection — the pool connects on the first query,
 * picking up these credentials from the global config singleton.
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
  process.env.DB2i_PORT = resolved.config.port.toString();
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

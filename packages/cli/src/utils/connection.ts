/**
 * @fileoverview Connection bridge for the IBM i CLI.
 * Maps resolved system config into DB2i_* environment variables that
 * IBMiConnectionPool reads via the global config singleton.
 *
 * A system with an SSH key connects over SSH with key authentication only.
 * By default its commands share an SSH session that stays open between
 * commands (see session/), so only the first command pays the connect.
 *
 * Must be called BEFORE the first query: the server's config reads the
 * DB2i_* env vars lazily, when the connection pool initializes.
 *
 * @module cli/utils/connection
 */

import { accessSync, constants } from "fs";
import { resolvePassword } from "../config/credentials.js";
import type { ResolvedSystem } from "../config/types.js";
import { expandHome } from "../session/paths.js";

export interface ConnectOptions {
  /** Connect in this process for this command only; use no SSH session. */
  fresh?: boolean;
}

/**
 * SSH settings from the shell, read when the CLI starts. A system without
 * its own value gets these back, not the value of a system connected
 * earlier in the same process (`ibmi system test --all`).
 */
const SHELL_SSH = {
  hostKeySha256: process.env.DB2i_SSH_HOST_KEY_SHA256,
  technique: process.env.DB2i_SSH_TECHNIQUE,
};

function setOrDelete(name: string, value: string | undefined): void {
  if (value) process.env[name] = value;
  else delete process.env[name];
}

/**
 * Sets the DB2i_* variables the server code reads for this system. A system
 * with an SSH key gets no password: none is ever sent over SSH.
 */
export function applySystemEnv(
  resolved: ResolvedSystem,
  password: string | undefined,
): void {
  const config = resolved.config;
  process.env.DB2i_HOST = config.host;
  process.env.DB2i_PORT = config.port.toString();
  process.env.DB2i_USER = config.user;
  process.env.DB2i_IGNORE_UNAUTHORIZED = String(config.ignoreUnauthorized);
  setOrDelete("DB2i_PASS", config.sshKey ? undefined : password);
  // A key in the shell must not turn a password system into an SSH one
  setOrDelete("DB2i_SSH_KEY", config.sshKey);
  setOrDelete(
    "DB2i_SSH_HOST_KEY_SHA256",
    config.sshHostKeySha256 ?? SHELL_SSH.hostKeySha256,
  );
  setOrDelete("DB2i_SSH_TECHNIQUE", config.sshTechnique ?? SHELL_SSH.technique);
}

/** Whether commands on this system share an SSH session. */
export function usesSession(
  resolved: ResolvedSystem,
  options: ConnectOptions = {},
): boolean {
  return (
    Boolean(resolved.config.sshKey) &&
    resolved.config.keepSession !== false &&
    !options.fresh
  );
}

/**
 * Prepare the connection to a system and return a cleanup function.
 *
 * Without an SSH session this opens nothing: the pool connects on the first
 * query. With one, the statements of this command go to the session host,
 * which is started here when the session is not open.
 */
export async function connectSystem(
  resolved: ResolvedSystem,
  options: ConnectOptions = {},
): Promise<() => Promise<void>> {
  const { sshKey } = resolved.config;
  if (sshKey) {
    try {
      accessSync(expandHome(sshKey), constants.R_OK);
    } catch {
      throw new Error(
        `Cannot read the SSH key of system "${resolved.name}": ${sshKey}`,
      );
    }
  }

  const password = sshKey
    ? undefined
    : await resolvePassword(
        resolved.name,
        resolved.config.password,
        resolved.config.user,
        resolved.config.host,
      );
  applySystemEnv(resolved, password);

  if (usesSession(resolved, options)) {
    const { connectSession } = await import("../session/client.js");
    const { setServiceQueryExecutor } =
      await import("@ibm/ibmi-mcp-server/services");
    const session = await connectSession(resolved);
    setServiceQueryExecutor(session);
    return async () => {
      setServiceQueryExecutor(undefined);
      session.close();
    };
  }

  // Return cleanup function
  return async () => {
    try {
      const { IBMiConnectionPool } =
        await import("@ibm/ibmi-mcp-server/services");
      await IBMiConnectionPool.close();
    } catch {
      // Ignore cleanup errors
    }
  };
}

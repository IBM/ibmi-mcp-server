/**
 * @fileoverview `ibmi session-host`: the hidden command a CLI command starts
 * as a detached process to hold the SSH session of one system. It reads the
 * system and its socket from the environment (see `SESSION_ENV`).
 *
 * @module cli/commands/session-host
 */

import { appendFileSync } from "fs";
import { Command } from "commander";
import type { ResolvedSystem } from "../config/types.js";
import { applySystemEnv } from "../utils/connection.js";
import { createCliContext } from "../utils/command-helpers.js";
import { SESSION_ENV } from "../session/client.js";
import { startSessionHost } from "../session/host.js";
import { sessionTechnique } from "../session/paths.js";
import { getVersion } from "../version.js";

/** Default idle time before a session closes: 10 minutes. */
const DEFAULT_IDLE_SECONDS = 600;

function idleTimeoutMs(): number {
  const seconds = Number(process.env.IBMI_SESSION_IDLE_SECONDS);
  return (
    (Number.isInteger(seconds) && seconds > 0
      ? seconds
      : DEFAULT_IDLE_SECONDS) * 1000
  );
}

async function runSessionHost(): Promise<void> {
  const resolved = JSON.parse(
    process.env[SESSION_ENV.system] ?? "null",
  ) as ResolvedSystem | null;
  const socketPath = process.env[SESSION_ENV.socket];
  const logPath = process.env[SESSION_ENV.log];
  if (!resolved?.config?.sshKey || !socketPath || !logPath) {
    process.stderr.write("ibmi session-host is started by other commands.\n");
    process.exitCode = 2;
    return;
  }

  const log = (message: string) => {
    try {
      appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`, {
        mode: 0o600,
      });
    } catch {
      // A log that cannot be written does not stop the session
    }
  };

  // Set before the server code reads its configuration
  applySystemEnv(resolved, undefined);
  const { IBMiConnectionPool } = await import("@ibm/ibmi-mcp-server/services");

  let host: Awaited<ReturnType<typeof startSessionHost>>;
  try {
    host = await startSessionHost({
      socketPath,
      info: {
        system: resolved.name,
        host: resolved.config.host,
        user: resolved.config.user,
        technique: sessionTechnique(resolved.config),
        version: getVersion(),
      },
      idleTimeoutMs: idleTimeoutMs(),
      connect: async () => {
        await IBMiConnectionPool.executeQuery(
          "VALUES 1",
          [],
          createCliContext("session_open"),
        );
      },
      execute: (request) => {
        const ctx = createCliContext(request.toolName ?? "session_query");
        const params = request.params as Parameters<
          typeof IBMiConnectionPool.executeQuery
        >[1];
        return request.paginate
          ? IBMiConnectionPool.executeQueryWithPagination(
              request.sql,
              params,
              ctx,
              request.rowsToFetch,
            )
          : IBMiConnectionPool.executeQuery(
              request.sql,
              params,
              ctx,
              request.rowsToFetch,
            );
      },
      close: () => IBMiConnectionPool.close(),
      log,
      onStopped: (exitCode) => process.exit(exitCode),
    });
  } catch (error) {
    // Another session host listens on this socket already
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") return;
    log(`could not listen: ${(error as Error).message}`);
    process.exitCode = 1;
    return;
  }

  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(signal, () => void host.stop(signal));
  }
}

/** Registers the hidden `ibmi session-host` command. */
export function registerSessionHostCommand(program: Command): void {
  program
    .command("session-host", { hidden: true })
    .description("Hold the SSH session of a system (started by other commands)")
    .action(runSessionHost);
}

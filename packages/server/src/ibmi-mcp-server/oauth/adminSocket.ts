/**
 * @fileoverview The local control socket of the built-in OAuth sign-on: a
 * Unix domain socket at `OAUTH_ADMIN_SOCKET`. Its file permission (owner
 * only) is the authorization; there is no admin secret and no HTTP route.
 *
 * One command per line, one line in reply:
 * - `unblock <profile>`: clears the profile's sign-on block on this server.
 * - `revoke <profile|grantId>`: ends one sign-on, or every one of a profile.
 * - `status`: counts of sign-ons, open IBM i connections and blocked profiles.
 * @module src/ibmi-mcp-server/oauth/adminSocket
 */

import { lstat, unlink } from "node:fs/promises";
import net from "node:net";
import { JsonRpcErrorCode, McpError } from "@/types-global/errors.js";
import { logger } from "@/utils/internal/logger.js";
import { requestContextService } from "@/utils/internal/requestContext.js";
import type { GrantManager } from "./contracts.js";

/** No command is longer than this; a client that sends more is cut off. */
const MAX_LINE_LENGTH = 256;
/**
 * The longest socket path in bytes (`sun_path` less its terminating NUL).
 * Node.js 22 on Linux binds a longer path cut short, at another place than
 * the one configured, instead of failing.
 */
const MAX_PATH_BYTES: Partial<Record<NodeJS.Platform, number>> = {
  linux: 107,
  darwin: 103,
};
/** How long `sendAdminCommand` waits for the reply. */
const REPLY_TIMEOUT_MS = 5000;
const USAGE =
  "error: expected unblock <profile>, revoke <profile|grantId> or status";

/** The part of the grant manager the admin socket calls. */
type AdminActions = Pick<GrantManager, "unblock" | "revokeByAdmin" | "status">;

/** Runs one command line and returns its one-line reply. Never rejects. */
async function runCommand(grants: AdminActions, line: string): Promise<string> {
  const [command, argument, ...rest] = line.trim().split(/\s+/);
  const known =
    (command === "status" && argument === undefined) ||
    ((command === "unblock" || command === "revoke") &&
      argument !== undefined &&
      rest.length === 0);
  if (!known) {
    return USAGE;
  }
  // The argument is not logged here: the grant manager logs what it did.
  logger.info(
    {
      ...requestContextService.createRequestContext({
        operation: "OAuthAdminSocket",
      }),
      event: "admin_command",
      command,
    },
    "admin_command",
  );
  try {
    if (command === "status") {
      const status = grants.status();
      return `grants=${status.grants} connections=${status.openConnections}/${status.maxConnections} blocked=${status.blockedProfiles}`;
    }
    if (command === "unblock") {
      return grants.unblock(argument!) ? "unblocked" : "not blocked";
    }
    return `revoked ${await grants.revokeByAdmin(argument!)}`;
  } catch {
    return "error: the command failed";
  }
}

/** Whether a server accepts connections on the socket at `path`. */
function isListening(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(path);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

/**
 * Starts the admin socket.
 *
 * @param path - `OAUTH_ADMIN_SOCKET`.
 * @returns `close`, which stops it and removes the socket file.
 * @throws {McpError} `ConfigurationError` when `path` exists and is not a
 *   socket, another server listens on it, or no socket can be created
 *   there. A socket left by an earlier run, on which nothing listens, is
 *   replaced.
 */
export async function startAdminSocket(
  grants: AdminActions,
  path: string,
): Promise<{ close(): Promise<void> }> {
  const limit = MAX_PATH_BYTES[process.platform];
  const length = Buffer.byteLength(path);
  if (limit !== undefined && length > limit) {
    throw new McpError(
      JsonRpcErrorCode.ConfigurationError,
      `OAUTH_ADMIN_SOCKET: no socket can be created at ${path}: it is ${length} bytes long, and a socket path may be at most ${limit} bytes here.`,
    );
  }
  const existing = await lstat(path).catch(() => undefined);
  if (existing) {
    if (!existing.isSocket()) {
      throw new McpError(
        JsonRpcErrorCode.ConfigurationError,
        `OAUTH_ADMIN_SOCKET: ${path} exists and is not a socket.`,
      );
    }
    // Taking the path over would leave that server without an admin socket,
    // and its shutdown would remove this one's.
    if (await isListening(path)) {
      throw new McpError(
        JsonRpcErrorCode.ConfigurationError,
        `OAUTH_ADMIN_SOCKET: another server is listening on ${path}. Stop that server, or give this one a path of its own.`,
      );
    }
    await unlink(path);
  }

  const connections = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    let buffered = "";
    let replies = Promise.resolve();
    connections.add(socket);
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("close", () => connections.delete(socket));
    socket.on("data", (chunk: string) => {
      buffered += chunk;
      for (
        let end = buffered.indexOf("\n");
        end >= 0;
        end = buffered.indexOf("\n")
      ) {
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 1);
        replies = replies
          .then(() => runCommand(grants, line))
          .then((reply) => void socket.write(`${reply}\n`));
      }
      if (buffered.length > MAX_LINE_LENGTH) {
        socket.destroy();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // The socket file is created by `listen`, synchronously: with this mask
    // it never exists with access for anyone but the owner.
    const mask = process.umask(0o177);
    try {
      server.listen(path, resolve);
    } finally {
      process.umask(mask);
    }
  }).catch((error: NodeJS.ErrnoException) => {
    throw new McpError(
      JsonRpcErrorCode.ConfigurationError,
      `OAUTH_ADMIN_SOCKET: no socket can be created at ${path} (${error.code}). Its directory must exist and be writable, and the path must be at most about 100 bytes long.`,
    );
  });

  return {
    close: () =>
      new Promise((resolve) => {
        for (const socket of connections) {
          socket.destroy();
        }
        // Closing the server removes the socket file.
        server.close(() => resolve());
      }),
  };
}

/**
 * Sends one command to a running server's admin socket and resolves to its
 * reply. For the server binary's `--admin` flag.
 *
 * @param path - `OAUTH_ADMIN_SOCKET` of the running server.
 * @param command - `unblock <profile>`, `revoke <profile|grantId>` or `status`.
 */
export function sendAdminCommand(
  path: string,
  command: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let reply = "";
    const socket = net.createConnection(path, () =>
      socket.write(`${command}\n`),
    );
    socket.setEncoding("utf8");
    socket.setTimeout(REPLY_TIMEOUT_MS, () =>
      socket.destroy(
        new Error(
          `The admin socket did not answer in ${REPLY_TIMEOUT_MS / 1000} seconds.`,
        ),
      ),
    );
    socket.on("error", reject);
    socket.on("close", () =>
      reject(new Error("The admin socket closed without a reply.")),
    );
    socket.on("data", (chunk: string) => {
      reply += chunk;
      const end = reply.indexOf("\n");
      if (end >= 0) {
        resolve(reply.slice(0, end));
        socket.end();
      }
    });
  });
}

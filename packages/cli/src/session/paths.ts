/**
 * @fileoverview Where the SSH session of a system lives: its socket and log
 * file under `~/.ibmi/run/`. The file name holds a digest of the settings the
 * session was opened with, so changed settings give a new session.
 *
 * @module cli/session/paths
 */

import { createHash } from "crypto";
import { chmodSync, lstatSync, mkdirSync, statSync } from "fs";
import { homedir, userInfo } from "os";
import path from "path";
import type { ResolvedSystem, SystemConfig } from "../config/types.js";

/** The socket and log file of one session. */
export interface SessionFiles {
  /** Unix socket path, or a named pipe on Windows. */
  socket: string;
  log: string;
}

/** `~/.ibmi/run`. Read at each call, so tests can change `HOME`. */
export function runDir(): string {
  return path.join(homedir(), ".ibmi", "run");
}

/**
 * Where sockets go when a path under `~/.ibmi/run` is too long for a Unix
 * socket (about 104 bytes on macOS, 108 on Linux): `/tmp/ibmi-<uid>`.
 */
export function shortSocketDir(): string {
  const owner =
    typeof process.getuid === "function"
      ? String(process.getuid())
      : safeName(userInfo().username);
  return path.join("/tmp", `ibmi-${owner}`);
}

/** Longest Unix socket path used, in bytes. */
const MAX_SOCKET_PATH_BYTES = 100;

/**
 * Creates a directory with mode 0700, or makes sure an existing one has it.
 *
 * @throws if the directory belongs to another user: then another user could
 *   put a socket there that receives this user's SQL.
 */
export function ensurePrivateDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32" && typeof process.getuid === "function") {
    // lstat: in /tmp another user can make the name a link to elsewhere
    const stat = lstatSync(dir);
    if (!stat.isDirectory()) {
      throw new Error(
        `${dir} is not a directory. Remove it, then run the command again.`,
      );
    }
    if (stat.uid !== process.getuid()) {
      throw new Error(
        `${dir} belongs to another user. Remove it, then run the command again.`,
      );
    }
    if ((stat.mode & 0o077) !== 0) chmodSync(dir, 0o700);
  }
  return dir;
}

/** Creates `~/.ibmi/run` with mode 0700. */
export function ensureRunDir(): string {
  return ensurePrivateDir(runDir());
}

/** Expands a leading `~/`. */
export function expandHome(filePath: string): string {
  return filePath === "~" || filePath.startsWith("~/")
    ? path.join(homedir(), filePath.slice(1))
    : filePath;
}

/** The JDBC technique of a system's SSH connection. Default: `tcp`. */
export function sessionTechnique(config: SystemConfig): "tcp" | "cli" {
  return (
    config.sshTechnique ??
    (process.env.DB2i_SSH_TECHNIQUE === "cli" ? "cli" : "tcp")
  );
}

/**
 * Digest of everything that decides what a session connects to and how.
 * Two commands share a session only when it is equal.
 */
function settingsDigest(resolved: ResolvedSystem, version: string): string {
  const config = resolved.config;
  const keyPath = expandHome(config.sshKey ?? "");
  let keyChanged = 0;
  try {
    // A new key in the same file is a new session
    keyChanged = statSync(keyPath).mtimeMs;
  } catch {
    // The session host reports the unreadable key
  }
  return createHash("sha256")
    .update(
      JSON.stringify([
        version,
        config.host.toLowerCase(),
        config.user.toUpperCase(),
        keyPath,
        keyChanged,
        config.sshHostKeySha256 ?? process.env.DB2i_SSH_HOST_KEY_SHA256 ?? null,
        sessionTechnique(config),
        process.env.DB2i_SSH_PORT ?? null,
        process.env.DB2i_JDBC_OPTIONS ?? null,
      ]),
    )
    .digest("hex")
    .slice(0, 12);
}

/** A system name as a file name part. */
function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 40);
}

/** Prefix of the Windows named pipes of this OS user. */
export function pipePrefix(): string {
  return `ibmi-${safeName(userInfo().username)}-`;
}

/** The socket and log file of the session for this system and CLI version. */
export function sessionFiles(
  resolved: ResolvedSystem,
  version: string,
): SessionFiles {
  const base = `${safeName(resolved.name)}-${settingsDigest(resolved, version)}`;
  const log = path.join(runDir(), `${base}.log`);
  if (process.platform === "win32") {
    return { socket: `\\\\.\\pipe\\${pipePrefix()}${base}`, log };
  }
  const socket = path.join(runDir(), `${base}.sock`);
  return Buffer.byteLength(socket) <= MAX_SOCKET_PATH_BYTES
    ? { socket, log }
    : { socket: path.join(shortSocketDir(), `${base}.sock`), log };
}

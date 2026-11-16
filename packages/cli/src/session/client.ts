/**
 * @fileoverview The command side of an SSH session: open the session of a
 * system (starting its session host when there is none), send statements to
 * it, and list or close sessions.
 *
 * @module cli/session/client
 */

import { spawn } from "child_process";
import { readFileSync, readdirSync, rmSync } from "fs";
import net, { type Socket } from "net";
import path from "path";
import { fileURLToPath } from "url";
import type { BindingValue, QueryResult } from "@ibm/mapepire-js";
import type { RequestContext } from "@ibm/ibmi-mcp-server/context";
import type {
  PaginatedQueryResult,
  ServiceQueryExecutor,
} from "@ibm/ibmi-mcp-server/services";
import type { ResolvedSystem } from "../config/types.js";
import { getVersion } from "../version.js";
import {
  ensurePrivateDir,
  ensureRunDir,
  pipePrefix,
  runDir,
  sessionFiles,
  shortSocketDir,
  type SessionFiles,
} from "./paths.js";
import {
  readMessages,
  send,
  type HostMessage,
  type SessionInfo,
  type WireError,
} from "./protocol.js";

/** How long a command waits for a new session host to listen. */
const LISTEN_TIMEOUT_MS = 15_000;
/** How long a command waits for the session to connect. */
const OPEN_TIMEOUT_MS = 120_000;

/** Environment variables that hand a system to a session host. */
export const SESSION_ENV = {
  system: "IBMI_SESSION_SYSTEM",
  socket: "IBMI_SESSION_SOCKET",
  log: "IBMI_SESSION_LOG",
} as const;

/** An error from the session or its host, as the server's `McpError`. */
async function toError(error: WireError): Promise<Error> {
  const { McpError } = await import("@ibm/ibmi-mcp-server/services");
  return new McpError(error.code, error.message, error.details);
}

/** Connects to a socket, or gives the error code when that fails. */
function connectOrCode(
  socketPath: string,
): Promise<{ socket: Socket } | { code: string }> {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath);
    socket.once("connect", () => {
      socket.removeAllListeners("error");
      resolve({ socket });
    });
    socket.once("error", (error: NodeJS.ErrnoException) =>
      resolve({ code: error.code ?? "UNKNOWN" }),
    );
  });
}

/** Connects to a socket; `undefined` when nothing listens there. */
async function tryConnect(socketPath: string): Promise<Socket | undefined> {
  const attempt = await connectOrCode(socketPath);
  return "socket" in attempt ? attempt.socket : undefined;
}

/** The last line of the session log, which says why a host stopped. */
function lastLogLine(logPath: string): string | undefined {
  try {
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    // Drop the timestamp
    return lines.at(-1)?.replace(/^\S+ /, "");
  } catch {
    return undefined;
  }
}

/** Waits until something listens on the socket, or the host has exited. */
async function waitForListen(
  socketPath: string,
  timeoutMs: number,
  hostExited: () => boolean,
): Promise<Socket | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !hostExited()) {
    const socket = await tryConnect(socketPath);
    if (socket) return socket;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return undefined;
}

/**
 * Starts the session host of a system as a detached process.
 *
 * @returns a function that tells whether the process has exited.
 */
export function spawnSessionHost(
  resolved: ResolvedSystem,
  files: SessionFiles,
): () => boolean {
  const entry = fileURLToPath(new URL("../index.js", import.meta.url));
  // The password is never used over SSH, so it does not go to the host
  const config = { ...resolved.config, password: undefined };
  const child = spawn(process.execPath, [entry, "session-host"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: {
      ...process.env,
      [SESSION_ENV.system]: JSON.stringify({ ...resolved, config }),
      [SESSION_ENV.socket]: files.socket,
      [SESSION_ENV.log]: files.log,
      // The session host has its own idle timeout
      MCP_POOL_IDLE_TIMEOUT_MS: "0",
    },
  });
  let exited = false;
  child.once?.("exit", () => {
    exited = true;
  });
  child.unref();
  return () => exited;
}

export interface OpenSessionOptions {
  /**
   * Starts the session host and returns whether it has exited. Default:
   * {@link spawnSessionHost}.
   */
  spawnHost?: (
    resolved: ResolvedSystem,
    files: SessionFiles,
  ) => (() => boolean) | void;
}

/**
 * Opens the session of a system: connects to its session host, or starts
 * one and waits until it has connected to the IBM i.
 *
 * @throws the error of the connection when the session host could not
 *   connect, as an `McpError`.
 */
export async function connectSession(
  resolved: ResolvedSystem,
  options: OpenSessionOptions = {},
): Promise<SessionClient> {
  const spawnHost = options.spawnHost ?? spawnSessionHost;
  ensureRunDir();
  const files = sessionFiles(resolved, getVersion());
  if (process.platform !== "win32")
    ensurePrivateDir(path.dirname(files.socket));

  for (let attempt = 0; attempt < 2; attempt++) {
    const attempt = await connectOrCode(files.socket);
    let socket = "socket" in attempt ? attempt.socket : undefined;
    if (!socket) {
      // A socket file that nobody listens on is left by a host that died.
      // With no file at all, leave it: another command may be starting a
      // host right now, and its socket must not be removed.
      if (
        process.platform !== "win32" &&
        "code" in attempt &&
        attempt.code !== "ENOENT"
      ) {
        rmSync(files.socket, { force: true });
      }
      if (process.stderr.isTTY) {
        process.stderr.write(`Opening an SSH session to ${resolved.name}…\n`);
      }
      const hostExited = spawnHost(resolved, files) ?? (() => false);
      socket = await waitForListen(files.socket, LISTEN_TIMEOUT_MS, hostExited);
      if (!socket) break;
    }

    const reader = readMessages<HostMessage>(socket);
    const reply = await new Promise<HostMessage | undefined>((resolve) => {
      const timer = setTimeout(() => resolve(undefined), OPEN_TIMEOUT_MS);
      reader.handle((message) => {
        if (message.type === "ready" || message.type === "failed") {
          clearTimeout(timer);
          resolve(message);
        }
      });
      socket.once("close", () => {
        clearTimeout(timer);
        resolve(undefined);
      });
      send(socket, { type: "hello" });
    });

    if (reply?.type === "ready") {
      return new SessionClient(socket, reader, reply.info, resolved.name);
    }
    socket.destroy();
    if (reply?.type === "failed") throw await toError(reply.error);
    // The host closed before it answered: start a new one once
  }

  const reason = lastLogLine(files.log);
  throw await toError({
    code: -32000,
    message: `Could not open an SSH session for system "${resolved.name}"${reason ? `: ${reason}` : ""}. Log: ${files.log}`,
  });
}

/** A connection to an open session. Sends statements to its SQL job. */
export class SessionClient implements ServiceQueryExecutor {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private closed = false;

  constructor(
    private readonly socket: Socket,
    reader: ReturnType<typeof readMessages<HostMessage>>,
    readonly info: SessionInfo,
    private readonly systemName: string,
  ) {
    reader.handle((message) => {
      if (message.type !== "result") return;
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.ok) waiter.resolve(message.result);
      else void toError(message.error).then(waiter.reject);
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      this.closed = true;
      if (this.pending.size === 0) return;
      void toError({
        code: -32000,
        message: `The SSH session for system "${this.systemName}" closed while the statement ran. Check whether it completed before you run it again.`,
      }).then((error) => {
        for (const waiter of this.pending.values()) waiter.reject(error);
        this.pending.clear();
      });
    });
  }

  private request(
    sql: string,
    params: BindingValue[] | undefined,
    context: RequestContext | undefined,
    rowsToFetch: number | undefined,
    paginate: boolean,
  ): Promise<unknown> {
    if (this.closed) {
      return toError({
        code: -32000,
        message: `The SSH session for system "${this.systemName}" is closed.`,
      }).then((error) => Promise.reject(error));
    }
    const id = this.nextId++;
    const toolName = (context as { toolName?: unknown } | undefined)?.toolName;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      send(this.socket, {
        type: "query",
        id,
        sql,
        ...(params ? { params } : {}),
        ...(rowsToFetch !== undefined ? { rowsToFetch } : {}),
        paginate,
        ...(typeof toolName === "string" ? { toolName } : {}),
      });
    });
  }

  executeQuery<T = unknown>(
    query: string,
    params?: BindingValue[],
    context?: RequestContext,
    rowsToFetch?: number,
  ): Promise<QueryResult<T>> {
    return this.request(query, params, context, rowsToFetch, false) as Promise<
      QueryResult<T>
    >;
  }

  executeQueryWithPagination(
    query: string,
    params?: BindingValue[],
    context?: RequestContext,
    rowsToFetch?: number,
  ): Promise<PaginatedQueryResult> {
    return this.request(
      query,
      params,
      context,
      rowsToFetch,
      true,
    ) as Promise<PaginatedQueryResult>;
  }

  /** Disconnects this command. The session stays open. */
  close(): void {
    this.socket.end();
  }
}

/** One session host found under `~/.ibmi/run`. */
export interface FoundSession {
  socket: string;
  info: SessionInfo;
}

/** The sockets under `~/.ibmi/run` (named pipes on Windows). */
function sessionSockets(): string[] {
  try {
    if (process.platform === "win32") {
      return readdirSync("\\\\.\\pipe\\")
        .filter((name) => name.startsWith(pipePrefix()))
        .map((name) => `\\\\.\\pipe\\${name}`);
    }
    return [runDir(), shortSocketDir()].flatMap((dir) => {
      try {
        return readdirSync(dir)
          .filter((name) => name.endsWith(".sock"))
          .map((name) => path.join(dir, name));
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

/** Sends one message and waits for the first reply of a type. */
async function ask(
  socketPath: string,
  message: { type: "status" } | { type: "stop" },
  replyType: "status" | "stopped",
  timeoutMs: number,
): Promise<HostMessage | undefined> {
  const socket = await tryConnect(socketPath);
  if (!socket) return undefined;
  const reader = readMessages<HostMessage>(socket);
  return new Promise((resolve) => {
    const done = (reply: HostMessage | undefined) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(reply);
    };
    const timer = setTimeout(() => done(undefined), timeoutMs);
    reader.handle((reply) => {
      if (reply.type === replyType) done(reply);
    });
    socket.once("close", () => done(undefined));
    send(socket, message);
  });
}

/**
 * The session hosts that answer. Removes the socket files of hosts that
 * died.
 */
export async function listSessions(): Promise<FoundSession[]> {
  const found = await Promise.all(
    sessionSockets().map(async (socket) => {
      const reply = await ask(socket, { type: "status" }, "status", 2_000);
      if (reply?.type === "status") return { socket, info: reply.info };
      const alive = await tryConnect(socket);
      if (alive) alive.destroy();
      else if (process.platform !== "win32") rmSync(socket, { force: true });
      return undefined;
    }),
  );
  return found.filter((session): session is FoundSession => !!session);
}

/** Closes a session. */
export async function stopSession(socket: string): Promise<boolean> {
  const reply = await ask(socket, { type: "stop" }, "stopped", 5_000);
  return reply?.type === "stopped";
}

/** The socket of the session a system would use now. */
export function currentSocket(resolved: ResolvedSystem): string {
  return sessionFiles(resolved, getVersion()).socket;
}

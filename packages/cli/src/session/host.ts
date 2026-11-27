/**
 * @fileoverview The session host: a background process that holds the SSH
 * connection and SQL job of one system and runs the statements of later
 * `ibmi` commands on it. It listens on a Unix socket (a named pipe on
 * Windows) that only its own OS user can open.
 *
 * {@link startSessionHost} is the host itself, with the connection given as
 * functions so tests can run it in-process. `ibmi session-host` wires it to
 * the server's connection pool (commands/session-host.ts).
 *
 * @module cli/session/host
 */

import { chmodSync, rmSync } from "fs";
import net, { type Server, type Socket } from "net";
import {
  readMessages,
  send,
  toWireError,
  type ClientMessage,
  type HostMessage,
  type QueryRequest,
  type SessionInfo,
  type WireError,
} from "./protocol.js";

/** JSON-RPC codes after which the SQL job must not be used again. */
const FATAL_CODES = new Set([
  -32000, // ServiceUnavailable: the connection was lost
  -32004, // Timeout: the statement may still run on the job
  -32009, // InitializationFailed: the connection could not be opened again
]);

/** Whether an error leaves the session's SQL job unsafe to use again. */
export function isFatalSessionError(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "number" && FATAL_CODES.has(code);
}

export interface SessionHostOptions {
  socketPath: string;
  info: Pick<SessionInfo, "system" | "host" | "user" | "technique" | "version">;
  idleTimeoutMs: number;
  /** Opens the SSH connection and the SQL job. */
  connect(): Promise<void>;
  /** Runs one statement on the job. */
  execute(request: QueryRequest): Promise<unknown>;
  /** Closes the connection. */
  close(): Promise<void>;
  /** Writes one line to the session log. Never SQL text or parameters. */
  log(message: string): void;
  /** Called once the host has stopped. */
  onStopped(exitCode: number): void;
}

export interface SessionHost {
  /** Stops the host: closes the connection and removes the socket. */
  stop(reason: string, exitCode?: number): Promise<void>;
}

/**
 * Starts listening on the socket, then opens the connection.
 *
 * @throws the `listen` error. `EADDRINUSE` means another host has the socket.
 */
export async function startSessionHost(
  options: SessionHostOptions,
): Promise<SessionHost> {
  const startedAt = new Date();
  let lastUsed = Date.now();
  let state: SessionInfo["state"] | "failed" = "starting";
  let failure: WireError | undefined;
  let inFlight = 0;
  let idleTimer: NodeJS.Timeout | undefined;
  let stopping: Promise<void> | undefined;
  const clients = new Set<Socket>();
  const waiting = new Set<Socket>();

  const info = (): SessionInfo => ({
    ...options.info,
    pid: process.pid,
    state: state === "open" ? "open" : "starting",
    startedAt: startedAt.toISOString(),
    idleSeconds: Math.floor((Date.now() - lastUsed) / 1000),
    idleTimeoutSeconds: Math.round(options.idleTimeoutMs / 1000),
  });

  const armIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (inFlight > 0) armIdleTimer();
      else void stop("idle timeout");
    }, options.idleTimeoutMs);
    idleTimer.unref?.();
  };

  const stop = (reason: string, exitCode = 0): Promise<void> => {
    stopping ??= (async () => {
      options.log(`stopping: ${reason}`);
      clearTimeout(idleTimer);
      server.close();
      // Remove the socket now, not after the pool has closed: a command
      // that starts meanwhile then opens a new session instead of reaching
      // this one
      if (process.platform !== "win32") {
        rmSync(options.socketPath, { force: true });
      }
      // Commands that wait for the session get the reason. Without it they
      // would take the closed socket for a crash and start a new host.
      const closed: WireError = {
        code: -32000,
        message: `The SSH session was closed (${reason}).`,
      };
      for (const client of waiting) {
        client.end(`${JSON.stringify({ type: "failed", error: closed })}\n`);
      }
      waiting.clear();
      for (const client of clients) {
        if (!client.writableEnded) client.destroy();
      }
      try {
        await Promise.race([
          options.close(),
          new Promise((resolve) => setTimeout(resolve, 5_000).unref()),
        ]);
      } catch (error) {
        options.log(`close failed: ${toWireError(error).message}`);
      }
      options.log("stopped");
      options.onStopped(exitCode);
    })();
    return stopping;
  };

  const runQuery = async (client: Socket, request: QueryRequest) => {
    if (state !== "open") {
      send(client, {
        type: "result",
        id: request.id,
        ok: false,
        error: { code: -32000, message: "The session is not open." },
      });
      return;
    }
    inFlight++;
    lastUsed = Date.now();
    let reply: HostMessage;
    let fatal = false;
    try {
      const result = await options.execute(request);
      reply = { type: "result", id: request.id, ok: true, result };
    } catch (error) {
      fatal = isFatalSessionError(error);
      reply = {
        type: "result",
        id: request.id,
        ok: false,
        error: toWireError(error),
      };
    } finally {
      inFlight--;
      lastUsed = Date.now();
    }
    send(client, reply);
    if (fatal) {
      // The reply is written first, so the command still shows its error
      setImmediate(() => void stop("the SQL job is no longer usable", 1));
    } else {
      armIdleTimer();
    }
  };

  const onClient = (client: Socket) => {
    clients.add(client);
    client.on("close", () => {
      clients.delete(client);
      waiting.delete(client);
    });
    client.on("error", () => client.destroy());
    readMessages<ClientMessage>(client).handle((message) => {
      switch (message.type) {
        case "hello":
          // A command that reaches a host that stops opens a new session
          if (stopping) client.destroy();
          else if (state === "open")
            send(client, { type: "ready", info: info() });
          else if (state === "failed" && failure)
            send(client, { type: "failed", error: failure });
          else waiting.add(client);
          break;
        case "status":
          send(client, { type: "status", info: info() });
          break;
        case "stop":
          send(client, { type: "stopped" });
          void stop("disconnect");
          break;
        case "query":
          void runQuery(client, message);
          break;
        default:
          client.destroy();
      }
    });
  };

  const server: Server = net.createServer(onClient);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  if (process.platform !== "win32") chmodSync(options.socketPath, 0o600);
  options.log(
    `listening (pid ${process.pid}, ${options.info.user}@${options.info.host}, ${options.info.technique})`,
  );

  void (async () => {
    const begin = Date.now();
    try {
      await options.connect();
      state = "open";
      lastUsed = Date.now();
      options.log(`open after ${Date.now() - begin} ms`);
      for (const client of waiting)
        send(client, { type: "ready", info: info() });
      waiting.clear();
      armIdleTimer();
    } catch (error) {
      state = "failed";
      failure = toWireError(error);
      options.log(`could not connect: ${failure.message}`);
      for (const client of waiting)
        send(client, { type: "failed", error: failure });
      waiting.clear();
      // Let the replies reach the waiting commands, then stop
      setTimeout(() => void stop("could not connect", 1), 200);
    }
  })();

  return { stop };
}

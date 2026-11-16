/**
 * @fileoverview Messages between a CLI command and the session host of a
 * system: one JSON object per line over the session socket. No key,
 * passphrase or password is ever sent.
 *
 * @module cli/session/protocol
 */

import type { Socket } from "net";

/** What a session host reports about itself. */
export interface SessionInfo {
  system: string;
  host: string;
  user: string;
  technique: "tcp" | "cli";
  pid: number;
  version: string;
  state: "starting" | "open";
  startedAt: string;
  /** Seconds since the last command, or since the session opened. */
  idleSeconds: number;
  idleTimeoutSeconds: number;
}

/** A statement for the session's SQL job. */
export interface QueryRequest {
  type: "query";
  id: number;
  sql: string;
  params?: unknown[];
  rowsToFetch?: number;
  /** Fetch until done, as `executeQueryWithPagination` does. */
  paginate?: boolean;
  toolName?: string;
}

/** An error, as the fields of an `McpError`. */
export interface WireError {
  code: number;
  message: string;
  details?: Record<string, unknown>;
}

/** Command → session host. */
export type ClientMessage =
  | { type: "hello" }
  | QueryRequest
  | { type: "status" }
  | { type: "stop" };

/** Session host → command. */
export type HostMessage =
  | { type: "ready"; info: SessionInfo }
  | { type: "failed"; error: WireError }
  | { type: "status"; info: SessionInfo }
  | { type: "result"; id: number; ok: true; result: unknown }
  | { type: "result"; id: number; ok: false; error: WireError }
  | { type: "stopped" };

/** A line longer than this ends the connection. */
const MAX_LINE_BYTES = 256 * 1024 * 1024;

/** Writes one message. */
export function send(socket: Socket, message: ClientMessage | HostMessage) {
  if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
}

/**
 * Reads the messages that arrive on a socket. `handle` can be replaced at
 * any time; each message goes to the handler set when it arrives.
 */
export function readMessages<T>(socket: Socket) {
  let handler: (message: T) => void = () => {};
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    if (buffer.length > MAX_LINE_BYTES) {
      socket.destroy(new Error("Session message too large"));
      return;
    }
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      let message: T;
      try {
        message = JSON.parse(line) as T;
      } catch {
        socket.destroy(new Error("Session message is not valid JSON"));
        return;
      }
      handler(message);
    }
  });
  return {
    handle(next: (message: T) => void) {
      handler = next;
    },
  };
}

/** An error as plain fields that survive JSON. */
export function toWireError(error: unknown): WireError {
  const code = (error as { code?: unknown })?.code;
  const details = (error as { details?: unknown })?.details;
  let safeDetails: Record<string, unknown> | undefined;
  if (details && typeof details === "object") {
    try {
      safeDetails = JSON.parse(JSON.stringify(details)) as Record<
        string,
        unknown
      >;
    } catch {
      // Details that do not serialize are left out
    }
  }
  return {
    code: typeof code === "number" ? code : -32603,
    message: error instanceof Error ? error.message : String(error),
    ...(safeDetails ? { details: safeDetails } : {}),
  };
}

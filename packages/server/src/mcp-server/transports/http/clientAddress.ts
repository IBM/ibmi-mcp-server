/**
 * @fileoverview Where a request came from. The one place that decides whether
 * proxy headers are believed (`MCP_TRUST_PROXY`).
 * @module src/mcp-server/transports/http/clientAddress
 */

import type { Context } from "hono";
import { config } from "@/config/index.js";

/**
 * The client's address: the TCP peer, which the caller cannot forge. Behind a
 * trusted proxy (`MCP_TRUST_PROXY=true`) the peer is the proxy, so the address
 * it reports in X-Forwarded-For is used instead: the last entry, which is the
 * one the proxy wrote. Earlier entries are whatever the caller sent to a
 * proxy that appends. Without that setting the header is ignored: any caller
 * can write it.
 * Tolerates test environments where no Node socket is attached.
 */
export function clientAddress(c: Context): string {
  const forwarded = config.mcpTrustProxy
    ? c.req.header("x-forwarded-for")?.split(",").at(-1)?.trim()
    : undefined;
  const socketAddress = (
    c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined
  )?.incoming?.socket?.remoteAddress;
  return forwarded || socketAddress || "unknown_ip";
}

/**
 * Whether the client reached the server over TLS. The server itself listens
 * on plain HTTP, so only a trusted proxy's X-Forwarded-Proto can say so. The
 * request URL cannot: a caller chooses its scheme with an absolute-form
 * request target.
 */
export function clientUsedTls(c: Context): boolean {
  return config.mcpTrustProxy && c.req.header("x-forwarded-proto") === "https";
}

/**
 * @fileoverview Where a request came from. The one place that decides whether
 * proxy headers are believed (`MCP_TRUSTED_PROXIES`).
 * @module src/mcp-server/transports/http/clientAddress
 */

import { BlockList, isIP } from "node:net";
import type { Context } from "hono";
import { config } from "@/config/index.js";

/** Tells whether an address is inside a set of CIDR ranges. */
export type AddressMatcher = (address: string | undefined) => boolean;

/**
 * An IP address in one spelling, so that two spellings of the same address
 * compare equal: IPv6 in its canonical compressed form without a zone, an
 * IPv4-mapped IPv6 address (`::ffff:10.0.0.1`) as the IPv4 address.
 *
 * @returns `undefined` when `address` is not an IP address.
 */
export function normalizeAddress(
  address: string | undefined,
): string | undefined {
  const bare = address?.trim().replace(/%.*$/, "") ?? "";
  const family = isIP(bare);
  if (family === 4) {
    return bare;
  }
  if (family !== 6 || !URL.canParse(`http://[${bare}]`)) {
    return undefined;
  }
  const canonical = new URL(`http://[${bare}]`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
  if (!mapped) {
    return canonical;
  }
  const high = parseInt(mapped[1]!, 16);
  const low = parseInt(mapped[2]!, 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

/**
 * Builds a matcher for IPv4 and IPv6 ranges.
 *
 * @param cidrs - `address/prefix` entries, as the configuration holds them.
 * @throws If an entry is not a valid range.
 */
export function cidrMatcher(cidrs: readonly string[]): AddressMatcher {
  const ranges = new BlockList();
  for (const cidr of cidrs) {
    const [network = "", prefix] = cidr.split("/");
    ranges.addSubnet(
      network,
      Number(prefix),
      isIP(network) === 6 ? "ipv6" : "ipv4",
    );
  }
  return (address) => {
    const normalized = normalizeAddress(address);
    return (
      normalized !== undefined &&
      ranges.check(normalized, isIP(normalized) === 6 ? "ipv6" : "ipv4")
    );
  };
}

/** Whether `address` is 127.0.0.0/8 or ::1, in any spelling. */
export const isLoopbackAddress: AddressMatcher = cidrMatcher([
  "127.0.0.0/8",
  "::1/128",
]);

// Rebuilt when the configured list is replaced (tests do that).
let trustedProxies:
  | { cidrs: readonly string[]; matches: AddressMatcher }
  | undefined;

/** Whether `address` is one of the proxies in `MCP_TRUSTED_PROXIES`. */
export const isTrustedProxy: AddressMatcher = (address) => {
  if (trustedProxies?.cidrs !== config.mcpTrustedProxies) {
    trustedProxies = {
      cidrs: config.mcpTrustedProxies,
      matches: cidrMatcher(config.mcpTrustedProxies),
    };
  }
  return trustedProxies.matches(address);
};

/**
 * The address a trusted proxy reports: the right-most X-Forwarded-For hop
 * that is not itself a trusted proxy. Hops to its left are whatever the
 * caller sent, so the walk stops there. It also stops at an entry that is
 * not an IP address: nothing beyond it can be relied on.
 */
function forwardedClient(
  forwardedFor: string | undefined,
  trusted: AddressMatcher,
): string | undefined {
  for (const hop of (forwardedFor ?? "").split(",").reverse()) {
    const address = normalizeAddress(hop);
    if (!address) {
      return undefined;
    }
    if (!trusted(address)) {
      return address;
    }
  }
  return undefined;
}

/**
 * The client's address: the TCP peer, which the caller cannot forge. When the
 * peer is a trusted proxy (`MCP_TRUSTED_PROXIES`), the address is the
 * right-most X-Forwarded-For hop that is not itself a trusted proxy; if the
 * header has no such hop, the peer. From any other peer the header is
 * ignored: any caller can write it.
 *
 * @param peerAddress - The remote address of the TCP connection.
 * @param forwardedFor - The X-Forwarded-For header value.
 * @returns `undefined` when `peerAddress` is not an IP address.
 */
export function resolveClientAddress(
  peerAddress: string | undefined,
  forwardedFor: string | undefined,
  trusted: AddressMatcher = isTrustedProxy,
): string | undefined {
  const peer = normalizeAddress(peerAddress);
  return peer !== undefined && trusted(peer)
    ? (forwardedClient(forwardedFor, trusted) ?? peer)
    : peer;
}

/** The headers a proxy reports the client in. */
export interface ForwardingHeaders {
  forwardedFor?: string;
  forwarded?: string;
  realIp?: string;
}

/** The client address, or why the request's forwarding cannot be relied on. */
export type VerifiedClientAddress =
  | { address: string }
  | {
      refused:
        | "no_peer_address"
        | "forwarded_by_untrusted_peer"
        | "no_forwarded_address";
    };

/**
 * `resolveClientAddress` for the sign-on routes, which refuse a request
 * instead of guessing. Refused are: a peer that is not a trusted proxy but
 * sends X-Forwarded-For, Forwarded or X-Real-IP (a proxy is in front that
 * `MCP_TRUSTED_PROXIES` does not name, and every user would appear at its
 * address), and a trusted proxy whose X-Forwarded-For has no usable hop.
 */
export function verifyClientAddress(
  peerAddress: string | undefined,
  headers: ForwardingHeaders,
  trusted: AddressMatcher = isTrustedProxy,
): VerifiedClientAddress {
  const peer = normalizeAddress(peerAddress);
  if (peer === undefined) {
    return { refused: "no_peer_address" };
  }
  if (!trusted(peer)) {
    return headers.forwardedFor !== undefined ||
      headers.forwarded !== undefined ||
      headers.realIp !== undefined
      ? { refused: "forwarded_by_untrusted_peer" }
      : { address: peer };
  }
  const address = forwardedClient(headers.forwardedFor, trusted);
  return address ? { address } : { refused: "no_forwarded_address" };
}

/** The request's TCP socket. Absent in tests that attach no Node socket. */
function socketOf(
  c: Context,
): { remoteAddress?: string; encrypted?: boolean } | undefined {
  return (
    c.env as
      | {
          incoming?: {
            socket?: { remoteAddress?: string; encrypted?: boolean };
          };
        }
      | undefined
  )?.incoming?.socket;
}

/** `resolveClientAddress` for a request; `unknown_ip` without a socket. */
export function clientAddress(c: Context): string {
  return (
    resolveClientAddress(
      socketOf(c)?.remoteAddress,
      c.req.header("x-forwarded-for"),
    ) ?? "unknown_ip"
  );
}

/** `verifyClientAddress` for a request. */
export function verifiedClientAddress(c: Context): VerifiedClientAddress {
  return verifyClientAddress(socketOf(c)?.remoteAddress, {
    forwardedFor: c.req.header("x-forwarded-for"),
    forwarded: c.req.header("forwarded"),
    realIp: c.req.header("x-real-ip"),
  });
}

/**
 * Whether the client reached the server over TLS. From a trusted proxy that
 * is what the proxy reports (`X-Forwarded-Proto: https`), also when the
 * proxy's own connection to the server is TLS: the client may have reached
 * the proxy in clear. From any other peer it is whether the connection
 * itself is TLS (`MCP_TLS_CERT_FILE`). The request URL cannot say so: a
 * caller chooses its scheme with an absolute-form request target.
 */
export function clientUsedTls(c: Context): boolean {
  const socket = socketOf(c);
  return isTrustedProxy(socket?.remoteAddress)
    ? c.req.header("x-forwarded-proto") === "https"
    : socket?.encrypted === true;
}

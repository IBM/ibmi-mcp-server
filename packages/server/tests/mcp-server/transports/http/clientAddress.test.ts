/**
 * @fileoverview Tests for the client address rule: the TCP peer, or what a
 * proxy listed in MCP_TRUSTED_PROXIES reports.
 */

import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { config } from "../../../../src/config/index.js";
import {
  cidrMatcher,
  clientAddress,
  clientUsedTls,
  isLoopbackAddress,
  isTrustedProxy,
  normalizeAddress,
  resolveClientAddress,
  verifiedClientAddress,
  verifyClientAddress,
} from "../../../../src/mcp-server/transports/http/clientAddress.js";

/** Two proxy hops: an edge range and one internal load balancer. */
const trusted = cidrMatcher(["10.0.0.0/24", "192.168.7.7/32", "fd00::/8"]);

describe("normalizeAddress", () => {
  it.each([
    ["10.1.2.3", "10.1.2.3"],
    [" 10.1.2.3 ", "10.1.2.3"],
    ["::ffff:10.1.2.3", "10.1.2.3"],
    ["::FFFF:0a01:0203", "10.1.2.3"],
    ["0:0:0:0:0:ffff:10.1.2.3", "10.1.2.3"],
    ["2001:DB8:0:0:0:0:0:1", "2001:db8::1"],
    ["::1", "::1"],
    ["fe80::1%en0", "fe80::1"],
  ])("reads %s as %s", (given, expected) => {
    expect(normalizeAddress(given)).toBe(expected);
  });

  it.each([
    undefined,
    "",
    "unknown",
    "10.1.2.3:8080",
    "[::1]:8080",
    "10.1.2",
    "example.com",
    "10.1.2.3, 10.1.2.4",
  ])("does not take %s for an address", (given) => {
    expect(normalizeAddress(given)).toBeUndefined();
  });
});

describe("cidrMatcher", () => {
  it("matches IPv4 ranges", () => {
    const inRange = cidrMatcher(["172.16.0.0/12", "192.168.1.5/32"]);
    expect(inRange("172.16.0.1")).toBe(true);
    expect(inRange("172.31.255.255")).toBe(true);
    expect(inRange("172.32.0.0")).toBe(false);
    expect(inRange("192.168.1.5")).toBe(true);
    expect(inRange("192.168.1.6")).toBe(false);
  });

  it("matches IPv6 ranges", () => {
    const inRange = cidrMatcher(["fc00::/7", "::1/128"]);
    expect(inRange("fd12:3456::1")).toBe(true);
    expect(inRange("FC00:0:0:0:0:0:0:1")).toBe(true);
    expect(inRange("fe80::1")).toBe(false);
    expect(inRange("::1")).toBe(true);
    expect(inRange("::2")).toBe(false);
  });

  it("matches an IPv4-mapped IPv6 address against IPv4 ranges", () => {
    const inRange = cidrMatcher(["10.0.0.0/8"]);
    expect(inRange("::ffff:10.1.2.3")).toBe(true);
    expect(inRange("::ffff:a01:203")).toBe(true);
    expect(inRange("::ffff:11.1.2.3")).toBe(false);
  });

  it("keeps the address families apart", () => {
    expect(cidrMatcher(["0.0.0.0/0"])("2001:db8::1")).toBe(false);
    expect(cidrMatcher(["fc00::/7"])("252.0.0.1")).toBe(false);
    // Except that ::/0 is every address: IPv4 is ::ffff:0:0/96 inside it.
    expect(cidrMatcher(["::/0"])("10.1.2.3")).toBe(true);
  });

  it("matches nothing that is not an address", () => {
    const anything = cidrMatcher(["0.0.0.0/0", "::/0"]);
    expect(anything(undefined)).toBe(false);
    expect(anything("unknown")).toBe(false);
    expect(anything("10.1.2.3:80")).toBe(false);
  });

  it("matches nothing when the list is empty", () => {
    expect(cidrMatcher([])("127.0.0.1")).toBe(false);
  });

  it.each(["10.0.0.0/33", "10.0.0.0", "nonsense/8", "fd00::/129"])(
    "throws for the invalid range %s",
    (cidr) => {
      expect(() => cidrMatcher([cidr])).toThrow();
    },
  );
});

describe("isLoopbackAddress", () => {
  it.each(["127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1", "0:0::1"])(
    "is true for %s",
    (address) => {
      expect(isLoopbackAddress(address)).toBe(true);
    },
  );

  it.each(["128.0.0.1", "10.0.0.1", "::2", "localhost", undefined])(
    "is false for %s",
    (address) => {
      expect(isLoopbackAddress(address)).toBe(false);
    },
  );
});

describe("resolveClientAddress", () => {
  it("is the TCP peer when the peer is not a trusted proxy", () => {
    expect(resolveClientAddress("203.0.113.9", undefined, trusted)).toBe(
      "203.0.113.9",
    );
  });

  it("ignores X-Forwarded-For from a peer that is not a trusted proxy", () => {
    expect(resolveClientAddress("203.0.113.9", "10.0.0.5", trusted)).toBe(
      "203.0.113.9",
    );
    // No proxy is trusted by default.
    expect(resolveClientAddress("10.0.0.1", "198.51.100.1", () => false)).toBe(
      "10.0.0.1",
    );
  });

  it("is the hop a trusted proxy reports", () => {
    expect(resolveClientAddress("10.0.0.1", "198.51.100.1", trusted)).toBe(
      "198.51.100.1",
    );
  });

  it("is the right-most hop that is not a trusted proxy", () => {
    expect(
      resolveClientAddress(
        "10.0.0.1",
        "198.51.100.1, 192.168.7.7, 10.0.0.9",
        trusted,
      ),
    ).toBe("198.51.100.1");
  });

  it("ignores a spoofed left-most entry", () => {
    // The caller sent "X-Forwarded-For: 127.0.0.1"; the proxy appended the
    // address it saw.
    expect(
      resolveClientAddress("10.0.0.1", "127.0.0.1, 198.51.100.1", trusted),
    ).toBe("198.51.100.1");
    expect(
      resolveClientAddress(
        "10.0.0.1",
        "127.0.0.1,10.20.30.40 , 198.51.100.1, 10.0.0.9",
        trusted,
      ),
    ).toBe("198.51.100.1");
  });

  it("recognises a trusted proxy that connects as an IPv4-mapped IPv6 peer", () => {
    expect(
      resolveClientAddress("::ffff:10.0.0.1", "198.51.100.1", trusted),
    ).toBe("198.51.100.1");
  });

  it("normalises an IPv4-mapped peer and an IPv4-mapped hop", () => {
    expect(resolveClientAddress("::ffff:203.0.113.9", undefined, trusted)).toBe(
      "203.0.113.9",
    );
    expect(
      resolveClientAddress("10.0.0.1", "::ffff:198.51.100.1", trusted),
    ).toBe("198.51.100.1");
  });

  it("handles IPv6 proxies and clients", () => {
    expect(
      resolveClientAddress("fd00::1", "2001:DB8::7, fd00::2", trusted),
    ).toBe("2001:db8::7");
  });

  it.each([
    ["no header", undefined],
    ["an empty header", ""],
    ["only trusted proxies", "10.0.0.9, 192.168.7.7"],
    ["an entry that is not an address", "198.51.100.1, unknown"],
    ["an entry with a port", "198.51.100.1:4711"],
  ])("falls back to the proxy itself given %s", (_name, forwardedFor) => {
    expect(resolveClientAddress("10.0.0.1", forwardedFor, trusted)).toBe(
      "10.0.0.1",
    );
  });

  it("does not read past an entry that is not an address", () => {
    // Whatever is left of it was not vouched for by a proxy we understand.
    expect(
      resolveClientAddress(
        "10.0.0.1",
        "198.51.100.1, garbage, 10.0.0.9",
        trusted,
      ),
    ).toBe("10.0.0.1");
  });

  it("is undefined without a peer address", () => {
    expect(
      resolveClientAddress(undefined, "198.51.100.1", trusted),
    ).toBeUndefined();
    expect(
      resolveClientAddress("not-an-address", undefined, trusted),
    ).toBeUndefined();
  });
});

describe("verifyClientAddress", () => {
  it("accepts a direct client that sends no forwarding header", () => {
    expect(verifyClientAddress("::ffff:203.0.113.9", {}, trusted)).toEqual({
      address: "203.0.113.9",
    });
  });

  it.each([
    ["X-Forwarded-For", { forwardedFor: "198.51.100.1" }],
    ["Forwarded", { forwarded: "for=198.51.100.1" }],
    ["X-Real-IP", { realIp: "198.51.100.1" }],
    ["an empty X-Forwarded-For", { forwardedFor: "" }],
  ])("refuses %s from a peer that is not a trusted proxy", (_name, headers) => {
    expect(verifyClientAddress("203.0.113.9", headers, trusted)).toEqual({
      refused: "forwarded_by_untrusted_peer",
    });
  });

  it("accepts the hop a trusted proxy reports, ignoring a spoofed left-most entry", () => {
    expect(
      verifyClientAddress(
        "::ffff:10.0.0.1",
        { forwardedFor: "127.0.0.1, 198.51.100.1, 192.168.7.7" },
        trusted,
      ),
    ).toEqual({ address: "198.51.100.1" });
  });

  it("does not hold Forwarded or X-Real-IP against a trusted proxy", () => {
    expect(
      verifyClientAddress(
        "10.0.0.1",
        {
          forwardedFor: "198.51.100.1",
          forwarded: "for=198.51.100.1",
          realIp: "198.51.100.1",
        },
        trusted,
      ),
    ).toEqual({ address: "198.51.100.1" });
  });

  it.each([
    ["no X-Forwarded-For", {}],
    ["only trusted hops", { forwardedFor: "10.0.0.9" }],
    ["an unusable hop", { forwardedFor: "198.51.100.1, unknown" }],
    ["only X-Real-IP", { realIp: "198.51.100.1" }],
  ])("refuses a trusted proxy that reports %s", (_name, headers) => {
    expect(verifyClientAddress("10.0.0.1", headers, trusted)).toEqual({
      refused: "no_forwarded_address",
    });
  });

  it("refuses a request without a peer address", () => {
    expect(verifyClientAddress(undefined, {}, trusted)).toEqual({
      refused: "no_peer_address",
    });
  });
});

describe("with MCP_TRUSTED_PROXIES from the configuration", () => {
  const saved = config.mcpTrustedProxies;

  const app = new Hono();
  app.get("/", (c) =>
    c.json({
      address: clientAddress(c),
      tls: clientUsedTls(c),
      verified: verifiedClientAddress(c),
    }),
  );

  /** A request as the Node adapter presents it: the socket on `c.env`. */
  const get = async (
    socket: { remoteAddress?: string; encrypted?: boolean } | undefined,
    headers: Record<string, string> = {},
  ) => {
    const res = await app.request(
      "/",
      { headers },
      socket ? { incoming: { socket } } : undefined,
    );
    return (await res.json()) as {
      address: string;
      tls: boolean;
      verified: { address?: string; refused?: string };
    };
  };

  beforeEach(() => {
    config.mcpTrustedProxies = [];
  });

  afterEach(() => {
    config.mcpTrustedProxies = saved;
  });

  it("trusts no proxy by default", async () => {
    expect(isTrustedProxy("127.0.0.1")).toBe(false);
    expect(
      await get(
        { remoteAddress: "10.0.0.1" },
        { "x-forwarded-for": "198.51.100.1", "x-forwarded-proto": "https" },
      ),
    ).toEqual({
      address: "10.0.0.1",
      tls: false,
      verified: { refused: "forwarded_by_untrusted_peer" },
    });
  });

  it("follows the configured list when it is replaced", async () => {
    config.mcpTrustedProxies = ["10.0.0.0/24"];
    expect(isTrustedProxy("10.0.0.1")).toBe(true);
    expect(isTrustedProxy("10.0.1.1")).toBe(false);

    config.mcpTrustedProxies = ["10.0.1.0/24"];
    expect(isTrustedProxy("10.0.0.1")).toBe(false);
    expect(isTrustedProxy("10.0.1.1")).toBe(true);
  });

  it("takes the address and the scheme from a trusted proxy", async () => {
    config.mcpTrustedProxies = ["10.0.0.0/24"];
    expect(
      await get(
        { remoteAddress: "::ffff:10.0.0.1" },
        {
          "x-forwarded-for": "127.0.0.1, 198.51.100.1",
          "x-forwarded-proto": "https",
        },
      ),
    ).toEqual({
      address: "198.51.100.1",
      tls: true,
      verified: { address: "198.51.100.1" },
    });
  });

  it("does not take X-Forwarded-Proto from a trusted proxy that says http", async () => {
    config.mcpTrustedProxies = ["10.0.0.0/24"];
    const seen = await get(
      { remoteAddress: "10.0.0.1" },
      { "x-forwarded-for": "198.51.100.1", "x-forwarded-proto": "http" },
    );
    expect(seen.tls).toBe(false);
  });

  it("takes a trusted proxy's word, not its own TLS connection to the server, for how the client reached it", async () => {
    config.mcpTrustedProxies = ["10.0.0.0/24"];
    const viaProxy = async (proto?: string) =>
      (
        await get(
          { remoteAddress: "10.0.0.1", encrypted: true },
          {
            "x-forwarded-for": "198.51.100.1",
            ...(proto === undefined ? {} : { "x-forwarded-proto": proto }),
          },
        )
      ).tls;

    // The proxy re-encrypts, and the client reached the proxy in clear.
    expect(await viaProxy("http")).toBe(false);
    expect(await viaProxy()).toBe(false);
    expect(await viaProxy("https")).toBe(true);
  });

  it("sees TLS when the connection itself is TLS", async () => {
    expect(
      await get({ remoteAddress: "203.0.113.9", encrypted: true }),
    ).toEqual({
      address: "203.0.113.9",
      tls: true,
      verified: { address: "203.0.113.9" },
    });
  });

  it("does not take a plain connection's word that it used TLS", async () => {
    const seen = await get(
      { remoteAddress: "203.0.113.9" },
      { "x-forwarded-proto": "https" },
    );
    expect(seen.tls).toBe(false);
  });

  it("tolerates a request with no socket attached", async () => {
    expect(await get(undefined, { "x-forwarded-proto": "https" })).toEqual({
      address: "unknown_ip",
      tls: false,
      verified: { refused: "no_peer_address" },
    });
  });
});

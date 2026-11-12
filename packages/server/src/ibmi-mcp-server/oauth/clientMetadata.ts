/**
 * @fileoverview Client ID Metadata Documents
 * (draft-ietf-oauth-client-id-metadata-document): a `client_id` that is an
 * `https` URL names a JSON document listing the client's redirect URIs. This
 * module fetches that document and reads the list from it.
 *
 * The URL comes from an unauthenticated request, so the fetch is restricted:
 * only to addresses that are globally routable (the connection is made to the
 * address that was checked), no redirect is followed, and the answer must be
 * `200`, at most `MAX_DOCUMENT_BYTES`, within `FETCH_TIMEOUT_MS`.
 * @module src/ibmi-mcp-server/oauth/clientMetadata
 */

import { lookup } from "node:dns";
import { request } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { z } from "zod";
import type { FetchClientDocument, OAuthClient } from "./contracts.js";

/** Longest document read, in bytes. */
export const MAX_DOCUMENT_BYTES = 5 * 1024;
const FETCH_TIMEOUT_MS = 5_000;
/** How long a document that was read is used without fetching it again. */
const CACHE_MS = 5 * 60_000;
const MAX_CACHED = 100;
/** Fetches in progress at once; a request beyond that is refused. */
const MAX_FETCHES = 8;

/** IPv4 ranges that are not globally routable (IANA special-purpose registry). */
const SPECIAL_IPV4 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const) {
  SPECIAL_IPV4.addSubnet(network, prefix, "ipv4");
}
/** IPv6 global unicast, and the ranges inside it that are not routable. */
const GLOBAL_IPV6 = new BlockList();
GLOBAL_IPV6.addSubnet("2000::", 3, "ipv6");
const SPECIAL_IPV6 = new BlockList();
for (const [network, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const) {
  SPECIAL_IPV6.addSubnet(network, prefix, "ipv6");
}

/** Whether an IP address is globally routable: not private, loopback, link-local or reserved. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    return !SPECIAL_IPV4.check(address, "ipv4");
  }
  return (
    family === 6 &&
    GLOBAL_IPV6.check(address, "ipv6") &&
    !SPECIAL_IPV6.check(address, "ipv6")
  );
}

/**
 * Resolves a host name for the fetch and fails unless every address it has is
 * public. The socket connects to what this returns, so the address checked is
 * the address used.
 */
const publicLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) {
      callback(error, "", 0);
    } else if (
      addresses.length === 0 ||
      !addresses.every((entry) => isPublicAddress(entry.address))
    ) {
      callback(
        new Error(`${hostname} does not resolve to a public address`),
        "",
        0,
      );
    } else if (options.all) {
      callback(null, addresses);
    } else {
      callback(null, addresses[0]!.address, addresses[0]!.family);
    }
  });
};

/** Fetches a client metadata document over the network, as described above. */
export const fetchClientDocument: FetchClientDocument = (url) =>
  new Promise((resolve, reject) => {
    // `lookup` is not called for an IP address, and no certificate names one
    // a client would publish at.
    if (isIP(url.hostname.replace(/^\[|\]$/g, "")) !== 0) {
      reject(new Error("the host is an IP address"));
      return;
    }
    const outgoing = request(
      url,
      {
        agent: false,
        headers: { Accept: "application/json" },
        lookup: publicLookup,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      },
      (response) => {
        if (response.statusCode !== 200) {
          outgoing.destroy(
            new Error(`the answer was HTTP ${response.statusCode}`),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_DOCUMENT_BYTES) {
            outgoing.destroy(
              new Error(`it is larger than ${MAX_DOCUMENT_BYTES} bytes`),
            );
          } else {
            chunks.push(chunk);
          }
        });
        response.on("end", () => resolve(Buffer.concat(chunks)));
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });

/** The members of a document this server reads. Others are ignored. */
const ClientDocument = z.object({
  client_id: z.string(),
  client_name: z.string(),
  redirect_uris: z.array(z.string()).min(1),
  // Clients are public here: a document that asks for client authentication
  // describes a client this server cannot authenticate.
  token_endpoint_auth_method: z.literal("none").optional(),
});

/**
 * Reads the redirect URIs from a client metadata document.
 *
 * @param clientId - The URL the document was fetched from.
 * @throws {Error} When the body is not such a document, or its `client_id`
 *   is not exactly `clientId`.
 */
export function readClientDocument(clientId: string, body: Buffer): string[] {
  let json: unknown;
  try {
    json = JSON.parse(body.toString());
  } catch {
    throw new Error("it is not JSON");
  }
  const parsed = ClientDocument.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      "it needs client_id, client_name and redirect_uris, and no client authentication",
    );
  }
  if (parsed.data.client_id !== clientId) {
    throw new Error("its client_id is not the URL it was fetched from");
  }
  return parsed.data.redirect_uris;
}

type UrlClient = Extract<OAuthClient, { kind: "url" }>;

/**
 * Creates the function that completes a URL client with the redirect URIs of
 * its document. A document that was read is kept for `CACHE_MS`; a failure is
 * never kept. The function rejects with an `Error` whose message says, for a
 * person, why the document cannot be used.
 */
export function createClientDocumentReader(
  fetchDocument: FetchClientDocument,
): (client: UrlClient) => Promise<UrlClient> {
  const cache = new Map<string, { redirectUris: string[]; until: number }>();
  const fetching = new Map<string, Promise<string[]>>();
  return async (client) => {
    const { clientId } = client;
    const cached = cache.get(clientId);
    if (cached && cached.until > Date.now()) {
      return { ...client, redirectUris: cached.redirectUris };
    }
    let pending = fetching.get(clientId);
    if (!pending) {
      if (fetching.size >= MAX_FETCHES) {
        throw new Error("this server is reading too many documents; try again");
      }
      pending = fetchDocument(new URL(clientId))
        .then((body) => readClientDocument(clientId, body))
        .finally(() => fetching.delete(clientId));
      fetching.set(clientId, pending);
    }
    const redirectUris = await pending;
    cache.delete(clientId);
    cache.set(clientId, { redirectUris, until: Date.now() + CACHE_MS });
    if (cache.size > MAX_CACHED) {
      cache.delete(cache.keys().next().value!);
    }
    return { ...client, redirectUris };
  };
}

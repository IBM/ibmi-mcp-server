/**
 * @fileoverview Tests for reading Client ID Metadata Documents: which
 * addresses a document may be fetched from, what a document must hold, and
 * how the reader keeps what it read. No test fetches from the network.
 */

import { describe, expect, it } from "vitest";
import {
  createClientDocumentReader,
  fetchClientDocument,
  isPublicAddress,
  readClientDocument,
} from "../../../src/ibmi-mcp-server/oauth/clientMetadata.js";
import type { OAuthClient } from "../../../src/ibmi-mcp-server/oauth/contracts.js";

const CLIENT_ID = "https://client.example/oauth/metadata.json";
const REDIRECTS = ["http://127.0.0.1/callback"];

const urlClient = (clientId: string = CLIENT_ID) =>
  ({ kind: "url", clientId }) satisfies OAuthClient;

const body = (document: unknown) => Buffer.from(JSON.stringify(document));

const document = (clientId: string = CLIENT_ID) => ({
  client_id: clientId,
  client_name: "Test client",
  redirect_uris: REDIRECTS,
});

/** Why a promise rejected. */
const reasonOf = (promise: Promise<unknown>): Promise<string> =>
  promise.then(
    () => "resolved",
    (error: Error) => error.message,
  );

describe("isPublicAddress", () => {
  it.each(["93.184.216.34", "8.8.8.8", "2606:4700::6810:84e5", "2a00:1450::1"])(
    "accepts %s",
    (address) => {
      expect(isPublicAddress(address)).toBe(true);
    },
  );

  it.each([
    ["loopback", "127.0.0.1"],
    ["loopback, another address", "127.8.8.8"],
    ["private 10/8", "10.1.2.3"],
    ["private 172.16/12", "172.31.255.255"],
    ["private 192.168/16", "192.168.1.1"],
    ["carrier-grade NAT", "100.64.0.1"],
    ["link-local, where cloud metadata lives", "169.254.169.254"],
    ["this network", "0.0.0.0"],
    ["documentation", "203.0.113.9"],
    ["benchmarking", "198.18.0.1"],
    ["multicast", "224.0.0.1"],
    ["reserved", "240.0.0.1"],
    ["broadcast", "255.255.255.255"],
    ["IPv6 loopback", "::1"],
    ["IPv6 unspecified", "::"],
    ["IPv6 unique local", "fd00::1"],
    ["IPv6 link-local", "fe80::1"],
    ["IPv6 multicast", "ff02::1"],
    ["IPv6 documentation", "2001:db8::1"],
    ["Teredo", "2001::1"],
    ["6to4, which can carry a private IPv4 address", "2002:0a00:0001::1"],
    ["an IPv4-mapped private address", "::ffff:10.0.0.1"],
    ["an IPv4-mapped public address", "::ffff:8.8.8.8"],
    ["NAT64", "64:ff9b::808:808"],
    ["a host name", "client.example"],
    ["nothing", ""],
  ])("refuses %s", (_what, address) => {
    expect(isPublicAddress(address)).toBe(false);
  });
});

describe("fetchClientDocument", () => {
  it.each([
    ["an IPv4 address as host", "https://93.184.216.34/client.json"],
    ["an IPv6 address as host", "https://[2606:4700::1]/client.json"],
  ])("refuses %s", async (_what, url) => {
    expect(await reasonOf(fetchClientDocument(new URL(url)))).toBe(
      "the host is an IP address",
    );
  });

  it("refuses a host name that resolves to this machine, before connecting", async () => {
    expect(
      await reasonOf(fetchClientDocument(new URL("https://localhost/c.json"))),
    ).toBe("localhost does not resolve to a public address");
  });
});

describe("readClientDocument", () => {
  it("returns the redirect URIs and ignores other members", () => {
    expect(
      readClientDocument(
        CLIENT_ID,
        body({
          ...document(),
          token_endpoint_auth_method: "none",
          client_uri: "https://client.example",
          logo_uri: "https://client.example/logo.png",
          grant_types: ["authorization_code"],
        }),
      ),
    ).toEqual(REDIRECTS);
  });

  it.each([
    ["a body that is not JSON", Buffer.from("<html>"), "it is not JSON"],
    ["an empty body", Buffer.alloc(0), "it is not JSON"],
    ["JSON that is not an object", body([document()]), "it needs client_id"],
    [
      "no client_id",
      body({ client_name: "x", redirect_uris: REDIRECTS }),
      "it needs client_id",
    ],
    [
      "no client_name",
      body({ client_id: CLIENT_ID, redirect_uris: REDIRECTS }),
      "it needs client_id",
    ],
    [
      "no redirect_uris",
      body({ client_id: CLIENT_ID, client_name: "x" }),
      "it needs client_id",
    ],
    [
      "an empty redirect_uris",
      body({ ...document(), redirect_uris: [] }),
      "it needs client_id",
    ],
    [
      "a redirect URI that is not a string",
      body({ ...document(), redirect_uris: [REDIRECTS[0], 7] }),
      "it needs client_id",
    ],
    [
      "client authentication",
      body({ ...document(), token_endpoint_auth_method: "client_secret_post" }),
      "no client authentication",
    ],
    [
      "the client_id of another document",
      body(document("https://client.example/oauth/other.json")),
      "its client_id is not the URL it was fetched from",
    ],
    [
      "its own client_id in another spelling",
      body(document("https://CLIENT.example/oauth/metadata.json")),
      "its client_id is not the URL it was fetched from",
    ],
  ])("refuses %s", (_what, bytes, reason) => {
    expect(() => readClientDocument(CLIENT_ID, bytes)).toThrow(reason);
  });
});

describe("createClientDocumentReader", () => {
  it("completes the client and fetches its document once while it is kept", async () => {
    const fetched: string[] = [];
    const read = createClientDocumentReader(async (url) => {
      fetched.push(url.href);
      return body(document());
    });
    const client = urlClient();
    expect(await read(client)).toEqual({ ...client, redirectUris: REDIRECTS });
    expect(await read(client)).toEqual({ ...client, redirectUris: REDIRECTS });
    expect(fetched).toEqual([CLIENT_ID]);
  });

  it("fetches once for requests that arrive together", async () => {
    let fetches = 0;
    const read = createClientDocumentReader(async () => {
      fetches += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return body(document());
    });
    const results = await Promise.all([read(urlClient()), read(urlClient())]);
    expect(results.map((client) => client.redirectUris)).toEqual([
      REDIRECTS,
      REDIRECTS,
    ]);
    expect(fetches).toBe(1);
  });

  it("keeps no failure: the next request fetches again", async () => {
    const answers: Array<() => Buffer> = [
      () => {
        throw new Error("the answer was HTTP 503");
      },
      () => Buffer.from("not json"),
      () => body(document()),
    ];
    let fetches = 0;
    const read = createClientDocumentReader(async () => answers[fetches++]!());
    expect(await reasonOf(read(urlClient()))).toBe("the answer was HTTP 503");
    expect(await reasonOf(read(urlClient()))).toBe("it is not JSON");
    expect((await read(urlClient())).redirectUris).toEqual(REDIRECTS);
    expect(fetches).toBe(3);
  });

  it("refuses to fetch more than 8 documents at once, and fetches again when one is done", async () => {
    const release: Array<() => void> = [];
    const read = createClientDocumentReader(
      (url) =>
        new Promise((resolve) => {
          release.push(() => resolve(body(document(url.href))));
        }),
    );
    const id = (n: number) => `https://client.example/${n}.json`;
    const waiting = Array.from({ length: 8 }, (_, n) => read(urlClient(id(n))));
    expect(await reasonOf(read(urlClient(id(8))))).toContain(
      "too many documents",
    );
    release.forEach((done) => done());
    await Promise.all(waiting);
    release.length = 0;
    const next = read(urlClient(id(8)));
    release[0]!();
    expect((await next).clientId).toBe(id(8));
  });

  it("keeps the 100 documents read last", async () => {
    const fetched: string[] = [];
    const read = createClientDocumentReader(async (url) => {
      fetched.push(url.href);
      return body(document(url.href));
    });
    const id = (n: number) => `https://client.example/${n}.json`;
    for (let n = 0; n <= 100; n += 1) {
      await read(urlClient(id(n)));
    }
    fetched.length = 0;
    await read(urlClient(id(100)));
    await read(urlClient(id(1)));
    expect(fetched).toEqual([]);
    // The first one read was dropped for the 101st.
    await read(urlClient(id(0)));
    expect(fetched).toEqual([id(0)]);
  });
});

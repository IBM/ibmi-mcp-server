/**
 * @fileoverview Tests for client ids, registration and the rule for where an
 * authorization code may be sent.
 */

import { describe, expect, it } from "vitest";
import {
  describeClient,
  isLoopbackRedirect,
  isRedirectAllowed,
  parseClientId,
  registerClient,
} from "../../../src/ibmi-mcp-server/oauth/clients.js";
import {
  MAX_CLIENT_ID_BYTES,
  MAX_CLIENT_REDIRECT_URIS,
  type ClientRegistration,
  type OAuthClient,
  type RedirectPolicy,
} from "../../../src/ibmi-mcp-server/oauth/contracts.js";

/** The default configuration. */
const DEFAULT: RedirectPolicy = {
  allowLoopbackRedirects: true,
  redirectUris: [],
  clientMetadataDocuments: true,
};
const NO_LOOPBACK: RedirectPolicy = {
  allowLoopbackRedirects: false,
  redirectUris: [],
  clientMetadataDocuments: true,
};
const LISTED = "https://app.example.com/oauth/callback";
const WITH_LISTED: RedirectPolicy = {
  allowLoopbackRedirects: true,
  redirectUris: [LISTED],
  clientMetadataDocuments: true,
};

const URL_CLIENT: OAuthClient = {
  kind: "url",
  clientId: "https://client.example.com/metadata.json",
};

/** Whether the destination rule alone allows a URI: the client lists exactly it. */
const destinationAllowed = (uri: string, policy: RedirectPolicy): boolean =>
  isRedirectAllowed({ ...URL_CLIENT, redirectUris: [uri] }, uri, policy);

// Written as code points: in a string they could not be told apart or seen.
const RIGHT_TO_LEFT_OVERRIDE = String.fromCodePoint(0x202e);
const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);
const CYRILLIC_A = String.fromCodePoint(0x430);

const selfId = (payload: unknown) =>
  "self." + Buffer.from(JSON.stringify(payload)).toString("base64url");

const selfClient = (...redirectUris: string[]): OAuthClient => ({
  kind: "self",
  clientId: selfId({ redirect_uris: redirectUris }),
  redirectUris,
});

const registered = (
  metadata: unknown,
  policy: RedirectPolicy = DEFAULT,
): ClientRegistration => {
  const result = registerClient(metadata, policy);
  if ("error" in result) {
    throw new Error(`registration refused: ${result.error}`);
  }
  return result;
};

describe("isLoopbackRedirect", () => {
  it.each([
    "http://127.0.0.1/",
    "http://127.0.0.1",
    "http://127.0.0.1:33418/",
    "http://127.0.0.1:1/callback",
    "http://127.0.0.1:65535/a/b/c?x=1",
    "http://localhost/callback",
    "http://localhost:6274/oauth/callback",
    "http://[::1]/",
    "http://[::1]:8080/callback",
  ])("accepts %s", (uri) => {
    expect(isLoopbackRedirect(uri)).toBe(true);
  });

  // The rule is applied to the URI as a browser reads it, so another
  // spelling of an accepted URI is accepted, and it leads to the same place.
  it.each([
    ["an upper-case scheme", "HTTP://127.0.0.1/callback"],
    ["an upper-case host", "http://LOCALHOST:3000/callback"],
    ["the long form of ::1", "http://[0:0:0:0:0:0:0:1]:9/callback"],
    ["a short form of 127.0.0.1", "http://127.1/callback"],
    ["a backslash, which starts the path", "http://127.0.0.1\\@evil.example/"],
    ["empty userinfo", "http://@127.0.0.1/"],
  ])("accepts %s", (_what, uri) => {
    expect(isLoopbackRedirect(uri)).toBe(true);
  });

  it.each([
    ["https", "https://127.0.0.1/callback"],
    ["https on localhost", "https://localhost:8443/callback"],
    ["another scheme", "ftp://127.0.0.1/"],
    ["a custom scheme", "cursor://127.0.0.1/callback"],
    ["javascript", "javascript://127.0.0.1/%0aalert(1)"],
    ["a user name", "http://user@127.0.0.1/"],
    ["a user name and password", "http://user:pw@localhost/"],
    ["a password alone", "http://:pw@127.0.0.1/"],
    ["the loopback host as user name", "http://127.0.0.1@evil.example/"],
    ["localhost and a port as userinfo", "http://localhost:80@evil.example/"],
    ["a fragment", "http://127.0.0.1/callback#fragment"],
    ["an empty fragment", "http://127.0.0.1/callback#"],
    ["a host that starts with localhost", "http://localhost.evil.example/"],
    ["a host that starts with 127.0.0.1", "http://127.0.0.1.evil.example/"],
    ["a host that ends with localhost", "http://evil-localhost/"],
    ["a subdomain of localhost", "http://app.localhost/"],
    ["localhost with a trailing dot", "http://localhost./"],
    ["another 127/8 address", "http://127.0.0.2/"],
    ["0.0.0.0", "http://0.0.0.0/"],
    ["a private address", "http://192.168.1.10/callback"],
    ["an IPv4-mapped loopback", "http://[::ffff:127.0.0.1]/"],
    ["another IPv6 address", "http://[::2]/"],
    ["an IPv6 zone", "http://[::1%25lo0]/"],
    ["::1 without brackets", "http://::1/"],
    ["a port out of range", "http://127.0.0.1:99999/"],
    ["a relative reference", "/callback"],
    ["a host alone", "127.0.0.1:8080"],
    ["nothing", ""],
  ])("refuses %s", (_what, uri) => {
    expect(isLoopbackRedirect(uri)).toBe(false);
  });
});

describe("isRedirectAllowed: the destination rule", () => {
  it("allows loopback destinations by default and nothing else", () => {
    expect(destinationAllowed("http://127.0.0.1:5000/", DEFAULT)).toBe(true);
    expect(destinationAllowed("http://localhost/cb", DEFAULT)).toBe(true);
    expect(destinationAllowed("http://[::1]:1/cb", DEFAULT)).toBe(true);
    expect(destinationAllowed(LISTED, DEFAULT)).toBe(false);
    expect(destinationAllowed("https://vscode.dev/redirect", DEFAULT)).toBe(
      false,
    );
    expect(destinationAllowed("cursor://app/callback", DEFAULT)).toBe(false);
  });

  it("refuses loopback destinations when OAUTH_ALLOW_LOOPBACK_REDIRECTS is off", () => {
    expect(destinationAllowed("http://127.0.0.1:5000/", NO_LOOPBACK)).toBe(
      false,
    );
    expect(destinationAllowed("http://localhost/", NO_LOOPBACK)).toBe(false);
  });

  it("allows an exact entry of OAUTH_REDIRECT_URIS", () => {
    expect(destinationAllowed(LISTED, WITH_LISTED)).toBe(true);
    expect(
      destinationAllowed(LISTED, {
        allowLoopbackRedirects: false,
        redirectUris: ["https://other.example.com/cb", LISTED],
        clientMetadataDocuments: true,
      }),
    ).toBe(true);
  });

  it("reads a configured entry as a browser would", () => {
    const policy = {
      allowLoopbackRedirects: false,
      redirectUris: [
        "HTTPS://App.Example.com:443/oauth/callback",
        "https://bare.example.com",
      ],
      clientMetadataDocuments: true,
    };
    expect(destinationAllowed(LISTED, policy)).toBe(true);
    expect(destinationAllowed("https://bare.example.com/", policy)).toBe(true);
  });

  it("allows a custom-scheme entry", () => {
    const policy = {
      allowLoopbackRedirects: false,
      redirectUris: ["cursor://anysphere.cursor-mcp/oauth/callback"],
      clientMetadataDocuments: true,
    };
    expect(
      destinationAllowed(
        "cursor://anysphere.cursor-mcp/oauth/callback",
        policy,
      ),
    ).toBe(true);
    expect(
      destinationAllowed("cursor://anysphere.cursor-mcp/oauth/other", policy),
    ).toBe(false);
  });

  it.each([
    ["another path", "https://app.example.com/oauth/callback2"],
    ["a longer path", "https://app.example.com/oauth/callback/extra"],
    ["a trailing slash", "https://app.example.com/oauth/callback/"],
    ["a shorter path", "https://app.example.com/oauth"],
    ["a query", "https://app.example.com/oauth/callback?next=evil"],
    ["a fragment", "https://app.example.com/oauth/callback#x"],
    ["an empty fragment", "https://app.example.com/oauth/callback#"],
    ["another port", "https://app.example.com:8443/oauth/callback"],
    ["http", "http://app.example.com/oauth/callback"],
    ["a subdomain", "https://evil.app.example.com/oauth/callback"],
    ["a longer host", "https://app.example.com.evil.example/oauth/callback"],
    ["userinfo", "https://user@app.example.com/oauth/callback"],
    [
      "the listed host as userinfo",
      "https://app.example.com@evil.example/oauth/callback",
    ],
    [
      "path traversal out of the entry",
      "https://app.example.com/oauth/callback/../../evil",
    ],
    [
      "encoded path traversal",
      "https://app.example.com/oauth/callback/%2e%2e/%2e%2e/evil",
    ],
    ["a path that is another case", "https://app.example.com/OAuth/Callback"],
    ["an encoded path character", "https://app.example.com/oauth/c%61llback"],
    ["not a URI", "app.example.com/oauth/callback"],
  ])("refuses a URI that differs from the entry by %s", (_what, uri) => {
    expect(destinationAllowed(uri, WITH_LISTED)).toBe(false);
  });

  // The same URI in another spelling: a browser goes to the listed entry.
  it.each([
    ["an upper-case scheme and host", "HTTPS://APP.EXAMPLE.COM/oauth/callback"],
    ["the default port", "https://app.example.com:443/oauth/callback"],
    [
      "path traversal that ends at the entry",
      "https://app.example.com/oauth/x/../callback",
    ],
  ])("allows the entry written with %s", (_what, uri) => {
    expect(destinationAllowed(uri, WITH_LISTED)).toBe(true);
  });

  it("allows a loopback URI that is listed exactly although loopback is off", () => {
    const policy = {
      allowLoopbackRedirects: false,
      redirectUris: ["http://127.0.0.1:33418/"],
      clientMetadataDocuments: true,
    };
    expect(destinationAllowed("http://127.0.0.1:33418/", policy)).toBe(true);
    expect(destinationAllowed("http://127.0.0.1:33419/", policy)).toBe(false);
  });

  it("ignores a configured entry that is not a URI", () => {
    const policy = {
      allowLoopbackRedirects: false,
      redirectUris: ["nonsense"],
      clientMetadataDocuments: true,
    };
    expect(destinationAllowed("nonsense", policy)).toBe(false);
  });
});

describe("isRedirectAllowed: a self client's own list", () => {
  const vscode = selfClient("http://127.0.0.1/", "http://127.0.0.1:33418/");

  it("allows a URI of the id", () => {
    expect(isRedirectAllowed(vscode, "http://127.0.0.1:33418/", DEFAULT)).toBe(
      true,
    );
    expect(isRedirectAllowed(vscode, "http://127.0.0.1/", DEFAULT)).toBe(true);
  });

  it("allows a loopback URI of the id on any port", () => {
    expect(isRedirectAllowed(vscode, "http://127.0.0.1:54321/", DEFAULT)).toBe(
      true,
    );
    const claude = selfClient("http://localhost/callback");
    expect(
      isRedirectAllowed(claude, "http://localhost:41234/callback", DEFAULT),
    ).toBe(true);
  });

  it.each([
    ["another path", "http://127.0.0.1:33418/callback"],
    ["another loopback host", "http://localhost:33418/"],
    ["the IPv6 loopback", "http://[::1]:33418/"],
    ["a query", "http://127.0.0.1:33418/?next=x"],
  ])("refuses a loopback URI that differs from the id by %s", (_what, uri) => {
    expect(isRedirectAllowed(vscode, uri, DEFAULT)).toBe(false);
    // The destination itself is allowed: a client that lists it may use it.
    expect(destinationAllowed(uri, DEFAULT)).toBe(true);
  });

  it("holds a URL client to the redirect URIs of its document, as a self client to its id", () => {
    const client: OAuthClient = {
      ...URL_CLIENT,
      redirectUris: ["http://127.0.0.1/callback", LISTED],
    };
    expect(
      isRedirectAllowed(client, "http://127.0.0.1:50123/callback", DEFAULT),
    ).toBe(true);
    expect(isRedirectAllowed(client, LISTED, WITH_LISTED)).toBe(true);
    // In the document, but not a destination this server allows.
    expect(isRedirectAllowed(client, LISTED, DEFAULT)).toBe(false);
    // Allowed destinations the document does not list.
    expect(
      isRedirectAllowed(client, "http://127.0.0.1:50123/other", DEFAULT),
    ).toBe(false);
    expect(
      isRedirectAllowed(client, "http://localhost/callback", DEFAULT),
    ).toBe(false);
  });

  it("allows a URL client nothing before its document was read", () => {
    expect(isRedirectAllowed(URL_CLIENT, "http://127.0.0.1/", DEFAULT)).toBe(
      false,
    );
  });

  it("refuses an allowed destination that is not in the id", () => {
    expect(isRedirectAllowed(vscode, LISTED, WITH_LISTED)).toBe(false);
  });

  it("matches a listed URI of the id exactly, port included", () => {
    const client = selfClient(LISTED);
    expect(isRedirectAllowed(client, LISTED, WITH_LISTED)).toBe(true);
    const policy = {
      allowLoopbackRedirects: true,
      redirectUris: [LISTED, "https://app.example.com:8443/oauth/callback"],
      clientMetadataDocuments: true,
    };
    expect(
      isRedirectAllowed(
        client,
        "https://app.example.com:8443/oauth/callback",
        policy,
      ),
    ).toBe(false);
  });

  it("refuses a URI of the id that is no longer an allowed destination", () => {
    // Nothing signs an id: anyone can write one that names any URI.
    const forged = selfClient("https://evil.example/collect", LISTED);
    expect(
      isRedirectAllowed(forged, "https://evil.example/collect", WITH_LISTED),
    ).toBe(false);
    expect(isRedirectAllowed(forged, LISTED, DEFAULT)).toBe(false);
    expect(
      isRedirectAllowed(vscode, "http://127.0.0.1:33418/", NO_LOOPBACK),
    ).toBe(false);
  });
});

describe("registerClient", () => {
  // What VS Code sends. The redirect URIs are those of build spec D5.
  const VSCODE = {
    client_name: "Visual Studio Code",
    client_uri: "https://code.visualstudio.com",
    grant_types: [
      "authorization_code",
      "refresh_token",
      "urn:ietf:params:oauth:grant-type:device_code",
    ],
    response_types: ["code"],
    redirect_uris: [
      "https://insiders.vscode.dev/redirect",
      "https://vscode.dev/redirect",
      "http://127.0.0.1/",
      "http://127.0.0.1:33418/",
    ],
    token_endpoint_auth_method: "none",
    application_type: "native",
  };

  it("registers VS Code with only its two loopback URIs", () => {
    const result = registerClient(VSCODE, DEFAULT);
    expect(result).toEqual({
      client_id: expect.stringMatching(/^self\.[A-Za-z0-9_-]+$/),
      client_name: "Visual Studio Code",
      redirect_uris: ["http://127.0.0.1/", "http://127.0.0.1:33418/"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  });

  it("issues an id that reads back as the client and admits its redirects", () => {
    const { client_id: clientId } = registered(VSCODE);
    const client = parseClientId(clientId, DEFAULT);
    expect(client).toEqual({
      kind: "self",
      clientId,
      name: "Visual Studio Code",
      redirectUris: ["http://127.0.0.1/", "http://127.0.0.1:33418/"],
    });
    expect(isRedirectAllowed(client!, "http://127.0.0.1:33418/", DEFAULT)).toBe(
      true,
    );
    // The port VS Code falls back to when 33418 is taken.
    expect(isRedirectAllowed(client!, "http://127.0.0.1:50123/", DEFAULT)).toBe(
      true,
    );
    expect(
      isRedirectAllowed(client!, "https://vscode.dev/redirect", DEFAULT),
    ).toBe(false);
  });

  it("keeps a URI the operator listed", () => {
    const policy = {
      allowLoopbackRedirects: true,
      redirectUris: ["https://vscode.dev/redirect"],
      clientMetadataDocuments: true,
    };
    expect(registered(VSCODE, policy).redirect_uris).toEqual([
      "https://vscode.dev/redirect",
      "http://127.0.0.1/",
      "http://127.0.0.1:33418/",
    ]);
  });

  it("refuses a client that lists no allowed URI", () => {
    expect(
      registerClient(
        {
          client_name: "Hosted",
          redirect_uris: [
            "https://claude.ai/api/mcp/auth_callback",
            "https://vscode.dev/redirect",
          ],
        },
        DEFAULT,
      ),
    ).toEqual({ error: "invalid_redirect_uri" });
    expect(registerClient(VSCODE, NO_LOOPBACK)).toEqual({
      error: "invalid_redirect_uri",
    });
    expect(registerClient({ redirect_uris: [] }, DEFAULT)).toEqual({
      error: "invalid_redirect_uri",
    });
  });

  it("drops open-redirect attempts and keeps what is left", () => {
    expect(
      registered({
        redirect_uris: [
          "http://127.0.0.1@evil.example/",
          "http://localhost.evil.example/callback",
          "http://127.0.0.1.evil.example/callback",
          "http://user@127.0.0.1/callback",
          "http://127.0.0.1/callback#fragment",
          "https://127.0.0.1/callback",
          "not a uri",
          "http://localhost:6274/oauth/callback",
        ],
      }).redirect_uris,
    ).toEqual(["http://localhost:6274/oauth/callback"]);
  });

  it(`keeps the first ${MAX_CLIENT_REDIRECT_URIS} allowed URIs`, () => {
    const uris = Array.from({ length: 7 }, (_, i) => `http://localhost/cb${i}`);
    const result = registered({
      redirect_uris: ["https://dropped.example/", ...uris],
    });
    expect(result.redirect_uris).toEqual(
      uris.slice(0, MAX_CLIENT_REDIRECT_URIS),
    );
    expect(parseClientId(result.client_id, DEFAULT)).toMatchObject({
      redirectUris: uris.slice(0, MAX_CLIENT_REDIRECT_URIS),
    });
  });

  it.each([
    ["null", null],
    ["a string", "redirect_uris"],
    ["an array", ["http://127.0.0.1/"]],
    ["no redirect_uris", { client_name: "x" }],
    ["redirect_uris that is a string", { redirect_uris: "http://127.0.0.1/" }],
    ["a redirect URI that is not a string", { redirect_uris: [1] }],
  ])("refuses a body that is %s", (_what, body) => {
    expect(registerClient(body, DEFAULT)).toEqual({
      error: "invalid_client_metadata",
    });
  });

  it("refuses a registration whose id would exceed the size limit", () => {
    const path = "x".repeat(400);
    const body = {
      redirect_uris: [`http://localhost/${path}`, `http://127.0.0.1/${path}`],
    };
    expect(registerClient(body, DEFAULT)).toEqual({
      error: "invalid_client_metadata",
    });
    // Each of them alone fits.
    expect(
      Buffer.byteLength(
        registered({ redirect_uris: body.redirect_uris.slice(0, 1) }).client_id,
      ),
    ).toBeLessThanOrEqual(MAX_CLIENT_ID_BYTES);
  });

  it.each([
    ["a right-to-left override", `Trusted ${RIGHT_TO_LEFT_OVERRIDE})deifirev(`],
    ["a zero-width space", `Visual${ZERO_WIDTH_SPACE}Studio`],
    ["a line feed", "Visual Studio Code\nVerified by IBM"],
    ["a NUL", "a\0b"],
    ["nothing", ""],
    ["a number", 42],
  ])("registers without a name when the name is or has %s", (_what, name) => {
    const result = registered({
      client_name: name,
      redirect_uris: ["http://127.0.0.1/"],
    });
    expect(result.client_name).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("client_name");
    expect(parseClientId(result.client_id, DEFAULT)).toMatchObject({
      kind: "self",
      name: undefined,
    });
  });

  it("keeps a name in another script", () => {
    const result = registered({
      client_name: "Éditeur 編集",
      redirect_uris: ["http://127.0.0.1/"],
    });
    expect(result.client_name).toBe("Éditeur 編集");
    expect(parseClientId(result.client_id, DEFAULT)).toMatchObject({
      name: "Éditeur 編集",
    });
  });
});

describe("parseClientId", () => {
  it.each([
    "https://claude.ai/oauth/claude-code-client-metadata",
    "https://client.example.com/metadata.json",
    "https://client.example.com:8443/a/b.json?v=1",
  ])("reads the https URL %s as a URL client", (clientId) => {
    expect(parseClientId(clientId, DEFAULT)).toEqual({ kind: "url", clientId });
  });

  it.each([
    ["an http URL", "http://client.example.com/metadata.json"],
    ["an http loopback URL", "http://127.0.0.1/metadata.json"],
    ["another scheme", "ftp://client.example.com/"],
    ["a custom scheme", "cursor://client"],
    ["a plain name", "my-client"],
    ["a UUID", "6f1b1d1e-2b7c-4a57-9d0a-3c1f5e7a9b10"],
    ["https without a host", "https://"],
    ["an https URL without a path", "https://client.example.com"],
    ["an https URL with the root path", "https://client.example.com/"],
    ["an https URL with a fragment", "https://client.example.com/c.json#x"],
    ["an https URL with userinfo", "https://user@client.example.com/c.json"],
    ["an https URL with a dot segment", "https://client.example.com/a/../c"],
    ["an https URL that ends in a dot segment", "https://client.example.com/."],
    ["nothing", ""],
  ])("refuses %s", (_what, clientId) => {
    expect(parseClientId(clientId, DEFAULT)).toBeUndefined();
  });

  it("refuses a URL when OAUTH_CLIENT_METADATA_DOCUMENTS is off, and still reads a self id", () => {
    const off = { ...DEFAULT, clientMetadataDocuments: false };
    expect(
      parseClientId("https://client.example.com/metadata.json", off),
    ).toBeUndefined();
    expect(
      parseClientId(selfId({ redirect_uris: ["http://127.0.0.1/"] }), off),
    ).toMatchObject({ kind: "self" });
  });

  it("reads a self id without a name", () => {
    const clientId = selfId({ redirect_uris: ["http://127.0.0.1/"] });
    expect(parseClientId(clientId, DEFAULT)).toEqual({
      kind: "self",
      clientId,
      redirectUris: ["http://127.0.0.1/"],
    });
  });

  it("drops an unsafe name from a hand-written self id", () => {
    const clientId = selfId({
      name: `IBM${RIGHT_TO_LEFT_OVERRIDE} Sign-on`,
      redirect_uris: ["http://127.0.0.1/"],
    });
    expect(parseClientId(clientId, DEFAULT)).toEqual({
      kind: "self",
      clientId,
      redirectUris: ["http://127.0.0.1/"],
    });
  });

  it.each([
    ["no payload", "self."],
    ["a payload that is not base64url", "self.e30="],
    ["a payload with a character outside base64url", "self.e30+"],
    ["a payload that is not JSON", "self." + "bm90IGpzb24"],
    ["no redirect_uris", selfId({ name: "x" })],
    ["empty redirect_uris", selfId({ redirect_uris: [] })],
    ["redirect_uris that is a string", selfId({ redirect_uris: "http://x/" })],
    ["a redirect URI that is not a string", selfId({ redirect_uris: [null] })],
    ["a JSON array", selfId(["http://127.0.0.1/"])],
    ["JSON null", selfId(null)],
    [
      `more than ${MAX_CLIENT_REDIRECT_URIS} redirect URIs`,
      selfId({
        redirect_uris: Array.from(
          { length: MAX_CLIENT_REDIRECT_URIS + 1 },
          (_, i) => `http://127.0.0.1/${i}`,
        ),
      }),
    ],
    [
      "another prefix case",
      "SELF." + selfId({ redirect_uris: ["http://x/"] }).slice(5),
    ],
  ])("refuses a self id with %s", (_what, clientId) => {
    expect(parseClientId(clientId, DEFAULT)).toBeUndefined();
  });

  it("refuses a self id whose payload is base64 in another spelling", () => {
    // The question marks and angle brackets make the encodings differ.
    const json = JSON.stringify({
      redirect_uris: ["http://127.0.0.1/?>>>?>>>"],
    });
    const standard = Buffer.from(json).toString("base64");
    const urlSafe = Buffer.from(json).toString("base64url");
    expect(standard).toMatch(/[+/]/);
    expect(parseClientId(`self.${urlSafe}`, DEFAULT)).toMatchObject({
      kind: "self",
    });
    expect(parseClientId(`self.${standard}`, DEFAULT)).toBeUndefined();
    expect(parseClientId(`self.${urlSafe}==`, DEFAULT)).toBeUndefined();
    expect(parseClientId(`self.${urlSafe}\n`, DEFAULT)).toBeUndefined();
    expect(
      parseClientId(`self.${urlSafe.slice(0, 8)} ${urlSafe.slice(8)}`, DEFAULT),
    ).toBeUndefined();
  });

  it(`accepts ${MAX_CLIENT_ID_BYTES} bytes and refuses one more`, () => {
    const url = (length: number) =>
      "https://client.example.com/".padEnd(length, "x");
    expect(parseClientId(url(MAX_CLIENT_ID_BYTES), DEFAULT)).toMatchObject({
      kind: "url",
    });
    expect(
      parseClientId(url(MAX_CLIENT_ID_BYTES + 1), DEFAULT),
    ).toBeUndefined();

    // Bytes, not characters.
    const wide = "https://client.example.com/".padEnd(
      MAX_CLIENT_ID_BYTES - 1,
      "x",
    );
    expect(parseClientId(wide + "é", DEFAULT)).toBeUndefined();

    const long = selfId({
      redirect_uris: ["http://127.0.0.1/" + "x".repeat(MAX_CLIENT_ID_BYTES)],
    });
    expect(parseClientId(long, DEFAULT)).toBeUndefined();
  });
});

describe("describeClient", () => {
  it("shows a self client by the name it gave, and the destination", () => {
    const client = parseClientId(
      selfId({ name: "MCP Inspector", redirect_uris: ["http://localhost/cb"] }),
      DEFAULT,
    )!;
    expect(describeClient(client, "http://localhost:6274/cb")).toEqual({
      unverifiedName: "MCP Inspector",
      destination: "http://localhost:6274/cb",
    });
  });

  it("gives no name for a self client without one", () => {
    expect(
      describeClient(selfClient("http://127.0.0.1/"), "http://127.0.0.1:5/"),
    ).toEqual({ destination: "http://127.0.0.1:5/" });
  });

  it("shows a URL client by its id as parsed", () => {
    expect(describeClient(URL_CLIENT, LISTED)).toEqual({
      unverifiedName: "https://client.example.com/metadata.json",
      destination: LISTED,
    });
    // A look-alike host name is shown in its ASCII form.
    expect(
      describeClient(
        { kind: "url", clientId: `https://cl${CYRILLIC_A}ude.ai/client` },
        LISTED,
      ).unverifiedName,
    ).toBe("https://xn--clude-5ve.ai/client");
  });

  it("shows the destination as a browser reads it, without the query", () => {
    expect(
      describeClient(URL_CLIENT, "HTTP://LOCALHOST:8080/cb/../done?x=1&y=2")
        .destination,
    ).toBe("http://localhost:8080/done");
  });
});

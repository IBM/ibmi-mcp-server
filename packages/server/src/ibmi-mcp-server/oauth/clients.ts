/**
 * @fileoverview OAuth clients and where an authorization code may be sent.
 * Clients are public and nothing about them is stored. A client's own list
 * of redirect URIs comes from its `self.` id or from its metadata document
 * (clientMetadata.ts); either is only what the client says. The security
 * boundary is the destination rule, applied to URIs as the browser will read
 * them (WHATWG URL parsing), never to their text.
 * @module src/ibmi-mcp-server/oauth/clients
 */

import { z } from "zod";
import {
  MAX_CLIENT_ID_BYTES,
  MAX_CLIENT_REDIRECT_URIS,
  SELF_CLIENT_ID_PREFIX,
  type ClientRegistration,
  type OAuthClient,
  type RedirectPolicy,
} from "./contracts.js";

const LOOPBACK_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"];

/**
 * What a client calls itself, kept only when it has no control or formatting
 * characters: those can reorder or hide text on the sign-in page.
 */
const ClientName = z
  .string()
  .regex(/^[^\p{Cc}\p{Cf}]+$/u)
  .optional()
  .catch(undefined);

/** A `POST /oauth/register` body (RFC 7591). Other members are ignored. */
const RegistrationRequest = z.object({
  client_name: ClientName,
  redirect_uris: z.array(z.string()),
});

/** What a `self.` client id encodes. */
const SelfClientId = z.object({
  name: ClientName,
  redirect_uris: z.array(z.string()).min(1).max(MAX_CLIENT_REDIRECT_URIS),
});

/** A redirect URI, parsed; `undefined` when it is not a URI or has a fragment. */
function parseRedirect(redirectUri: string): URL | undefined {
  if (!URL.canParse(redirectUri)) {
    return undefined;
  }
  const url = new URL(redirectUri);
  return url.href.includes("#") ? undefined : url;
}

function isLoopback(url: URL): boolean {
  return (
    url.protocol === "http:" &&
    LOOPBACK_HOSTNAMES.includes(url.hostname) &&
    url.username === "" &&
    url.password === ""
  );
}

/** The destination rule: loopback when allowed, or an entry of `OAUTH_REDIRECT_URIS`. */
function isAllowedDestination(url: URL, policy: RedirectPolicy): boolean {
  return (
    (policy.allowLoopbackRedirects && isLoopback(url)) ||
    policy.redirectUris.some((entry) => parseRedirect(entry)?.href === url.href)
  );
}

function withoutPort(url: URL): string {
  const copy = new URL(url);
  copy.port = "";
  return copy.href;
}

/**
 * Whether a URI is a loopback destination: scheme `http`, host exactly
 * `localhost`, `127.0.0.1` or `[::1]`, any port, any path, no userinfo, no
 * fragment.
 */
export function isLoopbackRedirect(redirectUri: string): boolean {
  const url = parseRedirect(redirectUri);
  return url !== undefined && isLoopback(url);
}

/**
 * Whether an authorization code may be sent to `redirectUri` for `client`:
 * the URI is an allowed destination, and it is one of the client's own URIs
 * (those in a `self.` id, or in the document of a URL client). A loopback URI
 * matches one of the client's whatever the port: native clients listen on a
 * port chosen at run time.
 */
export function isRedirectAllowed(
  client: OAuthClient,
  redirectUri: string,
  policy: RedirectPolicy,
): boolean {
  const url = parseRedirect(redirectUri);
  if (!url || !isAllowedDestination(url, policy)) {
    return false;
  }
  return (client.redirectUris ?? []).some((own) => {
    const ownUrl = parseRedirect(own);
    return (
      ownUrl !== undefined &&
      (ownUrl.href === url.href ||
        (isLoopback(url) &&
          isLoopback(ownUrl) &&
          withoutPort(ownUrl) === withoutPort(url)))
    );
  });
}

/**
 * Whether a `client_id` has the form of a client metadata document URL:
 * `https`, a path other than `/` without dot segments, no userinfo and no
 * fragment.
 */
function isDocumentUrl(clientId: string): boolean {
  const url = parseRedirect(clientId);
  return (
    url !== undefined &&
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    url.pathname !== "/" &&
    !/\/\.{1,2}(\/|\?|$)/.test(clientId)
  );
}

/**
 * Reads a `client_id` of at most `MAX_CLIENT_ID_BYTES`: a `self.` id from
 * `registerClient`, or, with `OAUTH_CLIENT_METADATA_DOCUMENTS`, the URL of a
 * client metadata document. The redirect URIs of a `self.` id are not checked
 * here but on every use, by `isRedirectAllowed`: nothing signs the id, so
 * anyone can write one.
 */
export function parseClientId(
  clientId: string,
  policy: RedirectPolicy,
): OAuthClient | undefined {
  if (Buffer.byteLength(clientId) > MAX_CLIENT_ID_BYTES) {
    return undefined;
  }
  if (!clientId.startsWith(SELF_CLIENT_ID_PREFIX)) {
    return policy.clientMetadataDocuments && isDocumentUrl(clientId)
      ? { kind: "url", clientId }
      : undefined;
  }
  const encoded = clientId.slice(SELF_CLIENT_ID_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
    return undefined;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(encoded, "base64url").toString());
  } catch {
    return undefined;
  }
  const parsed = SelfClientId.safeParse(decoded);
  if (!parsed.success) {
    return undefined;
  }
  const { name, redirect_uris: redirectUris } = parsed.data;
  return { kind: "self", clientId, name, redirectUris };
}

/**
 * Handles a `POST /oauth/register` body: keeps the redirect URIs that are
 * allowed destinations (the first `MAX_CLIENT_REDIRECT_URIS` of them), drops
 * the rest, and returns the reduced list under a `self.` client id that
 * encodes it. Nothing is stored.
 *
 * @param metadata - The parsed JSON body.
 * @returns `invalid_redirect_uri` when no redirect URI survives;
 *   `invalid_client_metadata` when the body is not a registration or the id
 *   would exceed `MAX_CLIENT_ID_BYTES`.
 */
export function registerClient(
  metadata: unknown,
  policy: RedirectPolicy,
):
  | ClientRegistration
  | { error: "invalid_redirect_uri" | "invalid_client_metadata" } {
  const parsed = RegistrationRequest.safeParse(metadata);
  if (!parsed.success) {
    return { error: "invalid_client_metadata" };
  }
  const name = parsed.data.client_name;
  const redirectUris = parsed.data.redirect_uris
    .filter((uri) => {
      const url = parseRedirect(uri);
      return url !== undefined && isAllowedDestination(url, policy);
    })
    .slice(0, MAX_CLIENT_REDIRECT_URIS);
  if (redirectUris.length === 0) {
    return { error: "invalid_redirect_uri" };
  }
  const clientId =
    SELF_CLIENT_ID_PREFIX +
    Buffer.from(JSON.stringify({ name, redirect_uris: redirectUris })).toString(
      "base64url",
    );
  if (Buffer.byteLength(clientId) > MAX_CLIENT_ID_BYTES) {
    return { error: "invalid_client_metadata" };
  }
  return {
    client_id: clientId,
    client_name: name,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  };
}

/** What the sign-in page shows about who asks and where the code goes. */
export interface ClientDisplay {
  /**
   * What the client calls itself: the name in a `self.` id, or a URL id as
   * parsed (a host name in another script shows as `xn--`). Never verified,
   * and the page must say so: a document at that URL names the redirect URI,
   * but another program can present the same id. Absent when it gave no name.
   */
  unverifiedName?: string;
  /** Where the authorization code is sent: the redirect URI without its query. */
  destination: string;
}

/**
 * Describes a client for the sign-in page.
 *
 * @param redirectUri - A URI `isRedirectAllowed` accepted.
 */
export function describeClient(
  client: OAuthClient,
  redirectUri: string,
): ClientDisplay {
  const destination = new URL(redirectUri);
  destination.search = "";
  const unverifiedName =
    client.kind === "self" ? client.name : new URL(client.clientId).href;
  return { unverifiedName, destination: destination.href };
}

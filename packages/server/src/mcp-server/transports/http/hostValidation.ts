/**
 * @fileoverview DNS rebinding protection for the HTTP transport.
 * Provides a Hono middleware that validates the `Host` and `Origin` headers of
 * every incoming request against an allowlist, and a startup guard that refuses
 * to run an unauthenticated HTTP server on a routable interface while IBM i
 * credentials are present.
 *
 * Threat model: `Host`/`Origin` validation defends against browser-driven DNS
 * rebinding — a browser sets `Host` from the URL and forbids JavaScript from
 * overriding it, so a rebinding page cannot forge `Host: localhost`. It is NOT
 * a defense against attackers with direct network reach (who can forge any
 * header); that exposure is what {@link assertHttpSecurityPosture} addresses.
 * @module src/mcp-server/transports/http/hostValidation
 */

import { Context, Next } from "hono";
import { config } from "@/config/index.js";
import { JsonRpcErrorCode, McpError } from "../../../types-global/errors.js";
import {
  logger,
  RequestContext,
  requestContextService,
} from "@/utils/index.js";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "::1"]);
const WILDCARD_BINDS = new Set(["0.0.0.0", "::", ""]);

/**
 * Parses a `Host` header value into a normalized, lowercase hostname (no
 * port, no brackets). Returns null for anything that is not a bare
 * `host[:port]` authority — userinfo, paths, queries, or unparseable input.
 */
function hostnameOf(value: string): string | null {
  try {
    const url = new URL(`http://${value}`);
    // A Host header is authority-only; anything that parses into userinfo,
    // path, query, or fragment was not a bare host.
    if (
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    // WHATWG URL keeps brackets on IPv6 hostnames ("[::1]") and preserves a
    // trailing root dot ("localhost."). Strip both so request Hosts and
    // allowlist entries collapse to the same key — operators write
    // MCP_ALLOWED_HOSTS entries undotted, but DNS search-domain setups and
    // explicitly fully-qualified URLs do emit the dotted form.
    return url.hostname
      .replace(/^\[|\]$/g, "")
      .replace(/\.$/, "")
      .toLowerCase();
  } catch {
    return null;
  }
}

function isLoopback(hostname: string): boolean {
  return (
    LOOPBACK_HOSTNAMES.has(hostname) ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
    /^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
  );
}

/**
 * Source attribution for a rejected request.
 *
 * `clientIp` is the TCP peer address, which the caller cannot forge.
 * `forwardedFor` and `realIp` are proxy headers: authoritative only behind a
 * trusted proxy, and freely attacker-written otherwise.
 *
 * They are kept as separate, explicitly-claimed fields rather than collapsed
 * into `clientIp`. A rejection record is detection signal — if the field an
 * operator reads as "where did this come from" were sourced from a request
 * header, an attacker could attribute their own traffic to any address they
 * liked, or defeat per-source correlation by rotating it. Tolerates test
 * environments where no Node socket is attached.
 */
function requestSource(c: Context): {
  clientIp: string;
  forwardedFor?: string;
  realIp?: string;
} {
  const socketAddress = (
    c.env as
      | { incoming?: { socket?: { remoteAddress?: string } } }
      | undefined
  )?.incoming?.socket?.remoteAddress;
  return {
    clientIp: socketAddress || "unknown_ip",
    forwardedFor: c.req.header("x-forwarded-for"),
    realIp: c.req.header("x-real-ip"),
  };
}

/**
 * The resolved Host/Origin allowlist. Resolved once at app construction (not
 * module load) so CLI overrides are already applied and tests can mutate
 * `config` between cases.
 */
export interface HostPolicy {
  /** MCP_ALLOWED_HOSTS=* — Host checking disabled entirely. */
  allowAnyHost: boolean;
  /**
   * Explicit MCP_ALLOWED_HOSTS entries plus a non-wildcard bind host,
   * normalized to bare lowercase hostnames. Extends the built-in loopback
   * allowlist — loopback is always accepted and never listed here.
   */
  allowedHostnames: Set<string>;
  /** MCP_ALLOWED_ORIGINS entries, matched exactly against the Origin header. */
  allowedOrigins: string[];
}

export function resolveHostPolicy(parentContext?: RequestContext): HostPolicy {
  const context = requestContextService.createRequestContext({
    ...(parentContext ?? {}),
    operation: "resolveHostPolicy",
  });

  const entries = config.mcpAllowedHosts ?? [];
  const allowAnyHost = entries.includes("*");
  const allowedHostnames = new Set<string>();

  for (const entry of entries) {
    if (entry === "*") continue;
    const hostname = hostnameOf(entry);
    if (hostname) {
      allowedHostnames.add(hostname);
    } else {
      logger.warning(
        { ...context, entry },
        `Ignoring malformed MCP_ALLOWED_HOSTS entry: "${entry}"`,
      );
    }
  }

  // A non-wildcard bind host is safe to auto-allow: a rebinding attacker must
  // place their own hostname in Host, and they do not control the operator's
  // configured bind address.
  const bindHost = config.mcpHttpHost.toLowerCase();
  if (!WILDCARD_BINDS.has(bindHost)) {
    const bindHostname = bindHost.includes(":")
      ? hostnameOf(`[${bindHost}]`)
      : hostnameOf(bindHost);
    if (bindHostname && !isLoopback(bindHostname)) {
      allowedHostnames.add(bindHostname);
    }
  }

  if (allowAnyHost) {
    logger.warning(
      context,
      "MCP_ALLOWED_HOSTS=* - Host header validation is DISABLED. DNS rebinding protection depends on it; use only behind a reverse proxy that validates Host itself. Origin validation remains active.",
    );
  } else {
    logger.info(
      { ...context, allowedHostnames: [...allowedHostnames] },
      `DNS rebinding protection active. Host allowlist: loopback always, plus ${[...allowedHostnames].join(", ") || "no additional hosts"}`,
    );
  }

  return {
    allowAnyHost,
    allowedHostnames,
    allowedOrigins: config.mcpAllowedOrigins ?? [],
  };
}

/**
 * Hono middleware enforcing the Host/Origin allowlist on every route and
 * method. Registered on "*" ahead of CORS and all route handlers: CORS is a
 * browser read-policy and provides no rebinding protection (under rebinding
 * the request is same-origin and CORS never engages).
 */
export function createHostValidationMiddleware(policy: HostPolicy) {
  return async (c: Context, next: Next): Promise<void> => {
    /**
     * Rejects the request with a 403.
     *
     * The `message` crosses the wire to the caller — who, for the attack this
     * middleware exists to stop, is the attacker. It therefore names only the
     * class of failure: never the offending header value, never the
     * configuration variable that would allow it, never a remediation hint.
     * Everything an operator needs is on the `warning` below, which carries the
     * offending Host/Origin, the client IP, and the specific `reason`.
     */
    const reject = (reason: string, message: string): never => {
      const context = requestContextService.createRequestContext({
        operation: "hostValidation",
        path: c.req.path,
        method: c.req.method,
        hostHeader: c.req.header("host"),
        originHeader: c.req.header("origin"),
        ...requestSource(c),
        reason,
      });
      logger.warning(context, `Request rejected by host validation: ${reason}`);
      throw new McpError(JsonRpcErrorCode.Forbidden, message, context);
    };

    const INVALID_HOST = "Forbidden: invalid Host header.";

    if (!policy.allowAnyHost) {
      const rawHost = c.req.header("host");
      if (!rawHost) {
        reject("missing-host", INVALID_HOST);
      }
      const hostname = hostnameOf(rawHost!);
      if (!hostname) {
        reject("malformed-host", INVALID_HOST);
      } else if (
        !isLoopback(hostname) &&
        !policy.allowedHostnames.has(hostname)
      ) {
        reject("host-not-allowed", "Forbidden: Host not allowed.");
      }
    }

    // Origin has three states, not two. Absent → allow (non-browser MCP
    // clients send no Origin, and Host validation has already run). Valid →
    // must match MCP_ALLOWED_ORIGINS or resolve to an allowlisted hostname.
    // Degenerate — the literal "null" (sandboxed iframe, file://) or anything
    // unparseable — → reject. Degenerate must never fall through to the
    // absent branch: browsers send Origin on every non-GET/HEAD request, so a
    // rebinding page's only way to hide its origin is to degrade it to "null"
    // inside a sandboxed iframe.
    const rawOrigin = c.req.header("origin");
    if (rawOrigin !== undefined && !policy.allowedOrigins.includes(rawOrigin)) {
      let originHostname: string | null = null;
      if (rawOrigin !== "null") {
        try {
          originHostname = new URL(rawOrigin).hostname
            .replace(/^\[|\]$/g, "")
            .toLowerCase();
        } catch {
          originHostname = null;
        }
      }
      // Note: `allowAnyHost` deliberately does NOT relax this. MCP_ALLOWED_HOSTS=*
      // is documented as disabling *Host* checking for proxies that rewrite it;
      // a Host-rewriting proxy says nothing about Origin, and letting `*` also
      // disable Origin would silently surrender the last browser-facing control
      // — re-opening rebinding on a loopback-bound server where the posture
      // guard never fires.
      const originAllowed =
        originHostname !== null &&
        originHostname !== "" &&
        (isLoopback(originHostname) ||
          policy.allowedHostnames.has(originHostname));
      if (!originAllowed) {
        reject("origin-not-allowed", "Forbidden: Origin not allowed.");
      }
    }

    await next();
  };
}

/**
 * Reports whether the configured auth mode actually enforces authentication.
 *
 * `MCP_AUTH_MODE=jwt` does NOT imply enforcement: outside production a missing
 * `MCP_AUTH_SECRET_KEY` puts `JwtStrategy` into a dev bypass where `verify()`
 * returns a synthetic AuthInfo for any bearer token
 * (`strategies/jwtStrategy.ts`). Since `MCP_AUTH_SECRET_KEY` is optional and
 * `NODE_ENV` defaults to "development", that state is reachable with no
 * deliberate misconfiguration — so the posture guard must not treat "an auth
 * mode is named" as "requests are authenticated".
 */
function isAuthenticationEnforced(): boolean {
  if (config.mcpAuthMode === "none") return false;
  if (config.mcpAuthMode === "jwt" && !config.mcpAuthSecretKey) return false;
  return true;
}

/**
 * Startup guard: refuses to start when ALL of — transport is `http`,
 * authentication is not actually enforced, the bind host is non-loopback, and
 * the process holds IBM i credentials. "Holds credentials" means `config.db2i`
 * is set OR a tools YAML is configured: YAML `sources:` carry their own
 * credentials (possibly literals or arbitrary env vars), so gating on DB2i_*
 * env vars alone would miss the primary credential path. Override with
 * `MCP_ALLOW_UNAUTHENTICATED_HTTP=true`.
 */
export function assertHttpSecurityPosture(parentContext: RequestContext): void {
  const context = {
    ...parentContext,
    operation: "assertHttpSecurityPosture",
  };

  if (config.mcpTransportType !== "http") return;
  if (isAuthenticationEnforced()) return;

  const hasIbmiCredentials =
    Boolean(config.db2i) || Boolean(config.toolsYamlPath);
  if (!hasIbmiCredentials) return;

  // Name the actual reason auth is not enforced, so the operator is not sent
  // looking at MCP_AUTH_MODE when the real problem is a missing secret key.
  // ASCII only: this text passes through arbitrary log pipelines, and non-ASCII
  // punctuation survives some serializers as escape sequences.
  const authGap =
    config.mcpAuthMode === "none"
      ? "none - authentication is disabled"
      : `${config.mcpAuthMode} - MCP_AUTH_SECRET_KEY is unset, so no token is verified`;

  const credentialSources = [
    config.db2i ? "DB2i_* environment variables" : null,
    config.toolsYamlPath ? `tools YAML at ${config.toolsYamlPath}` : null,
  ]
    .filter(Boolean)
    .join(", ");

  // Facts as structured fields: queryable in an aggregator, and rendered
  // alongside the message by pino-pretty on a terminal.
  const postureContext = {
    ...context,
    bindHost: config.mcpHttpHost,
    authMode: config.mcpAuthMode,
    credentialSources,
  };

  const bindHost = config.mcpHttpHost.toLowerCase();
  if (isLoopback(bindHost)) {
    logger.warning(
      postureContext,
      `HTTP transport is unauthenticated with IBM i credentials configured. Auth mode: ${authGap}. The loopback bind and Host validation are the only protections - enable authentication for anything beyond local development.`,
    );
    return;
  }

  if (config.mcpAllowUnauthenticatedHttp) {
    logger.warning(
      postureContext,
      `Serving UNAUTHENTICATED HTTP off-host because MCP_ALLOW_UNAUTHENTICATED_HTTP=true. Bind host ${config.mcpHttpHost} is not loopback and auth mode is ${authGap}. Anyone able to reach this port can execute SQL tools with the server's IBM i credentials.`,
    );
    return;
  }

  // The formatted block goes to stderr rather than through the logger: pino
  // emits JSON with escaped newlines whenever output is not a TTY, which is
  // exactly the case for `docker logs`, systemd and CI, where the alignment
  // would collapse into an unreadable one-liner. stderr is safe here because
  // this path is HTTP-only - the stdio transport returns above, so the MCP
  // protocol stream on stdout is never touched.
  process.stderr.write(
    [
      "",
      "Refusing to start: the HTTP transport is unauthenticated and reachable",
      "off-host while IBM i credentials are configured.",
      "",
      `  Bind host    ${config.mcpHttpHost} - not loopback`,
      `  Auth mode    ${authGap}`,
      `  Credentials  ${credentialSources}`,
      "",
      "Anyone able to reach this port could execute SQL tools with the server's",
      "IBM i credentials.",
      "",
      "Resolve with one of:",
      "  Enable authentication   set MCP_AUTH_MODE, plus MCP_AUTH_SECRET_KEY when using jwt",
      "  Restrict to this host   set MCP_HTTP_HOST=127.0.0.1",
      "  Accept the risk         set MCP_ALLOW_UNAUTHENTICATED_HTTP=true",
      "",
      "",
    ].join("\n"),
  );

  // Single-line message so the structured record stays a clean one-liner; the
  // human-readable form was already written to stderr above.
  throw new McpError(
    JsonRpcErrorCode.ConfigurationError,
    `Refusing to start: unauthenticated HTTP transport on non-loopback bind ${config.mcpHttpHost} with IBM i credentials configured. Auth mode: ${authGap}. Set MCP_AUTH_MODE, or MCP_HTTP_HOST=127.0.0.1, or MCP_ALLOW_UNAUTHENTICATED_HTTP=true.`,
    postureContext,
  );
}

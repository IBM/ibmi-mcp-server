/**
 * @fileoverview Configures and starts the HTTP MCP transport using Hono.
 *
 * The MCP endpoint is served by the SDK's `createMcpHandler`: one stateless
 * handler that answers protocol revision 2026-07-28 and 2025-era clients,
 * building a fresh server instance per request. This module adds what the
 * SDK leaves to the host: Host/Origin validation, CORS, authentication, rate
 * limiting, the health endpoint, port binding (with TLS when
 * `MCP_TLS_CERT_FILE` is set) and, when users sign on with their IBM i
 * profile, the built-in authorization server.
 * @module src/mcp-server/transports/http/httpTransport
 */

import { createServer as createHttpsServer } from "node:https";
import { serve, ServerType } from "@hono/node-server";
import {
  createMcpHandler,
  type McpHttpHandler,
  type McpServerFactory,
} from "@modelcontextprotocol/server";
import { Context, Hono, Next } from "hono";
import { cors } from "hono/cors";
import { logger as honoLogger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { config } from "@/config/index.js";
import { handleAuthRequest, enforceTLS } from "@/ibmi-mcp-server/auth/index.js";
import { getPublicKeyMetadata } from "@/ibmi-mcp-server/auth/crypto.js";
import { startAdminSocket } from "@/ibmi-mcp-server/oauth/adminSocket.js";
import { createAuthorizationServer } from "@/ibmi-mcp-server/oauth/authorizationServer.js";
import type {
  AuthorizationServer,
  GrantManager,
  MapepireClient,
} from "@/ibmi-mcp-server/oauth/contracts.js";
import { createGrantManager } from "@/ibmi-mcp-server/oauth/grantManager.js";
import { setGrantQueryExecutor } from "@/ibmi-mcp-server/services/queryRouter.js";
import { SourceManager } from "@/ibmi-mcp-server/services/sourceManager.js";
import { JsonRpcErrorCode, McpError } from "@/types-global/errors.js";
import {
  logger,
  RateLimiter,
  rateLimiter,
  RequestContext,
  requestContextService,
  withRequestContext,
} from "@/utils/index.js";
import {
  authContext,
  createAuthMiddleware,
  createHttpAuth,
  type HttpAuth,
} from "../auth/index.js";
import { clientAddress } from "./clientAddress.js";
import { httpErrorHandler } from "./httpErrorHandler.js";
import { HonoNodeBindings } from "./httpTypes.js";
import {
  createHostValidationMiddleware,
  resolveHostPolicy,
} from "./hostValidation.js";
import { readSettingFile } from "./settingFile.js";

const MCP_ENDPOINT_PATH = config.mcpHttpEndpointPath;
const HEALTH_ENDPOINT_PATH = "/healthz";
/** How long in-flight requests get to finish when the transport closes. */
const CLOSE_GRACE_MS = 5000;

/**
 * Binds the HTTP server, with TLS when `MCP_TLS_CERT_FILE` and
 * `MCP_TLS_KEY_FILE` are set. A port that is already in use is a startup
 * error: clients, proxies and health checks are configured with this port,
 * so the server never moves to another one.
 *
 * @throws {McpError} `ConfigurationError` when the port is in use, or when a
 *   TLS file cannot be read or does not hold what its setting says.
 */
function listen(
  app: Hono<HonoAppEnv>,
  port: number,
  host: string,
  context: RequestContext,
): Promise<ServerType> {
  return new Promise((resolve, reject) => {
    const tls = config.mcpTlsCertFile &&
      config.mcpTlsKeyFile && {
        cert: readSettingFile("MCP_TLS_CERT_FILE", config.mcpTlsCertFile),
        key: readSettingFile("MCP_TLS_KEY_FILE", config.mcpTlsKeyFile),
      };
    const listening = (info: { address: string; port: number }) => {
      const serverAddress = `${tls ? "https" : "http"}://${info.address}:${info.port}${MCP_ENDPOINT_PATH}`;
      logger.info(
        { ...context, address: serverAddress },
        `HTTP transport listening at ${serverAddress}`,
      );
      if (process.stdout.isTTY) {
        console.log(`\n🚀 MCP Server running at: ${serverAddress}\n`);
      }
      resolve(server);
    };
    let server: ServerType;
    if (tls) {
      try {
        server = serve(
          {
            fetch: app.fetch,
            port,
            hostname: host,
            createServer: createHttpsServer,
            serverOptions: tls,
          },
          listening,
        );
      } catch (error) {
        // Node refuses a certificate or key it cannot parse, and a key that
        // is not the certificate's.
        throw new McpError(
          JsonRpcErrorCode.ConfigurationError,
          `MCP_TLS_CERT_FILE and MCP_TLS_KEY_FILE must hold a PEM certificate and its private key (${error instanceof Error ? error.message : String(error)}).`,
        );
      }
    } else {
      server = serve({ fetch: app.fetch, port, hostname: host }, listening);
    }
    server.once("error", (error: NodeJS.ErrnoException) =>
      reject(
        error.code === "EADDRINUSE"
          ? new McpError(
              JsonRpcErrorCode.ConfigurationError,
              `Port ${port} on ${host} is already in use. Stop the process using it, or set MCP_HTTP_PORT to a free port.`,
            )
          : error,
      ),
    );
  });
}

type HonoAppEnv = { Bindings: HonoNodeBindings };

/** The built-in IBM i sign-on, as the app serves it. */
export interface BuiltinSignOn {
  grants: Pick<GrantManager, "status">;
  authorizationServer: AuthorizationServer;
}

/**
 * Builds the Hono app around an MCP handler.
 *
 * @param mcpHandler - The SDK handler serving the MCP endpoint. Only `fetch`
 *   is used, so tests can pass a stub.
 * @param auth - From `createHttpAuth`; `null` leaves the MCP endpoint
 *   unauthenticated.
 * @param signOn - The built-in authorization server and its grants, when
 *   users sign on with their IBM i profile.
 */
export function createHttpApp(
  mcpHandler: Pick<McpHttpHandler, "fetch">,
  parentContext: RequestContext,
  auth: HttpAuth | null,
  signOn?: BuiltinSignOn,
): Hono<HonoAppEnv> {
  const app = new Hono<HonoAppEnv>();
  const transportContext = {
    ...parentContext,
    component: "HttpTransportSetup",
  };
  logger.info(transportContext, "Creating Hono HTTP application.");

  // 1. HTTP Access Logging. The query string is left out: it can carry
  //    credentials (RFC 6750 `access_token`), which must never be logged.
  const accessLogger = honoLogger((line, ...rest) =>
    console.log(line.replace(/\?\S*/, ""), ...rest),
  );
  app.use((c, next) =>
    c.req.path === HEALTH_ENDPOINT_PATH ? next() : accessLogger(c, next),
  );

  // 2. Security Headers. Not on the sign-in page of the built-in
  //    authorization server, which sets its own: these are written after the
  //    route has answered and would replace them, and a form posted from a
  //    page under their `Referrer-Policy: no-referrer` carries
  //    `Origin: null`.
  const secure = secureHeaders();
  const signInPath = signOn?.authorizationServer.paths.authorize;
  app.use((c, next) => (c.req.path === signInPath ? next() : secure(c, next)));

  // 3. DNS rebinding protection — Host/Origin allowlist. MUST precede CORS
  //    and all route handlers: CORS is a browser read-policy and provides no
  //    rebinding protection (under rebinding the request is same-origin and
  //    CORS never engages). Applying to "*" also covers /healthz and
  //    /api/v1/auth.
  const hostPolicy = resolveHostPolicy(transportContext);
  app.use("*", createHostValidationMiddleware(hostPolicy));

  // 4. CORS. Origins must be allowlisted explicitly via MCP_ALLOWED_ORIGINS;
  //    an empty list emits no Access-Control-Allow-Origin header at all.
  //    The allowed headers are the ones a browser client sends on a
  //    Streamable HTTP POST: the 2026-07-28 request-metadata headers
  //    (MCP-Protocol-Version, Mcp-Method, Mcp-Name) plus Content-Type and
  //    Authorization. No tool here declares `x-mcp-header`, so no
  //    Mcp-Param-* header exists to allow. WWW-Authenticate is exposed so a
  //    browser client can read the OAuth challenge on a 401 or 403.
  app.use(
    "*",
    cors({
      origin:
        config.mcpAllowedOrigins && config.mcpAllowedOrigins.length > 0
          ? config.mcpAllowedOrigins
          : [],
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: [
        "Content-Type",
        "Authorization",
        "MCP-Protocol-Version",
        "Mcp-Method",
        "Mcp-Name",
      ],
      exposeHeaders: ["WWW-Authenticate"],
      credentials: true,
    }),
  );

  // 5. Authentication and rate limiting (order matters). A request that
  //    authentication refuses counts against its client address, and is
  //    answered 429 instead once that budget is used up. An authenticated
  //    request counts against the caller's identity only, so users behind one
  //    address do not share a budget and refused requests from that address
  //    cannot lock them out. The prefixes keep the key spaces apart: an
  //    address can never name the bucket of an identity.
  const rateLimited = config.rateLimit.enabled;
  const addressKey = (c: Context) => `ip:${clientAddress(c)}`;
  const limit = (key: string, limiter = rateLimiter): void => {
    if (!rateLimited) {
      return;
    }
    const context = requestContextService.createRequestContext({
      operation: "httpRateLimitCheck",
      rateLimitKey: key,
    });
    try {
      limiter.check(key, context);
      logger.debug(context, "Rate limit check passed.");
    } catch (error) {
      logger.warning(
        { ...context, error: error as Error },
        "Rate limit check failed.",
      );
      throw error;
    }
  };
  /** Counts every request against its client address. */
  const limitAddress =
    (limiter = rateLimiter) =>
    async (c: Context, next: Next) => {
      limit(addressKey(c), limiter);
      await next();
    };

  if (auth) {
    app.use(
      MCP_ENDPOINT_PATH,
      createAuthMiddleware(auth, (c) => limit(addressKey(c))),
    );
    app.use(MCP_ENDPOINT_PATH, async (_c, next) => {
      // The subject comes before the client id: under OAuth one client
      // application (one client id) serves many users.
      const authInfo = authContext.getStore()?.authInfo;
      const subject = authInfo?.extra?.subject;
      limit(
        typeof subject === "string" && subject
          ? `sub:${subject}`
          : `client:${authInfo?.clientId}`,
      );
      await next();
    });
  } else {
    app.use(MCP_ENDPOINT_PATH, limitAddress());
  }

  // The OAuth Protected Resource Metadata is how an unauthenticated client
  // finds the authorization server, so it is not behind the auth middleware.
  const metadata = auth?.protectedResourceMetadata;
  metadata?.paths.forEach((path) => app.use(path, limitAddress()));

  // Neither are the routes of the built-in authorization server: a client
  // has no token until it has been through them. Host validation and CORS
  // above cover them like every other route.
  Object.values(signOn?.authorizationServer.paths ?? {}).forEach((path) =>
    app.use(path, limitAddress()),
  );

  logger.info(
    transportContext,
    rateLimited
      ? `Rate limiting enabled: ${config.rateLimit.maxRequests} requests per ${config.rateLimit.windowMs}ms window.`
      : "Rate limiting disabled via MCP_RATE_LIMIT_ENABLED=false.",
  );

  app.onError(httpErrorHandler);

  app.get(HEALTH_ENDPOINT_PATH, (c) => {
    if (signOn) {
      // There is no service pool in this mode. Counts only: no profile and
      // no grant id.
      const { grants, openConnections, maxConnections, blockedProfiles } =
        signOn.grants.status();
      return c.json({
        status: "ok",
        timestamp: new Date().toISOString(),
        signOn: { grants, openConnections, maxConnections, blockedProfiles },
      });
    }
    const pools = SourceManager.getInstance().getHealthSummary();
    const hasUnhealthy = Object.values(pools).some(
      (p) => p.healthStatus === "unhealthy",
    );
    return c.json({
      status: hasUnhealthy ? "degraded" : "ok",
      timestamp: new Date().toISOString(),
      pools,
    });
  });

  metadata?.paths.forEach((path) =>
    app.get(path, (c) => c.json(metadata.document)),
  );

  if (signOn) {
    app.route("/", signOn.authorizationServer.app);
  }

  // IBM i HTTP Authentication endpoint (conditional, deprecated)
  if (config.ibmiHttpAuth.enabled) {
    app.use("/api/v1/auth/*", async (c, next) => {
      c.header("Deprecation", "true");
      await next();
    });
    // Every sign-on is a password attempt against an IBM i profile, so the
    // endpoint has its own, much smaller budget per client address.
    const signOnLimiter = new RateLimiter({
      windowMs: 60_000,
      maxRequests: 10,
      skipInDevelopment: config.rateLimit.skipInDevelopment,
    });
    app.post(
      "/api/v1/auth",
      limitAddress(signOnLimiter),
      enforceTLS,
      handleAuthRequest,
    );
    app.get("/api/v1/auth/public-key", (c) => {
      const { keyId, publicKey } = getPublicKeyMetadata();
      return c.json({ keyId, publicKey });
    });
    logger.info(
      transportContext,
      "IBM i HTTP authentication endpoint enabled at /api/v1/auth",
    );
  }

  // The SDK handler owns the whole MCP endpoint: POST for both protocol
  // eras, 405 for GET and DELETE (there are no sessions and no standalone
  // SSE stream), 415 for a non-JSON body. Its Response is returned as-is.
  app.all(MCP_ENDPOINT_PATH, (c) =>
    withRequestContext(
      requestContextService.createRequestContext({
        operation: "handleMcpRequest",
        transport: "http",
      }),
      () =>
        mcpHandler.fetch(c.req.raw, {
          // Handlers read this as ctx.http.authInfo. The AsyncLocalStorage
          // authContext set by the auth middleware stays in effect too.
          authInfo: authContext.getStore()?.authInfo,
        }),
    ),
  );

  logger.info(transportContext, "Hono application setup complete.");
  return app;
}

/**
 * Starts the HTTP transport.
 *
 * @param createServerInstance - Factory the SDK calls once per request.
 * @param mapepire - From `createBuiltinMapepireClient`, when users sign on
 *   with their IBM i profile. The transport then runs the grant manager, the
 *   built-in authorization server and the admin socket.
 * @returns The MCP handler (for list-changed notifications) and a `close`
 *   that stops the handler and the HTTP server, then ends every sign-on,
 *   which closes its IBM i job.
 */
export async function startHttpTransport(
  createServerInstance: McpServerFactory,
  parentContext: RequestContext,
  mapepire?: MapepireClient,
): Promise<{ handler: McpHttpHandler; close: () => Promise<void> }> {
  const transportContext = {
    ...parentContext,
    component: "HttpTransportStart",
  };
  logger.info(transportContext, "Starting HTTP transport.");

  const handler = createMcpHandler(createServerInstance, {
    onerror: (error) =>
      logger.warning(
        { ...transportContext, err: error },
        "MCP handler reported an error.",
      ),
  });
  const grants = mapepire && createGrantManager({ mapepire });
  let adminSocket: { close(): Promise<void> } | undefined;
  const endSignOns = async (): Promise<void> => {
    await adminSocket?.close();
    await grants?.shutdown();
  };

  let server: ServerType;
  try {
    const app = createHttpApp(
      handler,
      transportContext,
      await createHttpAuth(transportContext, grants),
      grants && {
        grants,
        authorizationServer: createAuthorizationServer(grants),
      },
    );
    if (grants) {
      setGrantQueryExecutor(grants);
      grants.start();
      if (config.oauth.adminSocket) {
        adminSocket = await startAdminSocket(grants, config.oauth.adminSocket);
      }
    }
    server = await listen(
      app,
      config.mcpHttpPort,
      config.mcpHttpHost,
      transportContext,
    );
  } catch (error) {
    await endSignOns();
    throw error;
  }

  const close = async (): Promise<void> => {
    // server.close() waits for every open socket, including ones that never
    // sent a request or never finish one. After the grace period those are
    // cut off, so closing always completes.
    const cutOff = setTimeout(() => {
      if ("closeAllConnections" in server) {
        server.closeAllConnections();
      }
    }, CLOSE_GRACE_MS);
    try {
      await handler.close();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      clearTimeout(cutOff);
    } finally {
      await endSignOns();
    }
  };

  logger.info(transportContext, "HTTP transport started successfully.");
  return { handler, close };
}

/**
 * @fileoverview Configures and starts the HTTP MCP transport using Hono.
 *
 * The MCP endpoint is served by the SDK's `createMcpHandler`: one stateless
 * handler that answers protocol revision 2026-07-28 and 2025-era clients,
 * building a fresh server instance per request. This module adds what the
 * SDK leaves to the host: Host/Origin validation, CORS, authentication, rate
 * limiting, the health endpoint and port binding.
 * @module src/mcp-server/transports/http/httpTransport
 */

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

const MCP_ENDPOINT_PATH = config.mcpHttpEndpointPath;
const HEALTH_ENDPOINT_PATH = "/healthz";
/** How long in-flight requests get to finish when the transport closes. */
const CLOSE_GRACE_MS = 5000;

/**
 * Binds the HTTP server. A port that is already in use is a startup error:
 * clients, proxies and health checks are configured with this port, so the
 * server never moves to another one.
 */
function listen(
  app: Hono<HonoAppEnv>,
  port: number,
  host: string,
  context: RequestContext,
): Promise<ServerType> {
  return new Promise((resolve, reject) => {
    const server = serve(
      { fetch: app.fetch, port, hostname: host },
      (info: { address: string; port: number }) => {
        const serverAddress = `http://${info.address}:${info.port}${MCP_ENDPOINT_PATH}`;
        logger.info(
          { ...context, address: serverAddress },
          `HTTP transport listening at ${serverAddress}`,
        );
        if (process.stdout.isTTY) {
          console.log(`\n🚀 MCP Server running at: ${serverAddress}\n`);
        }
        resolve(server);
      },
    );
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

/**
 * Builds the Hono app around an MCP handler.
 *
 * @param mcpHandler - The SDK handler serving the MCP endpoint. Only `fetch`
 *   is used, so tests can pass a stub.
 * @param auth - From `createHttpAuth`; `null` leaves the MCP endpoint
 *   unauthenticated.
 */
export function createHttpApp(
  mcpHandler: Pick<McpHttpHandler, "fetch">,
  parentContext: RequestContext,
  auth: HttpAuth | null,
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

  // 2. Security Headers
  app.use(secureHeaders());

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

  logger.info(
    transportContext,
    rateLimited
      ? `Rate limiting enabled: ${config.rateLimit.maxRequests} requests per ${config.rateLimit.windowMs}ms window.`
      : "Rate limiting disabled via MCP_RATE_LIMIT_ENABLED=false.",
  );

  app.onError(httpErrorHandler);

  app.get(HEALTH_ENDPOINT_PATH, (c) => {
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
 * @returns The MCP handler (for list-changed notifications) and a `close`
 *   that stops the handler and the HTTP server.
 */
export async function startHttpTransport(
  createServerInstance: McpServerFactory,
  parentContext: RequestContext,
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
  const app = createHttpApp(
    handler,
    transportContext,
    await createHttpAuth(transportContext),
  );

  const server = await listen(
    app,
    config.mcpHttpPort,
    config.mcpHttpHost,
    transportContext,
  );

  const close = async (): Promise<void> => {
    // server.close() waits for every open socket, including ones that never
    // sent a request or never finish one. After the grace period those are
    // cut off, so closing always completes.
    const cutOff = setTimeout(() => {
      if ("closeAllConnections" in server) {
        server.closeAllConnections();
      }
    }, CLOSE_GRACE_MS);
    await handler.close();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    clearTimeout(cutOff);
  };

  logger.info(transportContext, "HTTP transport started successfully.");
  return { handler, close };
}

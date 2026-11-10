/**
 * @fileoverview Hono middleware that authenticates a request and runs the
 * rest of the chain with the caller's identity in the async-local
 * `authContext`.
 * @module src/mcp-server/transports/auth/authMiddleware
 */
import type { Context, Next } from "hono";
import { logger, requestContextService } from "@/utils/index.js";
import { authContext } from "./lib/authContext.js";
import type { HttpAuth } from "./lib/authTypes.js";

export function createAuthMiddleware(auth: HttpAuth) {
  return async function authMiddleware(c: Context, next: Next) {
    const context = requestContextService.createRequestContext({
      operation: "authMiddleware",
      method: c.req.method,
      path: c.req.path,
    });

    const authInfo = await auth.authenticate(c.req.raw);
    if (authInfo instanceof Response) {
      logger.debug(
        { ...context, status: authInfo.status },
        "Request refused by authentication.",
      );
      return authInfo;
    }

    logger.info(
      {
        ...context,
        clientId: authInfo.clientId,
        subject: authInfo.extra?.subject,
        scopes: authInfo.scopes,
      },
      "Authentication successful. Auth context populated.",
    );
    return authContext.run({ authInfo }, next);
  };
}

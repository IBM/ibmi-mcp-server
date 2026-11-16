/**
 * @fileoverview Hono middleware that authenticates a request and runs the
 * rest of the chain with the caller's identity in the async-local
 * `authContext`.
 * @module src/mcp-server/transports/auth/authMiddleware
 */
import type { Context, Next } from "hono";
import { logger, requestContextService } from "@/utils/index.js";
import { authContext } from "./lib/authContext.js";
import type { AuthInfo, HttpAuth } from "./lib/authTypes.js";

/**
 * @param onRefused - Called for every request authentication refuses, before
 *   the refusal is answered. May throw to answer differently.
 */
export function createAuthMiddleware(
  auth: HttpAuth,
  onRefused?: (c: Context) => void,
) {
  return async function authMiddleware(c: Context, next: Next) {
    const context = requestContextService.createRequestContext({
      operation: "authMiddleware",
      method: c.req.method,
      path: c.req.path,
    });

    let authInfo: AuthInfo | Response;
    try {
      authInfo = await auth.authenticate(c.req.raw);
    } catch (error) {
      onRefused?.(c);
      throw error;
    }
    if (authInfo instanceof Response) {
      onRefused?.(c);
      // Why, from the challenge: an error code and a fixed description. A
      // request without credentials has neither, which is the normal first
      // step of a client's discovery.
      const challenge = authInfo.headers.get("www-authenticate") ?? "";
      logger.info(
        {
          ...context,
          status: authInfo.status,
          error: /\berror="([^"]*)"/.exec(challenge)?.[1],
          errorDescription: /\berror_description="([^"]*)"/.exec(
            challenge,
          )?.[1],
        },
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

/**
 * @fileoverview Barrel file for the auth module.
 * @module src/mcp-server/transports/auth/index
 */

export { authContext } from "./lib/authContext.js";
export type { HttpAuth } from "./lib/authTypes.js";

export { assertAuthModeSupported, createHttpAuth } from "./authFactory.js";
export { createAuthMiddleware } from "./authMiddleware.js";
export { createBuiltinMapepireClient } from "./builtinOAuth.js";

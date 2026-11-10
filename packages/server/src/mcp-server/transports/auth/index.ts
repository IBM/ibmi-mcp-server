/**
 * @fileoverview Barrel file for the auth module.
 * Exports core utilities and middleware strategies for easier imports.
 * @module src/mcp-server/transports/auth/index
 */

export { authContext } from "./lib/authContext.js";
export { withRequiredScopes } from "./lib/authUtils.js";

export { createAuthStrategy } from "./authFactory.js";
export { createAuthMiddleware } from "./authMiddleware.js";

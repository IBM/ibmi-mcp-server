/**
 * @fileoverview IBM i HTTP Authentication module exports.
 * @module src/ibmi-mcp-server/auth/index
 */

export {
  TokenManager,
  type IBMiCredentials,
  type TokenSession,
} from "./tokenManager.js";
export {
  AuthenticatedPoolManager,
  type AuthPoolOptions,
} from "../services/authenticatedPoolManager.js";
export { handleAuthRequest, enforceTLS } from "./httpAuthEndpoint.js";
export {
  type AuthRequest,
  type AuthResponse,
  type AuthCredentials,
  type EncryptedAuthEnvelope,
} from "./types.js";

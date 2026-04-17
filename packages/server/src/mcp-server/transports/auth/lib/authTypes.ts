/**
 * @fileoverview Shared types for authentication middleware.
 * @module src/mcp-server/transports/auth/core/auth.types
 */

import type { AuthInfo as SdkAuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

/**
 * Defines the structure for authentication information derived from a token.
 * It extends the base SDK type to include common optional claims and IBM i specific context.
 */
export type AuthInfo = SdkAuthInfo & {
  subject?: string;
  // IBM i specific extensions for authenticated pool routing
  ibmiToken?: string;
  ibmiHost?: string;
};

// The declaration for `http.IncomingMessage` is no longer needed here,
// as the new architecture avoids direct mutation where possible and handles
// the attachment within the Hono context.

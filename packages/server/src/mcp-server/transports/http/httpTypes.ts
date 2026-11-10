/**
 * @fileoverview Defines custom types for the Hono HTTP transport layer.
 * @module src/mcp-server/transports/http/httpTypes
 */

import type { IncomingMessage } from "http";

/** The raw Node.js request `@hono/node-server` puts on `c.env`. */
export type HonoNodeBindings = {
  incoming: IncomingMessage;
};

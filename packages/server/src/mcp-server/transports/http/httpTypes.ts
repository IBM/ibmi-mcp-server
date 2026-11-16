/**
 * @fileoverview Defines custom types for the Hono HTTP transport layer.
 * @module src/mcp-server/transports/http/httpTypes
 */

import type { IncomingMessage, ServerResponse } from "http";

/** The raw Node.js request and response `@hono/node-server` puts on `c.env`. */
export type HonoNodeBindings = {
  incoming: IncomingMessage;
  /** Absent for a request made in process (`app.request`). */
  outgoing?: ServerResponse;
};

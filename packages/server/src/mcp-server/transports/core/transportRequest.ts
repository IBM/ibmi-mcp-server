// src/mcp-server/transports/core/transportRequest.ts
import type { RequestContext } from "../../../utils/index.js";

export interface McpTransportRequest {
  webRequest: Request;
  body: unknown;
  context: RequestContext;
  sessionId?: string;
}

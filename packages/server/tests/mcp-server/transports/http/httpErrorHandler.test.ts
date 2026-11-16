/**
 * Tests for the Hono error handler of the HTTP transport.
 *
 * @module tests/mcp-server/transports/http/httpErrorHandler.test
 */

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { httpErrorHandler } from "../../../../src/mcp-server/transports/http/httpErrorHandler.js";
import type { HonoNodeBindings } from "../../../../src/mcp-server/transports/http/httpTypes.js";
import {
  JsonRpcErrorCode,
  McpError,
} from "../../../../src/types-global/errors.js";

interface ErrorBody {
  jsonrpc: string;
  error: { code: number; message: string };
  id: null;
}

function buildApp(thrown: Error) {
  const app = new Hono<{ Bindings: HonoNodeBindings }>();
  app.onError(httpErrorHandler);
  app.get("/boom", () => {
    throw thrown;
  });
  return app;
}

describe("httpErrorHandler", () => {
  it("returns the code and message of an McpError", async () => {
    const res = await buildApp(
      new McpError(JsonRpcErrorCode.Forbidden, "Host not allowed"),
    ).request("/boom");

    expect(res.status).toBe(403);
    const body = (await res.json()) as ErrorBody;
    expect(body.error).toEqual({
      code: JsonRpcErrorCode.Forbidden,
      message: "Host not allowed",
    });
  });

  it("reports an unexpected error as a generic 500 without its text", async () => {
    // "no such file" used to be pattern-matched to 404 and echoed verbatim.
    const res = await buildApp(
      new Error("ENOENT: no such file or directory, open '/etc/keys/priv.pem'"),
    ).request("/boom");

    expect(res.status).toBe(500);
    const body = (await res.json()) as ErrorBody;
    expect(body.jsonrpc).toBe("2.0");
    expect(body.error).toEqual({
      code: JsonRpcErrorCode.InternalError,
      message: "Internal server error",
    });
    expect(JSON.stringify(body)).not.toContain("priv.pem");
  });
});

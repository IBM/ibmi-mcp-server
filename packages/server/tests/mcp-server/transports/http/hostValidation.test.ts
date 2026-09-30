/**
 * Tests for the DNS rebinding protection middleware (Host/Origin allowlist).
 *
 * Built against the full Hono app from createHttpApp with a stubbed
 * TransportManager: asserting the stub's handleRequest was never called is
 * what proves a rejection happened BEFORE MCP dispatch, which is the
 * HackerOne report's actual requirement.
 *
 * @module tests/mcp-server/transports/http/hostValidation.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config } from "../../../../src/config/index.js";
import { createHttpApp } from "../../../../src/mcp-server/transports/http/httpTransport.js";
import type { TransportManager } from "../../../../src/mcp-server/transports/core/transportTypes.js";
import { JsonRpcErrorCode } from "../../../../src/types-global/errors.js";
import { logger, requestContextService } from "../../../../src/utils/index.js";

const savedConfig = {
  mcpAllowedHosts: config.mcpAllowedHosts,
  mcpAllowedOrigins: config.mcpAllowedOrigins,
  mcpHttpHost: config.mcpHttpHost,
  mcpAuthMode: config.mcpAuthMode,
  rateLimitEnabled: config.rateLimit.enabled,
  ibmiHttpAuthEnabled: config.ibmiHttpAuth.enabled,
};

const MCP_BODY = JSON.stringify({
  jsonrpc: "2.0",
  method: "tools/list",
  id: 1,
});

function buildApp() {
  const handleRequest = vi.fn().mockResolvedValue({
    type: "buffered",
    headers: new Headers(),
    statusCode: 200,
    body: { jsonrpc: "2.0", result: {}, id: 1 },
  });
  const manager = {
    handleRequest,
    shutdown: vi.fn().mockResolvedValue(undefined),
  } as unknown as TransportManager;
  const createServerInstanceFn = vi.fn() as unknown as () => Promise<McpServer>;
  const app = createHttpApp(
    manager,
    createServerInstanceFn,
    requestContextService.createRequestContext({
      operation: "hostValidationTest",
    }),
  );
  return { app, handleRequest };
}

type TestApp = ReturnType<typeof buildApp>["app"];

function mcpPost(app: TestApp, headers: Record<string, string>) {
  return app.request("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: MCP_BODY,
  });
}

beforeEach(() => {
  config.mcpAllowedHosts = undefined;
  config.mcpAllowedOrigins = undefined;
  config.mcpHttpHost = "127.0.0.1";
  config.mcpAuthMode = "none";
  config.rateLimit.enabled = false;
  config.ibmiHttpAuth.enabled = false;
});

afterEach(() => {
  config.mcpAllowedHosts = savedConfig.mcpAllowedHosts;
  config.mcpAllowedOrigins = savedConfig.mcpAllowedOrigins;
  config.mcpHttpHost = savedConfig.mcpHttpHost;
  config.mcpAuthMode = savedConfig.mcpAuthMode;
  config.rateLimit.enabled = savedConfig.rateLimitEnabled;
  config.ibmiHttpAuth.enabled = savedConfig.ibmiHttpAuthEnabled;
});

describe("Host header validation", () => {
  it("rejects a rebinding attacker's Host before MCP dispatch", async () => {
    const { app, handleRequest } = buildApp();
    const res = await mcpPost(app, { host: "attacker.example:8088" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(JsonRpcErrorCode.Forbidden);
    expect(handleRequest).not.toHaveBeenCalled();
  });

  it("allows localhost with the default port", async () => {
    const { app, handleRequest } = buildApp();
    const res = await mcpPost(app, { host: "localhost:3010" });
    expect(res.status).toBe(200);
    expect(handleRequest).toHaveBeenCalledTimes(1);
  });

  it("allows 127.0.0.1 on any port (EADDRINUSE retry walks the port)", async () => {
    const { app, handleRequest } = buildApp();
    const res = await mcpPost(app, { host: "127.0.0.1:9999" });
    expect(res.status).toBe(200);
    expect(handleRequest).toHaveBeenCalledTimes(1);
  });

  it("allows bracketed IPv6 loopback", async () => {
    const { app, handleRequest } = buildApp();
    const res = await mcpPost(app, { host: "[::1]:3010" });
    expect(res.status).toBe(200);
    expect(handleRequest).toHaveBeenCalledTimes(1);
  });

  it("rejects a missing Host header", async () => {
    const { app, handleRequest } = buildApp();
    const res = await mcpPost(app, {});
    expect(res.status).toBe(403);
    expect(handleRequest).not.toHaveBeenCalled();
  });

  it("rejects a malformed Host header", async () => {
    const { app, handleRequest } = buildApp();
    const res = await mcpPost(app, { host: "exa mple.com:3010" });
    expect(res.status).toBe(403);
    expect(handleRequest).not.toHaveBeenCalled();
  });

  it("rejects a Host header smuggling userinfo", async () => {
    const { app, handleRequest } = buildApp();
    const res = await mcpPost(app, { host: "evil.example@localhost:3010" });
    expect(res.status).toBe(403);
    expect(handleRequest).not.toHaveBeenCalled();
  });

  it("accepts the trailing-dot FQDN form of a loopback host", async () => {
    // DNS search-domain setups and explicitly fully-qualified URLs emit the
    // root dot; WHATWG preserves it, so it must be normalized away or the
    // dotted and undotted forms never match.
    const { app, handleRequest } = buildApp();
    const res = await mcpPost(app, { host: "localhost.:3010" });
    expect(res.status).toBe(200);
    expect(handleRequest).toHaveBeenCalledTimes(1);
  });

  it("accepts the trailing-dot FQDN form of an allowlisted host", async () => {
    config.mcpAllowedHosts = ["mcp.example.com"];
    const { app, handleRequest } = buildApp();
    const res = await mcpPost(app, { host: "mcp.example.com.:3010" });
    expect(res.status).toBe(200);
    expect(handleRequest).toHaveBeenCalledTimes(1);
  });
});

describe("Origin validation (three-state rule)", () => {
  it("rejects a rebinding page's Origin even with a valid Host", async () => {
    const { app, handleRequest } = buildApp();
    const res = await mcpPost(app, {
      host: "localhost:3010",
      origin: "http://attacker.example:8088",
    });
    expect(res.status).toBe(403);
    expect(handleRequest).not.toHaveBeenCalled();
  });

  it("allows requests without an Origin (non-browser MCP clients)", async () => {
    const { app, handleRequest } = buildApp();
    const res = await mcpPost(app, { host: "localhost:3010" });
    expect(res.status).toBe(200);
    expect(handleRequest).toHaveBeenCalledTimes(1);
  });

  it("allows a loopback-hosted browser origin on any port", async () => {
    const { app, handleRequest } = buildApp();
    const res = await mcpPost(app, {
      host: "localhost:3010",
      origin: "http://localhost:6274",
    });
    expect(res.status).toBe(200);
    expect(handleRequest).toHaveBeenCalledTimes(1);
  });

  it("rejects the degenerate 'Origin: null' (sandboxed iframe)", async () => {
    const { app, handleRequest } = buildApp();
    const res = await mcpPost(app, {
      host: "localhost:3010",
      origin: "null",
    });
    expect(res.status).toBe(403);
    expect(handleRequest).not.toHaveBeenCalled();
  });

  it("rejects an unparseable Origin", async () => {
    const { app, handleRequest } = buildApp();
    const res = await mcpPost(app, {
      host: "localhost:3010",
      origin: "not-a-url",
    });
    expect(res.status).toBe(403);
    expect(handleRequest).not.toHaveBeenCalled();
  });

  it("allows an Origin explicitly listed in MCP_ALLOWED_ORIGINS", async () => {
    config.mcpAllowedOrigins = ["https://app.example.com"];
    const { app, handleRequest } = buildApp();
    const res = await mcpPost(app, {
      host: "localhost:3010",
      origin: "https://app.example.com",
    });
    expect(res.status).toBe(200);
    expect(handleRequest).toHaveBeenCalledTimes(1);
  });

  it("allows a non-loopback Origin whose hostname is in the host allowlist", async () => {
    // Exercises the third disjunct of originAllowed (allowedHostnames), which
    // the exact-match and loopback cases above do not reach. Different port so
    // it cannot pass via MCP_ALLOWED_ORIGINS.
    config.mcpAllowedHosts = ["mcp.internal"];
    const { app, handleRequest } = buildApp();
    const res = await mcpPost(app, {
      host: "mcp.internal:3010",
      origin: "http://mcp.internal:9999",
    });
    expect(res.status).toBe(200);
    expect(handleRequest).toHaveBeenCalledTimes(1);
  });

  it("still enforces Origin when MCP_ALLOWED_HOSTS=*", async () => {
    // MCP_ALLOWED_HOSTS=* disables *Host* checking only. A Host-rewriting proxy
    // says nothing about Origin, so letting the wildcard also disable Origin
    // would surrender the last browser-facing control and re-open rebinding on
    // a loopback-bound server where the posture guard never fires.
    config.mcpAllowedHosts = ["*"];
    config.mcpAllowedOrigins = ["https://app.company.com"];
    const { app, handleRequest } = buildApp();
    const res = await mcpPost(app, {
      host: "mcp.company.com",
      origin: "https://evil.example",
    });
    expect(res.status).toBe(403);
    expect(handleRequest).not.toHaveBeenCalled();
  });

  it("allows the configured Origin when MCP_ALLOWED_HOSTS=*", async () => {
    config.mcpAllowedHosts = ["*"];
    config.mcpAllowedOrigins = ["https://app.company.com"];
    const { app, handleRequest } = buildApp();
    const res = await mcpPost(app, {
      host: "mcp.company.com",
      origin: "https://app.company.com",
    });
    expect(res.status).toBe(200);
    expect(handleRequest).toHaveBeenCalledTimes(1);
  });
});

describe("MCP_ALLOWED_HOSTS", () => {
  it("allows an explicitly allowlisted hostname", async () => {
    config.mcpAllowedHosts = ["mcp.internal"];
    const { app, handleRequest } = buildApp();
    const res = await mcpPost(app, { host: "mcp.internal:3010" });
    expect(res.status).toBe(200);
    expect(handleRequest).toHaveBeenCalledTimes(1);
  });

  it("extends — not replaces — the loopback allowlist", async () => {
    config.mcpAllowedHosts = ["mcp.internal"];
    const { app, handleRequest } = buildApp();
    const res = await mcpPost(app, { host: "localhost:3010" });
    expect(res.status).toBe(200);
    expect(handleRequest).toHaveBeenCalledTimes(1);
  });

  it("normalizes allowlist entries that include a port", async () => {
    config.mcpAllowedHosts = ["mcp.internal:8080"];
    const { app, handleRequest } = buildApp();
    const res = await mcpPost(app, { host: "mcp.internal:9999" });
    expect(res.status).toBe(200);
    expect(handleRequest).toHaveBeenCalledTimes(1);
  });

  it("still rejects hostnames outside the extended allowlist", async () => {
    config.mcpAllowedHosts = ["mcp.internal"];
    const { app, handleRequest } = buildApp();
    const res = await mcpPost(app, { host: "other.internal:3010" });
    expect(res.status).toBe(403);
    expect(handleRequest).not.toHaveBeenCalled();
  });

  it("'*' disables Host checking entirely", async () => {
    config.mcpAllowedHosts = ["*"];
    const { app, handleRequest } = buildApp();
    const res = await mcpPost(app, { host: "anything.example:1234" });
    expect(res.status).toBe(200);
    expect(handleRequest).toHaveBeenCalledTimes(1);
  });
});

describe("bind-host auto-allow", () => {
  it("allows the configured non-wildcard bind host", async () => {
    config.mcpHttpHost = "192.168.1.5";
    const { app, handleRequest } = buildApp();
    const res = await mcpPost(app, { host: "192.168.1.5:3010" });
    expect(res.status).toBe(200);
    expect(handleRequest).toHaveBeenCalledTimes(1);
  });

  it("does not auto-allow arbitrary hosts under a wildcard bind", async () => {
    config.mcpHttpHost = "0.0.0.0";
    const { app, handleRequest } = buildApp();
    const res = await mcpPost(app, { host: "192.168.1.5:3010" });
    expect(res.status).toBe(403);
    expect(handleRequest).not.toHaveBeenCalled();
  });
});

describe("rejection log attribution", () => {
  it("never lets a forged X-Forwarded-For become the logged clientIp", async () => {
    // A rejection record is detection signal. If clientIp came from a request
    // header, an attacker could pin their traffic on any address they chose.
    const warn = vi.spyOn(logger, "warning").mockImplementation(() => {});
    const { app } = buildApp();

    const res = await mcpPost(app, {
      host: "attacker.example:8088",
      "x-forwarded-for": "203.0.113.9",
      "x-real-ip": "198.51.100.7",
    });
    expect(res.status).toBe(403);

    const ctx = warn.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    // The claimed values are still recorded, clearly labelled as claims...
    expect(ctx.forwardedFor).toBe("203.0.113.9");
    expect(ctx.realIp).toBe("198.51.100.7");
    // ...but must not be promoted into the field meaning "source".
    expect(ctx.clientIp).not.toBe("203.0.113.9");
    expect(ctx.clientIp).not.toBe("198.51.100.7");

    warn.mockRestore();
  });

  it("records the offending Host and Origin for the operator", async () => {
    const warn = vi.spyOn(logger, "warning").mockImplementation(() => {});
    const { app } = buildApp();

    await mcpPost(app, {
      host: "attacker.example:8088",
      origin: "http://attacker.example:8088",
    });

    const ctx = warn.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(ctx).toMatchObject({
      hostHeader: "attacker.example:8088",
      originHeader: "http://attacker.example:8088",
      reason: "host-not-allowed",
      path: "/mcp",
      method: "POST",
    });

    warn.mockRestore();
  });
});

describe("coverage of non-MCP routes", () => {
  it("guards GET /healthz against a forged Host", async () => {
    const { app } = buildApp();
    const res = await app.request("/healthz", {
      headers: { host: "attacker.example:8088" },
    });
    expect(res.status).toBe(403);
  });

  it("guards POST /api/v1/auth against a forged Host", async () => {
    // The route is only registered when IBM i HTTP auth is enabled. Without
    // this the request would hit an unregistered path and the 403 would prove
    // nothing beyond what the /healthz case already proves.
    config.ibmiHttpAuth.enabled = true;
    const { app } = buildApp();
    const res = await app.request("/api/v1/auth", {
      method: "POST",
      headers: {
        host: "attacker.example:8088",
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(res.status).toBe(403);
  });

  it("allows POST /api/v1/auth from loopback (proves the route is registered)", async () => {
    config.ibmiHttpAuth.enabled = true;
    const { app } = buildApp();
    const res = await app.request("/api/v1/auth", {
      method: "POST",
      headers: { host: "localhost:3010", "content-type": "application/json" },
      body: "{}",
    });
    // Reaches the real handler, which rejects the empty body for its own
    // reasons — the point is that host validation did not produce the 403.
    expect(res.status).not.toBe(403);
  });

  it("guards OPTIONS preflight against a forged Host", async () => {
    const { app } = buildApp();
    const res = await app.request("/mcp", {
      method: "OPTIONS",
      headers: {
        host: "attacker.example:8088",
        origin: "http://attacker.example:8088",
        "access-control-request-method": "POST",
      },
    });
    // Only the status assertion is meaningful here: Hono's cors() short-circuits
    // every OPTIONS with a 204 before calling next(), so handleRequest would be
    // uncalled even with host validation removed. 403 (not 204) proves the guard
    // ran ahead of cors().
    expect(res.status).toBe(403);
  });
});

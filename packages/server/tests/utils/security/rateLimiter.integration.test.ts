/**
 * Integration tests for rate limiting.
 *
 * Covers the RateLimiter error contract and the rate-limit middleware as it
 * is actually wired into the HTTP app (createHttpApp).
 *
 * @module tests/utils/security/rateLimiter.integration
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { config } from "../../../src/config/index.js";
import { createHttpApp } from "../../../src/mcp-server/transports/http/httpTransport.js";
import {
  JsonRpcErrorCode,
  McpError,
} from "../../../src/types-global/errors.js";
import { requestContextService } from "../../../src/utils/index.js";
import {
  RateLimiter,
  rateLimiter,
} from "../../../src/utils/security/rateLimiter.js";

describe("Rate Limiter Config Integration", () => {
  describe("RateLimiter singleton config wiring", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("should create a RateLimiter with custom config values", () => {
      const limiter = new RateLimiter({
        windowMs: 60_000,
        maxRequests: 5,
        skipInDevelopment: false,
      });

      // Should allow 5 requests
      for (let i = 0; i < 5; i++) {
        expect(() => limiter.check("test-key")).not.toThrow();
      }

      // 6th should fail, and the error carries the configured limit info
      let thrown: unknown;
      try {
        limiter.check("test-key");
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(McpError);
      expect((thrown as McpError).details).toMatchObject({
        limit: 5,
        windowMs: 60_000,
      });

      limiter.dispose();
    });

    it("should reflect configured window duration in error messages", () => {
      const limiter = new RateLimiter({
        windowMs: 120_000, // 2 minutes
        maxRequests: 1,
      });

      limiter.check("key");

      // Window is 120s from now
      expect(() => limiter.check("key")).toThrow(/120 seconds/);

      limiter.dispose();
    });

    it("should enforce per-key isolation with configured limits", () => {
      const limiter = new RateLimiter({
        windowMs: 60_000,
        maxRequests: 2,
      });

      // Two different keys should each get their own bucket
      limiter.check("192.168.1.1");
      limiter.check("192.168.1.1");
      expect(() => limiter.check("192.168.1.1")).toThrow();

      // Different key should still have capacity
      expect(() => limiter.check("192.168.1.2")).not.toThrow();
      expect(() => limiter.check("192.168.1.2")).not.toThrow();
      expect(() => limiter.check("192.168.1.2")).toThrow();

      limiter.dispose();
    });
  });

  describe("HTTP middleware wiring", () => {
    const savedConfig = {
      mcpAllowedHosts: config.mcpAllowedHosts,
      mcpAllowedOrigins: config.mcpAllowedOrigins,
      mcpHttpHost: config.mcpHttpHost,
      mcpAuthMode: config.mcpAuthMode,
      rateLimitEnabled: config.rateLimit.enabled,
      ibmiHttpAuthEnabled: config.ibmiHttpAuth.enabled,
    };
    const savedLimiterConfig = rateLimiter.getConfig();

    function buildApp() {
      const handleRequest = vi.fn(async () =>
        Response.json({ jsonrpc: "2.0", result: {}, id: 1 }),
      );
      const app = createHttpApp(
        { fetch: handleRequest },
        requestContextService.createRequestContext({
          operation: "rateLimiterIntegrationTest",
        }),
        null,
      );
      return { app, handleRequest };
    }

    /** POSTs to /mcp as if the TCP peer were `socketAddress`. */
    function mcpPost(
      app: ReturnType<typeof buildApp>["app"],
      socketAddress: string,
    ) {
      return app.request(
        "/mcp",
        {
          method: "POST",
          headers: {
            host: "localhost:3010",
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
        },
        { incoming: { socket: { remoteAddress: socketAddress } } },
      );
    }

    beforeEach(() => {
      config.mcpAllowedHosts = undefined;
      config.mcpAllowedOrigins = undefined;
      config.mcpHttpHost = "127.0.0.1";
      config.mcpAuthMode = "none";
      config.ibmiHttpAuth.enabled = false;
      config.rateLimit.enabled = true;
      rateLimiter.reset();
      rateLimiter.configure({
        windowMs: 60_000,
        maxRequests: 1,
        skipInDevelopment: false,
      });
    });

    afterEach(() => {
      config.mcpAllowedHosts = savedConfig.mcpAllowedHosts;
      config.mcpAllowedOrigins = savedConfig.mcpAllowedOrigins;
      config.mcpHttpHost = savedConfig.mcpHttpHost;
      config.mcpAuthMode = savedConfig.mcpAuthMode;
      config.rateLimit.enabled = savedConfig.rateLimitEnabled;
      config.ibmiHttpAuth.enabled = savedConfig.ibmiHttpAuthEnabled;
      rateLimiter.reset();
      rateLimiter.configure(savedLimiterConfig);
    });

    it("answers 429 with a RateLimited JSON-RPC error once the limit is exceeded", async () => {
      const { app, handleRequest } = buildApp();

      const first = await mcpPost(app, "10.9.9.9");
      expect(first.status).toBe(200);

      const second = await mcpPost(app, "10.9.9.9");
      expect(second.status).toBe(429);
      const body = (await second.json()) as { error: { code: number } };
      expect(body.error.code).toBe(JsonRpcErrorCode.RateLimited);

      // The limited request never reached MCP dispatch.
      expect(handleRequest).toHaveBeenCalledTimes(1);
    });

    it("keeps a separate budget per client socket address", async () => {
      const { app } = buildApp();

      expect((await mcpPost(app, "10.9.9.9")).status).toBe(200);
      expect((await mcpPost(app, "10.8.8.8")).status).toBe(200);
      expect((await mcpPost(app, "10.9.9.9")).status).toBe(429);
    });

    it("does not limit requests when MCP_RATE_LIMIT_ENABLED=false", async () => {
      config.rateLimit.enabled = false;
      const { app, handleRequest } = buildApp();

      for (let i = 0; i < 3; i++) {
        expect((await mcpPost(app, "10.9.9.9")).status).toBe(200);
      }
      expect(handleRequest).toHaveBeenCalledTimes(3);
    });
  });

  describe("Rate limit error structure", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("should produce McpError with RateLimited code and structured details", () => {
      const limiter = new RateLimiter({
        windowMs: 30_000,
        maxRequests: 1,
      });

      limiter.check("client-1");

      try {
        limiter.check("client-1");
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(McpError);
        const mcpError = error as InstanceType<typeof McpError>;
        expect(mcpError.code).toBe(JsonRpcErrorCode.RateLimited);
        expect(mcpError.details).toMatchObject({
          key: "client-1",
          limit: 1,
          windowMs: 30_000,
          waitTimeSeconds: expect.any(Number),
        });
        expect(mcpError.details!.waitTimeSeconds).toBeGreaterThan(0);
        expect(mcpError.details!.waitTimeSeconds).toBeLessThanOrEqual(30);
      }

      limiter.dispose();
    });

    it("should correctly calculate wait time as window approaches reset", () => {
      const limiter = new RateLimiter({
        windowMs: 10_000, // 10 seconds
        maxRequests: 1,
      });

      limiter.check("client");

      // Advance 7 seconds into the 10-second window
      vi.advanceTimersByTime(7_000);

      try {
        limiter.check("client");
        expect.fail("Should have thrown");
      } catch (error: unknown) {
        const mcpError = error as { details?: Record<string, unknown> };
        // Should have ~3 seconds remaining
        expect(mcpError.details!.waitTimeSeconds).toBeLessThanOrEqual(3);
        expect(mcpError.details!.waitTimeSeconds).toBeGreaterThan(0);
      }

      limiter.dispose();
    });
  });
});

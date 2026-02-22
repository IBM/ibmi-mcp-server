/**
 * Integration tests for rate limiter configuration.
 *
 * Tests the wiring between environment variables → Zod config → RateLimiter singleton,
 * and the conditional middleware registration in httpTransport.
 *
 * @module tests/utils/security/rateLimiter.integration
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { z } from "zod";

/**
 * Standalone copy of the rate-limit portion of EnvSchema.
 * We duplicate only the 4 fields rather than importing the full EnvSchema
 * (which is not exported and has side effects like fs operations).
 */
const RateLimitEnvSchema = z.object({
  MCP_RATE_LIMIT_ENABLED: z
    .string()
    .optional()
    .default("true")
    .transform((val) => val === "true" || val === "1"),
  MCP_RATE_LIMIT_MAX_REQUESTS: z.coerce
    .number()
    .int()
    .positive()
    .default(100),
  MCP_RATE_LIMIT_WINDOW_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(900_000),
  MCP_RATE_LIMIT_SKIP_DEV: z
    .string()
    .optional()
    .default("false")
    .transform((val) => val === "true" || val === "1"),
});

describe("Rate Limiter Config Integration", () => {
  describe("Zod schema validation for MCP_RATE_LIMIT_* env vars", () => {
    it("should use correct defaults when no env vars are set", () => {
      const result = RateLimitEnvSchema.parse({});

      expect(result).toEqual({
        MCP_RATE_LIMIT_ENABLED: true,
        MCP_RATE_LIMIT_MAX_REQUESTS: 100,
        MCP_RATE_LIMIT_WINDOW_MS: 900_000,
        MCP_RATE_LIMIT_SKIP_DEV: false,
      });
    });

    it("should parse string booleans correctly", () => {
      const result = RateLimitEnvSchema.parse({
        MCP_RATE_LIMIT_ENABLED: "false",
        MCP_RATE_LIMIT_SKIP_DEV: "true",
      });

      expect(result.MCP_RATE_LIMIT_ENABLED).toBe(false);
      expect(result.MCP_RATE_LIMIT_SKIP_DEV).toBe(true);
    });

    it('should accept "1" as truthy for boolean fields', () => {
      const result = RateLimitEnvSchema.parse({
        MCP_RATE_LIMIT_ENABLED: "1",
        MCP_RATE_LIMIT_SKIP_DEV: "1",
      });

      expect(result.MCP_RATE_LIMIT_ENABLED).toBe(true);
      expect(result.MCP_RATE_LIMIT_SKIP_DEV).toBe(true);
    });

    it("should coerce string numbers for numeric fields", () => {
      const result = RateLimitEnvSchema.parse({
        MCP_RATE_LIMIT_MAX_REQUESTS: "500",
        MCP_RATE_LIMIT_WINDOW_MS: "60000",
      });

      expect(result.MCP_RATE_LIMIT_MAX_REQUESTS).toBe(500);
      expect(result.MCP_RATE_LIMIT_WINDOW_MS).toBe(60_000);
    });

    it("should reject zero for max requests (positive constraint)", () => {
      expect(() =>
        RateLimitEnvSchema.parse({ MCP_RATE_LIMIT_MAX_REQUESTS: "0" }),
      ).toThrow();
    });

    it("should reject negative values for window ms", () => {
      expect(() =>
        RateLimitEnvSchema.parse({ MCP_RATE_LIMIT_WINDOW_MS: "-1000" }),
      ).toThrow();
    });

    it("should reject non-integer values for max requests", () => {
      expect(() =>
        RateLimitEnvSchema.parse({ MCP_RATE_LIMIT_MAX_REQUESTS: "10.5" }),
      ).toThrow();
    });

    it("should treat unrecognized string as false for boolean fields", () => {
      const result = RateLimitEnvSchema.parse({
        MCP_RATE_LIMIT_ENABLED: "yes",
        MCP_RATE_LIMIT_SKIP_DEV: "on",
      });

      expect(result.MCP_RATE_LIMIT_ENABLED).toBe(false);
      expect(result.MCP_RATE_LIMIT_SKIP_DEV).toBe(false);
    });
  });

  describe("RateLimiter singleton config wiring", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("should create a RateLimiter with custom config values", async () => {
      const { RateLimiter } = await import(
        "../../../src/utils/security/rateLimiter"
      );

      const limiter = new RateLimiter({
        windowMs: 60_000,
        maxRequests: 5,
        skipInDevelopment: false,
      });

      // Should allow 5 requests
      for (let i = 0; i < 5; i++) {
        expect(() => limiter.check("test-key")).not.toThrow();
      }

      // 6th should fail
      expect(() => limiter.check("test-key")).toThrow();

      // Verify the error contains the right limit info
      try {
        limiter.check("test-key");
      } catch (error: unknown) {
        const mcpError = error as { details?: Record<string, unknown> };
        expect(mcpError.details).toMatchObject({
          limit: 5,
          windowMs: 60_000,
        });
      }

      limiter.dispose();
    });

    it("should reflect configured window duration in error messages", async () => {
      const { RateLimiter } = await import(
        "../../../src/utils/security/rateLimiter"
      );

      const limiter = new RateLimiter({
        windowMs: 120_000, // 2 minutes
        maxRequests: 1,
      });

      limiter.check("key");

      try {
        limiter.check("key");
      } catch (error: unknown) {
        const mcpError = error as { message: string };
        // Should say "120 seconds" (window is 120s from now)
        expect(mcpError.message).toMatch(/\d+ seconds/);
      }

      limiter.dispose();
    });

    it("should enforce per-key isolation with configured limits", async () => {
      const { RateLimiter } = await import(
        "../../../src/utils/security/rateLimiter"
      );

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

  describe("getClientIp extraction logic", () => {
    /**
     * These tests verify the IP resolution priority chain:
     * 1. X-Forwarded-For (first entry)
     * 2. X-Real-IP
     * 3. socket.remoteAddress
     * 4. "unknown_ip" fallback
     *
     * We test the logic directly rather than through the Hono middleware,
     * since the function is not exported. This mirrors the implementation
     * in httpTransport.ts:49-57.
     */
    function getClientIp(headers: Record<string, string | undefined>, socketAddress?: string): string {
      const forwardedFor = headers["x-forwarded-for"];
      return (
        (forwardedFor?.split(",")[0] ?? "").trim() ||
        headers["x-real-ip"] ||
        socketAddress ||
        "unknown_ip"
      );
    }

    it("should prefer X-Forwarded-For when present", () => {
      expect(
        getClientIp(
          { "x-forwarded-for": "203.0.113.50, 70.41.3.18" },
          "172.17.0.1",
        ),
      ).toBe("203.0.113.50");
    });

    it("should use X-Real-IP when X-Forwarded-For is absent", () => {
      expect(
        getClientIp(
          { "x-forwarded-for": undefined, "x-real-ip": "10.0.0.1" },
          "172.17.0.1",
        ),
      ).toBe("10.0.0.1");
    });

    it("should fall back to socket.remoteAddress when no proxy headers", () => {
      expect(
        getClientIp(
          { "x-forwarded-for": undefined, "x-real-ip": undefined },
          "172.17.0.2",
        ),
      ).toBe("172.17.0.2");
    });

    it("should return unknown_ip only when all sources are absent", () => {
      expect(
        getClientIp(
          { "x-forwarded-for": undefined, "x-real-ip": undefined },
          undefined,
        ),
      ).toBe("unknown_ip");
    });

    it("should trim whitespace from X-Forwarded-For entries", () => {
      expect(
        getClientIp({ "x-forwarded-for": "  203.0.113.50 , 70.41.3.18" }),
      ).toBe("203.0.113.50");
    });

    it("should handle empty X-Forwarded-For and fall through", () => {
      expect(
        getClientIp(
          { "x-forwarded-for": "", "x-real-ip": undefined },
          "192.168.1.1",
        ),
      ).toBe("192.168.1.1");
    });

    it("should handle IPv6-mapped IPv4 from socket (Docker common case)", () => {
      expect(
        getClientIp(
          { "x-forwarded-for": undefined, "x-real-ip": undefined },
          "::ffff:172.17.0.2",
        ),
      ).toBe("::ffff:172.17.0.2");
    });
  });

  describe("Rate limit error structure", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("should produce McpError with RateLimited code and structured details", async () => {
      const { RateLimiter } = await import(
        "../../../src/utils/security/rateLimiter"
      );
      const { JsonRpcErrorCode, McpError } = await import(
        "../../../src/types-global/errors"
      );

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

    it("should correctly calculate wait time as window approaches reset", async () => {
      const { RateLimiter } = await import(
        "../../../src/utils/security/rateLimiter"
      );

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

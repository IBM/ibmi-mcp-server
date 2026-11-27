import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { RateLimiter } from "../../../src/utils/security/rateLimiter.js";
import { McpError } from "../../../src/types-global/errors.js";

describe("RateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should allow requests under the configured limit", () => {
    const rateLimiter = new RateLimiter({ windowMs: 1000, maxRequests: 2 });
    const key = "test-user";

    expect(() => rateLimiter.check(key)).not.toThrow();
    expect(() => rateLimiter.check(key)).not.toThrow();
  });

  it("should reset the limit after the time window passes", () => {
    const rateLimiter = new RateLimiter({ windowMs: 1000, maxRequests: 1 });
    const key = "test-user";

    rateLimiter.check(key); // This one passes

    // This one should fail
    expect(() => rateLimiter.check(key)).toThrow(McpError);

    // Advance time past the window
    vi.advanceTimersByTime(1001);

    // Now it should pass again
    expect(() => {
      rateLimiter.check(key);
    }).not.toThrow();
  });

  it("should format the error message with the correct wait time", () => {
    const rateLimiter = new RateLimiter({ windowMs: 5000, maxRequests: 1 });
    const key = "test-user";

    rateLimiter.check(key);

    expect(() => rateLimiter.check(key)).toThrow(
      "Please try again in 5 seconds",
    );
  });

  it("should correctly reset all limits when reset() is called", () => {
    const rateLimiter = new RateLimiter({ windowMs: 1000, maxRequests: 1 });
    const key = "test-user";

    rateLimiter.check(key);
    expect(() => rateLimiter.check(key)).toThrow(McpError);

    rateLimiter.reset();

    expect(() => rateLimiter.check(key)).not.toThrow();
  });

  it("should skip rate limiting in development if configured", async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";

    // We need to re-import the module to get the updated environment
    vi.resetModules();
    const { RateLimiter: TestRateLimiter } =
      await import("../../../src/utils/security/rateLimiter.js");

    const rateLimiter = new TestRateLimiter({
      windowMs: 1000,
      maxRequests: 1,
      skipInDevelopment: true,
    });
    const key = "dev-user";

    rateLimiter.check(key);
    expect(() => rateLimiter.check(key)).not.toThrow();

    process.env.NODE_ENV = originalNodeEnv;
    vi.resetModules();
  });

  it("should use a custom key generator if provided", () => {
    const keyGenerator = vi.fn((identifier: string) => `custom-${identifier}`);
    const rateLimiter = new RateLimiter({
      windowMs: 1000,
      maxRequests: 1,
      keyGenerator,
    });
    const key = "test-key";

    rateLimiter.check(key);
    expect(keyGenerator).toHaveBeenCalledWith(key, undefined);
    expect(() => rateLimiter.check("another-key")).not.toThrow();
    expect(() => rateLimiter.check(key)).toThrow(McpError);
  });

  it("should clean up expired entries automatically", () => {
    const rateLimiter = new RateLimiter({
      windowMs: 1000,
      maxRequests: 1,
      cleanupInterval: 500,
    });
    const key = "cleanup-user";

    rateLimiter.check(key);
    expect(rateLimiter.getStatus(key)).not.toBeNull();

    vi.advanceTimersByTime(1001); // Advance past window
    vi.advanceTimersByTime(500); // Advance past cleanup interval

    expect(rateLimiter.getStatus(key)).toBeNull();
    rateLimiter.dispose();
  });

  it("should allow re-configuration", () => {
    const rateLimiter = new RateLimiter({ windowMs: 1000, maxRequests: 1 });
    rateLimiter.configure({ maxRequests: 2 });

    const config = rateLimiter.getConfig();
    expect(config.maxRequests).toBe(2);

    const key = "reconfig-user";
    rateLimiter.check(key);
    expect(() => rateLimiter.check(key)).not.toThrow();
    expect(() => rateLimiter.check(key)).toThrow(McpError);
  });

  it("should return the correct status", () => {
    const rateLimiter = new RateLimiter({ windowMs: 1000, maxRequests: 5 });
    const key = "status-user";

    rateLimiter.check(key);
    rateLimiter.check(key);

    const status = rateLimiter.getStatus(key);
    expect(status).toEqual({
      current: 2,
      limit: 5,
      remaining: 3,
      resetTime: expect.any(Number),
    });

    expect(rateLimiter.getStatus("non-existent-key")).toBeNull();
  });

  it("should dispose of the timer and clear limits", () => {
    const rateLimiter = new RateLimiter({
      windowMs: 1000,
      maxRequests: 1,
      cleanupInterval: 500,
    });
    const key = "dispose-user";
    rateLimiter.check(key);

    rateLimiter.dispose();

    expect(rateLimiter.getStatus(key)).toBeNull();
    // Check if timer is cleared (indirectly)
    const newLimiter = new RateLimiter({ windowMs: 1000, maxRequests: 1 });
    newLimiter.check("new-key");
    vi.advanceTimersByTime(1500);
    // if dispose worked, the old timer shouldn't have cleaned the new key
    expect(newLimiter.getStatus("new-key")).not.toBeNull();
    newLimiter.dispose();
  });

  it("drops the oldest entry once it tracks the maximum number of keys", () => {
    const rateLimiter = new RateLimiter({ windowMs: 60_000, maxRequests: 1 });

    rateLimiter.check("oldest");
    // "second" starts its window later than every other key: its first window
    // ends, and a new one starts, after the keys below were added.
    rateLimiter.check("second");
    vi.advanceTimersByTime(30_000);
    for (let i = 2; i < RateLimiter.MAX_ENTRIES; i++) {
      rateLimiter.check(`key-${i}`);
    }
    vi.advanceTimersByTime(30_000);
    rateLimiter.check("second");

    rateLimiter.check("one-too-many");
    expect(rateLimiter.getStatus("oldest")).toBeNull();
    expect(rateLimiter.getStatus("second")).not.toBeNull();

    rateLimiter.check("another");
    expect(rateLimiter.getStatus("key-2")).toBeNull();
    expect(rateLimiter.getStatus("second")).not.toBeNull();
    rateLimiter.dispose();
  });

  it("cuts keys to the maximum key length", () => {
    const rateLimiter = new RateLimiter({ windowMs: 1000, maxRequests: 1 });
    const prefix = "x".repeat(RateLimiter.MAX_KEY_LENGTH);

    rateLimiter.check(`${prefix}-one`);
    // Stored under the same, cut, key.
    expect(() => rateLimiter.check(`${prefix}-two`)).toThrow(McpError);
    expect(rateLimiter.getStatus(prefix)?.current).toBe(2);
    rateLimiter.dispose();
  });
});

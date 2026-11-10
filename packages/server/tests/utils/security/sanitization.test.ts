import { describe, it, expect } from "vitest";
import { sanitization } from "../../../src/utils/security/sanitization";

describe("Sanitization Utility", () => {
  describe("sanitizeForLogging", () => {
    it('should redact sensitive keys like "password", "token", and "apiKey" in a flat object', () => {
      const sensitiveObject = {
        username: "test",
        password: "my-secret-password",
        session_token: "abc-123",
        secretKey: "xyz-789",
      };
      const sanitized = sanitization.sanitizeForLogging(
        sensitiveObject,
      ) as Record<string, unknown>;
      expect((sanitized as Record<string, string>).password).toBe("[REDACTED]");
      expect(sanitized.session_token).toBe("[REDACTED]");
      expect(sanitized.secretKey).toBe("[REDACTED]");
      expect(sanitized.username).toBe("test");
    });

    it("should redact sensitive keys in a deeply nested object", () => {
      const sensitiveObject = {
        user: "casey",
        credentials: {
          password: "my-secret-password",
          session_token: "abc-123-def-456",
        },
        nonSensitive: "data",
      };
      const sanitized = sanitization.sanitizeForLogging(
        sensitiveObject,
      ) as Record<string, Record<string, unknown>>;
      expect(sanitized.credentials.password).toBe("[REDACTED]");
      expect(sanitized.credentials.session_token).toBe("[REDACTED]");
      expect(sanitized.nonSensitive).toBe("data");
    });

    it("should not modify non-sensitive keys", () => {
      const nonSensitive = { user: "casey", id: 123 };
      const sanitized = sanitization.sanitizeForLogging(nonSensitive);
      expect(sanitized).toEqual(nonSensitive);
    });

    it("should handle arrays of objects correctly", () => {
      const sensitiveArray = [
        { user: "a", password: "123" },
        { user: "b", apiKey: "456" },
      ];
      const sanitized = sanitization.sanitizeForLogging(
        sensitiveArray,
      ) as Record<string, unknown>[];
      expect(sanitized[0].password).toBe("[REDACTED]");
      expect(sanitized[1].apiKey).toBe("[REDACTED]");
      expect(sanitized[0].user).toBe("a");
    });
  });
});

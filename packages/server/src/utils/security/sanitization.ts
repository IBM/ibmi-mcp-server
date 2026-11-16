/**
 * @fileoverview Provides a `Sanitization` class for redacting sensitive
 * information from data intended for logging.
 * @module src/utils/security/sanitization
 */
import { logger } from "@/utils/internal/logger.js";
import { requestContextService } from "@/utils/internal/requestContext.js";

/**
 * A singleton class that redacts sensitive fields from data before it is logged.
 */
export class Sanitization {
  /** @private */
  private static instance: Sanitization;

  /**
   * Default list of field names considered sensitive for log redaction.
   * Case-insensitive matching is applied.
   * @private
   */
  private sensitiveFields: string[] = [
    "password",
    "token",
    "secret",
    "key",
    "apiKey",
    "auth",
    "credential",
    "jwt",
    "ssn",
    "credit",
    "card",
    "cvv",
    "authorization",
  ];

  /** @private */
  private constructor() {}

  /**
   * Retrieves the singleton instance of the `Sanitization` class.
   * @returns The singleton `Sanitization` instance.
   */
  public static getInstance(): Sanitization {
    if (!Sanitization.instance) {
      Sanitization.instance = new Sanitization();
    }
    return Sanitization.instance;
  }

  /**
   * Sanitizes input for logging by redacting sensitive fields.
   * Creates a deep clone and replaces values of fields matching `this.sensitiveFields`
   * (case-insensitive substring match) with "[REDACTED]".
   *
   * It uses `structuredClone` if available for a high-fidelity deep clone.
   * If `structuredClone` is not available (e.g., in older Node.js environments),
   * it falls back to `JSON.parse(JSON.stringify(input))`. This fallback has limitations:
   * - `Date` objects are converted to ISO date strings.
   * - `undefined` values within objects are removed.
   * - `Map`, `Set`, `RegExp` objects are converted to empty objects (`{}`).
   * - Functions are removed.
   * - `BigInt` values will throw an error during `JSON.stringify` unless a `toJSON` method is provided.
   * - Circular references will cause `JSON.stringify` to throw an error.
   *
   * @param input - The input data to sanitize for logging.
   * @returns A sanitized (deep cloned) version of the input, safe for logging.
   *   Returns original input if not object/array, or "[Log Sanitization Failed]" on error.
   */
  public sanitizeForLogging(input: unknown): unknown {
    try {
      if (!input || typeof input !== "object") return input;

      const clonedInput =
        typeof globalThis.structuredClone === "function"
          ? globalThis.structuredClone(input)
          : JSON.parse(JSON.stringify(input));
      this.redactSensitiveFields(clonedInput);
      return clonedInput;
    } catch (error) {
      logger.error(
        requestContextService.createRequestContext({
          operation: "Sanitization.sanitizeForLogging.error",
          errorMessage: error instanceof Error ? error.message : String(error),
        }),
        "Error during log sanitization, returning placeholder.",
      );
      return "[Log Sanitization Failed]";
    }
  }

  /**
   * Recursively redacts sensitive fields in an object or array in place.
   * @param obj - The object or array to redact.
   * @private
   */
  private redactSensitiveFields(obj: unknown): void {
    if (!obj || typeof obj !== "object") return;

    if (Array.isArray(obj)) {
      obj.forEach((item) => this.redactSensitiveFields(item));
      return;
    }

    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        const value = (obj as Record<string, unknown>)[key];

        // Split camelCase and snake_case/kebab-case keys into words
        const keyWords = key
          .replace(/([A-Z])/g, " $1") // Add space before uppercase letters
          .toLowerCase()
          .split(/[\s_-]+/); // Split by space, underscore, or hyphen

        const isSensitive = keyWords.some((word) =>
          this.sensitiveFields.includes(word),
        );

        if (isSensitive) {
          (obj as Record<string, unknown>)[key] = "[REDACTED]";
        } else if (value && typeof value === "object") {
          this.redactSensitiveFields(value);
        }
      }
    }
  }
}

/**
 * Singleton instance of the `Sanitization` class.
 */
export const sanitization = Sanitization.getInstance();

/**
 * Convenience function calling `sanitization.sanitizeForLogging`.
 * @param input - The input data to sanitize.
 * @returns A sanitized version of the input, safe for logging.
 */
export const sanitizeInputForLogging = (input: unknown): unknown =>
  sanitization.sanitizeForLogging(input);

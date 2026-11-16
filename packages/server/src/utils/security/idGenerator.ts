/**
 * @fileoverview Generates short random identifiers (used for request IDs).
 * @module src/utils/security/idGenerator
 */
import { randomBytes } from "crypto";

const CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const ID_LENGTH = 8;

/**
 * Generates a short, 8-character alphanumeric identifier from a
 * cryptographically secure source.
 * This is suitable for non-colliding IDs within a reasonable scope, like request IDs.
 * @returns A new 8-character alphanumeric ID string.
 */
export const generateShortAlphanumericId = (): string => {
  let result = "";
  // Largest multiple of CHARSET.length that fits in a byte; bytes at or above
  // it are discarded (rejection sampling) to avoid modulo bias.
  const maxValidByteValue = Math.floor(256 / CHARSET.length) * CHARSET.length;

  while (result.length < ID_LENGTH) {
    const byte = randomBytes(1)[0];
    if (byte !== undefined && byte < maxValidByteValue) {
      result += CHARSET[byte % CHARSET.length];
    }
  }
  return result;
};

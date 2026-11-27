/**
 * @fileoverview The envelope that keeps a signed-on user's password as
 * ciphertext the server cannot open alone (`SealingApi` of contracts.ts).
 *
 * - The password is encrypted under a random per-grant key.
 * - That key is kept only wrapped under a key derived from a secret the
 *   client holds: the authorization code, then the current refresh token.
 * - Secrets are stored only as their SHA-256.
 *
 * Every sealed value is `nonce (12) | ciphertext | tag (16)` of AES-256-GCM.
 * Every `Buffer` returned has its own memory outside the V8 heap (never the
 * shared pool, see `secretBuffer`) and is the caller's to zero-fill. A value
 * that does not open gives `undefined`; nothing here throws, logs or returns
 * text derived from its input.
 * @module src/ibmi-mcp-server/oauth/sealing
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomFillSync,
} from "node:crypto";
import { TOKEN_BYTES, type GrantId, type TokenPair } from "./contracts.js";

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const BASE64URL = Buffer.from(
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_",
  "ascii",
);

/** V8 keeps the bytes of a typed array up to this length inside its heap. */
const ON_HEAP_MAX_BYTES = 64;

/**
 * A Buffer for a secret: memory of its own, outside the V8 heap, so that
 * `fill(0)` reaches the only copy. `Buffer.allocUnsafeSlow` alone is not
 * enough for a short one: V8 keeps its bytes inside the heap, where the
 * garbage collector moves them and a native call (a hash, a key derivation)
 * copies them out, and neither wipes what it leaves behind. A short secret
 * is therefore a view of a longer allocation, whose unused end is zero.
 */
export function secretBuffer(bytes: number): Buffer {
  if (bytes > ON_HEAP_MAX_BYTES) {
    return Buffer.allocUnsafeSlow(bytes);
  }
  const whole = Buffer.allocUnsafeSlow(ON_HEAP_MAX_BYTES + 1);
  whole.fill(0, bytes);
  return whole.subarray(0, bytes);
}

/** Random bytes in memory of their own. */
function randomBuffer(bytes: number): Buffer {
  return randomFillSync(secretBuffer(bytes));
}

/** A copy in memory of its own (`Buffer.from` would use the shared pool). */
function copyOf(bytes: Buffer): Buffer {
  const copy = secretBuffer(bytes.length);
  bytes.copy(copy);
  return copy;
}

/** AES-256-GCM under `key` with a random nonce. */
function encrypt(key: Buffer, plaintext: Buffer, aad?: string): Buffer {
  const nonce = randomBuffer(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  if (aad !== undefined) {
    cipher.setAAD(Buffer.from(aad));
  }
  const body = cipher.update(plaintext);
  cipher.final();
  const sealed = secretBuffer(NONCE_BYTES + body.length + TAG_BYTES);
  nonce.copy(sealed);
  body.copy(sealed, NONCE_BYTES);
  cipher.getAuthTag().copy(sealed, NONCE_BYTES + body.length);
  return sealed;
}

/** The plaintext, or `undefined` when `sealed` does not open under `key`. */
function decrypt(
  key: Buffer,
  sealed: Buffer,
  aad?: string,
): Buffer | undefined {
  let plaintext: Buffer | undefined;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      sealed.subarray(0, NONCE_BYTES),
      { authTagLength: TAG_BYTES },
    );
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
    if (aad !== undefined) {
      decipher.setAAD(Buffer.from(aad));
    }
    plaintext = decipher.update(
      sealed.subarray(NONCE_BYTES, sealed.length - TAG_BYTES),
    );
    decipher.final();
    return plaintext;
  } catch {
    // Wrong key, grant or length, or modified bytes. What was decrypted
    // before the tag failed is not authentic and is not handed out.
    plaintext?.fill(0);
    return undefined;
  }
}

/** HKDF-SHA256 of a secret, salted with the grant it belongs to. */
function deriveKey(
  secret: Buffer,
  grantId: GrantId,
  info: "wrap" | "replay",
): Buffer {
  return Buffer.from(
    hkdfSync("sha256", secret, Buffer.from(grantId), info, KEY_BYTES),
  );
}

/**
 * A new authorization code, access token or refresh token: `TOKEN_BYTES`
 * random bytes as base64url text without padding, in ASCII bytes. Encoded
 * here because `toString("base64url")` would leave the secret in a
 * JavaScript string, which cannot be wiped.
 */
export function newSecret(): Buffer {
  const raw = randomBuffer(TOKEN_BYTES);
  const text = secretBuffer(Math.ceil((raw.length * 4) / 3));
  let written = 0;
  for (let i = 0; i < raw.length; i += 3) {
    const bits = (raw[i]! << 16) | ((raw[i + 1] ?? 0) << 8) | (raw[i + 2] ?? 0);
    for (let shift = 18; shift >= 0 && written < text.length; shift -= 6) {
      text[written++] = BASE64URL[(bits >> shift) & 63]!;
    }
  }
  raw.fill(0);
  return text;
}

/**
 * Hex SHA-256 of a secret: the only form in which one is stored. A secret
 * that arrives as a string (the bearer of a request header) is hashed as its
 * Latin-1 bytes without a Buffer being made of it.
 */
export function hashSecret(secret: Buffer | string): string {
  const hash = createHash("sha256");
  return (
    typeof secret === "string"
      ? hash.update(secret, "latin1")
      : hash.update(secret)
  ).digest("hex");
}

/**
 * Encrypts the password under a new random 32-byte key, with additional
 * data `pw|<grantId>`. The caller wraps the key and zero-fills it.
 */
export function seal(
  password: Buffer,
  grantId: GrantId,
): { ciphertext: Buffer; key: Buffer } {
  const key = randomBuffer(KEY_BYTES);
  return { ciphertext: encrypt(key, password, `pw|${grantId}`), key };
}

/** The password, or `undefined` when the key or grant does not match. */
export function unseal(
  ciphertext: Buffer,
  key: Buffer,
  grantId: GrantId,
): Buffer | undefined {
  return decrypt(key, ciphertext, `pw|${grantId}`);
}

/**
 * Encrypts the grant key under HKDF-SHA256(secret, salt `grantId`, info
 * `wrap`).
 */
export function wrapKey(key: Buffer, secret: Buffer, grantId: GrantId): Buffer {
  const wrappingKey = deriveKey(secret, grantId, "wrap");
  try {
    return encrypt(wrappingKey, key);
  } finally {
    wrappingKey.fill(0);
  }
}

/** The grant key, or `undefined` when the secret or grant does not match. */
export function unwrapKey(
  wrap: Buffer,
  secret: Buffer,
  grantId: GrantId,
): Buffer | undefined {
  const wrappingKey = deriveKey(secret, grantId, "wrap");
  try {
    return decrypt(wrappingKey, wrap);
  } finally {
    wrappingKey.fill(0);
  }
}

/**
 * The replay record of a rotation: the successor pair encrypted under
 * HKDF-SHA256(previous refresh token, salt `grantId`, info `replay`). The
 * plaintext is the access token's length in one byte, the access token, then
 * the refresh token.
 */
export function sealReplay(
  successor: TokenPair,
  previousRefreshToken: Buffer,
  grantId: GrantId,
): Buffer {
  const { accessToken, refreshToken } = successor;
  const pair = secretBuffer(1 + accessToken.length + refreshToken.length);
  pair[0] = accessToken.length;
  accessToken.copy(pair, 1);
  refreshToken.copy(pair, 1 + accessToken.length);
  const replayKey = deriveKey(previousRefreshToken, grantId, "replay");
  try {
    return encrypt(replayKey, pair);
  } finally {
    zeroFill(replayKey, pair);
  }
}

/** The successor pair, or `undefined` when the token or grant does not match. */
export function openReplay(
  record: Buffer,
  previousRefreshToken: Buffer,
  grantId: GrantId,
): TokenPair | undefined {
  const replayKey = deriveKey(previousRefreshToken, grantId, "replay");
  const pair = decrypt(replayKey, record);
  replayKey.fill(0);
  if (!pair) {
    return undefined;
  }
  try {
    const refreshTokenStart = 1 + (pair[0] ?? pair.length);
    if (refreshTokenStart > pair.length) {
      return undefined;
    }
    return {
      accessToken: copyOf(pair.subarray(1, refreshTokenStart)),
      refreshToken: copyOf(pair.subarray(refreshTokenStart)),
    };
  } finally {
    pair.fill(0);
  }
}

/** Overwrites each buffer with zeros. */
export function zeroFill(...buffers: Array<Buffer | undefined>): void {
  for (const buffer of buffers) {
    buffer?.fill(0);
  }
}

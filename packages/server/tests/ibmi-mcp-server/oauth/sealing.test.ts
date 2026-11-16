/**
 * @fileoverview Tests for the sealing envelope of the built-in OAuth
 * authorization server. The known-answer vectors were computed outside
 * node:crypto (Python `cryptography`: AESGCM and HKDF) from the fixed dummy
 * inputs below.
 */

import { createCipheriv, createDecipheriv, hkdfSync } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SealingApi } from "../../../src/ibmi-mcp-server/oauth/contracts.js";
import * as sealing from "../../../src/ibmi-mcp-server/oauth/sealing.js";
import { hasOwnMemory } from "./ownMemory.js";

/** What deciphers returned from `update`, in order. */
const decrypted = vi.hoisted(() => [] as Buffer[]);

// The real node:crypto, observed: the keys HKDF derived and the plaintext
// deciphers produced are recorded, so a test can see that they are wiped.
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    hkdfSync: vi.fn(actual.hkdfSync),
    createDecipheriv: (...args: Parameters<typeof actual.createDecipheriv>) => {
      const decipher = actual.createDecipheriv(...args);
      const update = decipher.update.bind(decipher) as (data: Buffer) => Buffer;
      decipher.update = ((data: Buffer) => {
        const plaintext = update(data);
        decrypted.push(plaintext);
        return plaintext;
      }) as typeof decipher.update;
      return decipher;
    },
  };
});

// The module exports exactly what the contract names.
const {
  hashSecret,
  newSecret,
  openReplay,
  seal,
  sealReplay,
  secretBuffer,
  unseal,
  unwrapKey,
  wrapKey,
  zeroFill,
}: SealingApi = sealing;

const hex = (text: string) => Buffer.from(text, "hex");
const ascii = (text: string) => Buffer.from(text, "ascii");

/** base64url of 16 zero bytes. */
const GRANT = "AAAAAAAAAAAAAAAAAAAAAA";
const OTHER_GRANT = "AAAAAAAAAAAAAAAAAAAAAQ";
const PASSWORD = "dummy-Pw-123";
/** Bytes 00..1f. */
const KEY = hex(
  "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
);
/** Nonce a0..ab, additional data `pw|<GRANT>`. */
const SEALED_PASSWORD = hex(
  "a0a1a2a3a4a5a6a7a8a9aaab826d11403ce652c84f54b5e05f79c664215bbb43b6de5c94707491ab",
);
/** base64url of bytes 20..3f, 40..5f, 60..7f and 80..9f. */
const CODE = ascii("ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8");
const ACCESS_TOKEN = ascii("QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl8");
const REFRESH_TOKEN = ascii("YGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6e3x9fn8");
const PREVIOUS_REFRESH_TOKEN = ascii(
  "gIGCg4SFhoeIiYqLjI2Oj5CRkpOUlZaXmJmam5ydnp8",
);
/** KEY under HKDF-SHA256(CODE, salt GRANT, info "wrap"), nonce b0..bb. */
const WRAPPED_KEY = hex(
  "b0b1b2b3b4b5b6b7b8b9babb024b44082bd1628b6c769142ebdf73608f98ad11cb5b22a65d904eadecf1321955591bf6404e6b8ea250d716749abfad",
);
/**
 * 0x2b, ACCESS_TOKEN, REFRESH_TOKEN under HKDF-SHA256(PREVIOUS_REFRESH_TOKEN,
 * salt GRANT, info "replay"), nonce c0..cb.
 */
const REPLAY_RECORD = hex(
  "c0c1c2c3c4c5c6c7c8c9cacb6b2ed23cdd26b810c7a477cf3ab6e8867867b60ecf1c98f3e24139f6cbed45bfbaa1f8798e64c52438ab4321f159d92f49060e9a2626efe7042674d1345af60cf26a147095b3e17b22d69555f7c5d7881f8ac2ebec936bffb861520bfc2d898b9979627240b90a",
);

/** Every copy of `sealed` with one bit changed. */
function tampered(sealed: Buffer): Buffer[] {
  return Array.from(sealed, (_, index) => {
    const copy = Buffer.from(sealed);
    copy[index] = copy[index]! ^ 0x01;
    return copy;
  });
}

/** Opens `nonce | ciphertext | tag` with node:crypto directly. */
function gcmOpen(key: Buffer, sealed: Buffer, aad?: string): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, 12));
  decipher.setAuthTag(sealed.subarray(-16));
  if (aad !== undefined) {
    decipher.setAAD(Buffer.from(aad));
  }
  return Buffer.concat([
    decipher.update(sealed.subarray(12, -16)),
    decipher.final(),
  ]);
}

/** Seals with node:crypto directly, under a derived key. */
function gcmSealDerived(
  secret: Buffer,
  info: string,
  plaintext: Buffer,
): Buffer {
  const key = Buffer.from(hkdfSync("sha256", secret, GRANT, info, 32));
  const nonce = Buffer.alloc(12, 7);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  return Buffer.concat([
    nonce,
    cipher.update(plaintext),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
}

describe("secretBuffer", () => {
  it.each([0, 1, 12, 24, 32, 43, 60, 64, 65, 87, 4096])(
    "gives %i bytes memory of their own outside the V8 heap",
    (bytes) => {
      const buffer = secretBuffer(bytes);

      expect(buffer).toHaveLength(bytes);
      expect(hasOwnMemory(buffer)).toBe(true);
    },
  );

  it("is what a plain unpooled allocation of up to 64 bytes is not", () => {
    // Why the helper exists: V8 keeps these bytes inside its heap.
    expect(hasOwnMemory(Buffer.allocUnsafeSlow(64))).toBe(false);
    expect(hasOwnMemory(Buffer.allocUnsafeSlow(65))).toBe(true);
    expect(hasOwnMemory(Buffer.from("in the shared pool"))).toBe(false);
  });

  it("leaves nothing readable next to a short secret: the rest of its allocation is zero", () => {
    for (let round = 0; round < 50; round++) {
      const buffer = secretBuffer(24).fill(0xff);
      const whole = Buffer.from(buffer.buffer);

      expect(whole.subarray(0, 24).every((byte) => byte === 0xff)).toBe(true);
      expect(whole.subarray(24).every((byte) => byte === 0)).toBe(true);
    }
  });
});

describe("newSecret", () => {
  it("is 32 random bytes as unpadded base64url text in ASCII bytes", () => {
    const secrets = Array.from({ length: 200 }, () => newSecret());
    for (const secret of secrets) {
      const text = secret.toString("latin1");
      expect(text).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const decoded = Buffer.from(text, "base64url");
      expect(decoded).toHaveLength(32);
      // Canonical: nothing but the 32 bytes is encoded.
      expect(decoded.toString("base64url")).toBe(text);
      expect(hasOwnMemory(secret)).toBe(true);
    }
    expect(new Set(secrets.map((s) => s.toString("latin1"))).size).toBe(200);
    // All 64 characters occur over 8,600 of them: no value is unreachable.
    expect(new Set(Buffer.concat(secrets)).size).toBe(64);
  });
});

describe("hashSecret", () => {
  it("is the hex SHA-256 of the bytes presented", () => {
    expect(hashSecret(CODE)).toBe(
      "cf0931e168b49e987503caf18af6fe253b6b3d82a81008c3e8e1ee67c7c8dc55",
    );
  });

  it("hashes a string as its Latin-1 bytes, without a copy in the Buffer pool", () => {
    // Not a literal: the pool is searched for it below.
    const text = CODE.toString("latin1").split("").reverse().join("");
    const poolBefore = Buffer.allocUnsafe(1).buffer;

    const hash = hashSecret(text);

    for (const slab of [poolBefore, Buffer.allocUnsafe(1).buffer]) {
      expect(Buffer.from(slab).includes(text)).toBe(false);
    }
    expect(hash).toBe(hashSecret(Buffer.from(text, "latin1")));
    expect(hashSecret("\u00e9")).toBe(hashSecret(Buffer.from([0xe9])));
  });
});

describe("seal and unseal", () => {
  it("opens the known answer", () => {
    const password = unseal(SEALED_PASSWORD, KEY, GRANT);

    expect(password?.toString("latin1")).toBe(PASSWORD);
    expect(hasOwnMemory(password!)).toBe(true);
  });

  it("encrypts as nonce, ciphertext, tag under a new 32-byte key, with pw|<grantId> as additional data", () => {
    const password = ascii(PASSWORD);

    const { ciphertext, key } = seal(password, GRANT);

    expect(key).toHaveLength(32);
    expect(ciphertext).toHaveLength(12 + PASSWORD.length + 16);
    expect(gcmOpen(key, ciphertext, `pw|${GRANT}`).toString("latin1")).toBe(
      PASSWORD,
    );
    expect(ciphertext.includes(password)).toBe(false);
    expect(password.toString("latin1")).toBe(PASSWORD);
    expect(hasOwnMemory(ciphertext)).toBe(true);
    expect(hasOwnMemory(key)).toBe(true);
  });

  it("uses a new key and a new nonce each time", () => {
    const first = seal(ascii(PASSWORD), GRANT);
    const second = seal(ascii(PASSWORD), GRANT);

    expect(first.key.equals(second.key)).toBe(false);
    expect(first.ciphertext.subarray(0, 12)).not.toEqual(
      second.ciphertext.subarray(0, 12),
    );
    expect(unseal(first.ciphertext, second.key, GRANT)).toBeUndefined();
    expect(unseal(first.ciphertext, first.key, GRANT)).toEqual(ascii(PASSWORD));
  });

  it("does not open when any bit of the nonce, ciphertext or tag changed", () => {
    for (const changed of tampered(SEALED_PASSWORD)) {
      expect(unseal(changed, KEY, GRANT)).toBeUndefined();
    }
  });

  it("does not open for another grant", () => {
    expect(unseal(SEALED_PASSWORD, KEY, OTHER_GRANT)).toBeUndefined();
    expect(unseal(SEALED_PASSWORD, KEY, "")).toBeUndefined();
  });

  it("does not open under another key, and does not throw", () => {
    const otherKey = Buffer.from(KEY);
    otherKey[31] = 0;

    expect(unseal(SEALED_PASSWORD, otherKey, GRANT)).toBeUndefined();
    expect(unseal(SEALED_PASSWORD, Buffer.alloc(32), GRANT)).toBeUndefined();
    expect(unseal(SEALED_PASSWORD, Buffer.alloc(16), GRANT)).toBeUndefined();
    expect(unseal(SEALED_PASSWORD, Buffer.alloc(0), GRANT)).toBeUndefined();
  });

  it("does not open a shortened, emptied or zero-filled value, and does not throw", () => {
    for (const length of [0, 1, 11, 12, 27, 28, SEALED_PASSWORD.length - 1]) {
      expect(
        unseal(SEALED_PASSWORD.subarray(0, length), KEY, GRANT),
      ).toBeUndefined();
    }
    expect(
      unseal(Buffer.alloc(SEALED_PASSWORD.length), KEY, GRANT),
    ).toBeUndefined();
  });

  it("leaves its inputs as they were", () => {
    const sealed = Buffer.from(SEALED_PASSWORD);
    const key = Buffer.from(KEY);

    unseal(sealed, key, GRANT);
    unseal(sealed, key, OTHER_GRANT);

    expect(sealed.equals(SEALED_PASSWORD)).toBe(true);
    expect(key.equals(KEY)).toBe(true);
  });
});

describe("wrapKey and unwrapKey", () => {
  it("unwraps the known answer", () => {
    const key = unwrapKey(WRAPPED_KEY, CODE, GRANT);

    expect(key?.equals(KEY)).toBe(true);
    expect(hasOwnMemory(key!)).toBe(true);
  });

  it("wraps under HKDF-SHA256(secret, salt grantId, info wrap)", () => {
    const wrap = wrapKey(KEY, REFRESH_TOKEN, GRANT);

    const wrappingKey = Buffer.from(
      hkdfSync("sha256", REFRESH_TOKEN, GRANT, "wrap", 32),
    );
    expect(wrap).toHaveLength(12 + 32 + 16);
    expect(gcmOpen(wrappingKey, wrap).equals(KEY)).toBe(true);
    expect(wrap.includes(KEY)).toBe(false);
    expect(hasOwnMemory(wrap)).toBe(true);
    expect(unwrapKey(wrap, REFRESH_TOKEN, GRANT)?.equals(KEY)).toBe(true);
  });

  it("does not unwrap with another secret, and does not throw", () => {
    expect(unwrapKey(WRAPPED_KEY, REFRESH_TOKEN, GRANT)).toBeUndefined();
    expect(unwrapKey(WRAPPED_KEY, CODE.subarray(0, 42), GRANT)).toBeUndefined();
    expect(unwrapKey(WRAPPED_KEY, Buffer.alloc(0), GRANT)).toBeUndefined();
  });

  it("does not unwrap with what the server stores of the secret, its hash", () => {
    const hash = hashSecret(CODE);

    expect(unwrapKey(WRAPPED_KEY, ascii(hash), GRANT)).toBeUndefined();
    expect(unwrapKey(WRAPPED_KEY, hex(hash), GRANT)).toBeUndefined();
  });

  it("does not unwrap for another grant", () => {
    expect(unwrapKey(WRAPPED_KEY, CODE, OTHER_GRANT)).toBeUndefined();
  });

  it("does not unwrap when any bit changed, or when zero-filled", () => {
    for (const changed of tampered(WRAPPED_KEY)) {
      expect(unwrapKey(changed, CODE, GRANT)).toBeUndefined();
    }
    expect(
      unwrapKey(Buffer.alloc(WRAPPED_KEY.length), CODE, GRANT),
    ).toBeUndefined();
  });

  it("leaves its inputs as they were", () => {
    const key = Buffer.from(KEY);
    const secret = Buffer.from(CODE);

    const wrap = wrapKey(key, secret, GRANT);
    const before = Buffer.from(wrap);
    unwrapKey(wrap, secret, GRANT);

    expect(key.equals(KEY)).toBe(true);
    expect(secret.equals(CODE)).toBe(true);
    expect(wrap.equals(before)).toBe(true);
  });
});

describe("sealReplay and openReplay", () => {
  it("opens the known answer", () => {
    const pair = openReplay(REPLAY_RECORD, PREVIOUS_REFRESH_TOKEN, GRANT);

    expect(pair?.accessToken.equals(ACCESS_TOKEN)).toBe(true);
    expect(pair?.refreshToken.equals(REFRESH_TOKEN)).toBe(true);
    expect(hasOwnMemory(pair!.accessToken)).toBe(true);
    expect(hasOwnMemory(pair!.refreshToken)).toBe(true);
  });

  it("seals the pair under HKDF-SHA256(previous refresh token, salt grantId, info replay)", () => {
    const successor = {
      accessToken: Buffer.from(ACCESS_TOKEN),
      refreshToken: Buffer.from(REFRESH_TOKEN),
    };

    const record = sealReplay(successor, PREVIOUS_REFRESH_TOKEN, GRANT);

    const replayKey = Buffer.from(
      hkdfSync("sha256", PREVIOUS_REFRESH_TOKEN, GRANT, "replay", 32),
    );
    expect(
      gcmOpen(replayKey, record).equals(
        Buffer.concat([Buffer.from([43]), ACCESS_TOKEN, REFRESH_TOKEN]),
      ),
    ).toBe(true);
    expect(record.includes(ACCESS_TOKEN)).toBe(false);
    expect(record.includes(REFRESH_TOKEN)).toBe(false);
    expect(hasOwnMemory(record)).toBe(true);
    expect(successor.accessToken.equals(ACCESS_TOKEN)).toBe(true);
    expect(successor.refreshToken.equals(REFRESH_TOKEN)).toBe(true);
    expect(openReplay(record, PREVIOUS_REFRESH_TOKEN, GRANT)).toEqual(
      successor,
    );
  });

  it("does not open with another token or for another grant, and does not throw", () => {
    expect(openReplay(REPLAY_RECORD, REFRESH_TOKEN, GRANT)).toBeUndefined();
    expect(
      openReplay(
        REPLAY_RECORD,
        ascii(hashSecret(PREVIOUS_REFRESH_TOKEN)),
        GRANT,
      ),
    ).toBeUndefined();
    expect(
      openReplay(REPLAY_RECORD, PREVIOUS_REFRESH_TOKEN, OTHER_GRANT),
    ).toBeUndefined();
  });

  it("does not open when any bit changed, or when zero-filled", () => {
    for (const changed of tampered(REPLAY_RECORD)) {
      expect(
        openReplay(changed, PREVIOUS_REFRESH_TOKEN, GRANT),
      ).toBeUndefined();
    }
    expect(
      openReplay(
        Buffer.alloc(REPLAY_RECORD.length),
        PREVIOUS_REFRESH_TOKEN,
        GRANT,
      ),
    ).toBeUndefined();
  });

  it("derives the replay key and the wrapping key of one token separately", () => {
    const wrap = wrapKey(KEY, PREVIOUS_REFRESH_TOKEN, GRANT);

    expect(openReplay(wrap, PREVIOUS_REFRESH_TOKEN, GRANT)).toBeUndefined();
    expect(
      unwrapKey(REPLAY_RECORD, PREVIOUS_REFRESH_TOKEN, GRANT),
    ).toBeUndefined();
  });

  it("does not open an authentic record that is not a pair", () => {
    const tooShort = gcmSealDerived(
      PREVIOUS_REFRESH_TOKEN,
      "replay",
      Buffer.from([200, 1, 2]),
    );
    const empty = gcmSealDerived(
      PREVIOUS_REFRESH_TOKEN,
      "replay",
      Buffer.alloc(0),
    );

    expect(openReplay(tooShort, PREVIOUS_REFRESH_TOKEN, GRANT)).toBeUndefined();
    expect(openReplay(empty, PREVIOUS_REFRESH_TOKEN, GRANT)).toBeUndefined();
  });
});

describe("derived keys", () => {
  const derived = vi.mocked(hkdfSync);

  beforeEach(() => {
    derived.mockClear();
  });

  /** Whether every key HKDF returned since the last clear is all zeros. */
  function allWiped(): boolean {
    return derived.mock.results.every((result) =>
      new Uint8Array(result.value as ArrayBuffer).every((byte) => byte === 0),
    );
  }

  it("are zero-filled once a key is wrapped or unwrapped", () => {
    unwrapKey(wrapKey(KEY, CODE, GRANT), CODE, GRANT);
    unwrapKey(WRAPPED_KEY, REFRESH_TOKEN, GRANT);

    expect(derived).toHaveBeenCalledTimes(3);
    expect(allWiped()).toBe(true);
  });

  it("are zero-filled once a replay record is sealed or opened", () => {
    const pair = { accessToken: ACCESS_TOKEN, refreshToken: REFRESH_TOKEN };
    openReplay(sealReplay(pair, CODE, GRANT), CODE, GRANT);
    openReplay(REPLAY_RECORD, CODE, GRANT);

    expect(derived).toHaveBeenCalledTimes(3);
    expect(allWiped()).toBe(true);
  });
});

describe("intermediate plaintext", () => {
  const isZero = (buffer: Buffer) => buffer.every((byte) => byte === 0);

  /** The buffers `Buffer.allocUnsafeSlow` handed out while `action` ran. */
  function allocatedDuring(action: () => unknown): Buffer[] {
    const allocate = vi.spyOn(Buffer, "allocUnsafeSlow");
    try {
      action();
      return allocate.mock.results.map((result) => result.value as Buffer);
    } finally {
      allocate.mockRestore();
    }
  }

  beforeEach(() => {
    decrypted.length = 0;
  });

  it("wipes the random bytes a new secret was encoded from", () => {
    let secret: Buffer | undefined;

    const allocated = allocatedDuring(() => {
      secret = newSecret();
    });

    // Each is the allocation a short secret is a view of.
    const raw = allocated.filter((buffer) => buffer.buffer !== secret!.buffer);
    expect(allocated).toHaveLength(2);
    expect(raw).toHaveLength(1);
    expect(isZero(raw[0]!)).toBe(true);
    expect(isZero(secret!)).toBe(false);
  });

  it("wipes the pair a replay record was sealed from", () => {
    const allocated = allocatedDuring(() =>
      sealReplay(
        { accessToken: ACCESS_TOKEN, refreshToken: REFRESH_TOKEN },
        PREVIOUS_REFRESH_TOKEN,
        GRANT,
      ),
    );

    const pair = allocated.filter((buffer) => buffer.length === 1 + 43 + 43);
    expect(pair).toHaveLength(1);
    expect(isZero(pair[0]!)).toBe(true);
  });

  it("wipes the decrypted pair once the tokens are copied out of it", () => {
    const pair = openReplay(REPLAY_RECORD, PREVIOUS_REFRESH_TOKEN, GRANT);

    expect(decrypted).toHaveLength(1);
    expect(decrypted[0]).toHaveLength(1 + 43 + 43);
    expect(isZero(decrypted[0]!)).toBe(true);
    expect(pair?.accessToken.equals(ACCESS_TOKEN)).toBe(true);
    expect(pair?.refreshToken.equals(REFRESH_TOKEN)).toBe(true);
  });

  it("wipes what was decrypted before the tag turned out to be wrong", () => {
    const wrongTag = Buffer.from(SEALED_PASSWORD);
    wrongTag[wrongTag.length - 1]! ^= 0x01;

    expect(unseal(wrongTag, KEY, GRANT)).toBeUndefined();

    // The cipher had already produced the password when the tag failed.
    expect(decrypted).toHaveLength(1);
    expect(decrypted[0]).toHaveLength(PASSWORD.length);
    expect(isZero(decrypted[0]!)).toBe(true);
  });

  it("hands a password that opened to the caller as it is", () => {
    const password = unseal(SEALED_PASSWORD, KEY, GRANT);

    expect(decrypted).toEqual([ascii(PASSWORD)]);
    expect(decrypted[0]).toBe(password);
  });
});

describe("zeroFill", () => {
  it("overwrites every buffer it is given and skips what is absent", () => {
    const first = Buffer.from(KEY);
    const second = ascii(PASSWORD);

    zeroFill(first, undefined, second);

    expect(first.equals(Buffer.alloc(32))).toBe(true);
    expect(second.equals(Buffer.alloc(PASSWORD.length))).toBe(true);
  });
});

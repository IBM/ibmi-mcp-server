/**
 * An RSA key pair on disk for tests of IBM i HTTP authentication, which
 * reads its keys from the paths in `config.ibmiHttpAuth`.
 *
 * @module tests/ibmi-mcp-server/auth/testKeyPair
 */

import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const TEST_KEY_ID = "test-key";

export interface TestKeyPair {
  publicKeyPem: string;
  /** The `config.ibmiHttpAuth` settings that select this key pair. */
  settings: { privateKeyPath: string; publicKeyPath: string; keyId: string };
  remove(): void;
}

export function createTestKeyPair(): TestKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const dir = mkdtempSync(path.join(tmpdir(), "ibmi-auth-test-"));
  const settings = {
    privateKeyPath: path.join(dir, "private.pem"),
    publicKeyPath: path.join(dir, "public.pem"),
    keyId: TEST_KEY_ID,
  };
  writeFileSync(settings.privateKeyPath, privateKey);
  writeFileSync(settings.publicKeyPath, publicKey);
  return {
    publicKeyPem: publicKey,
    settings,
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}

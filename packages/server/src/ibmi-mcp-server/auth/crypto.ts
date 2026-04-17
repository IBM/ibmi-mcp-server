/**
 * @fileoverview Helpers for decrypting IBM i auth envelopes and exposing server key metadata.
 */

import { readFileSync } from "fs";
import path from "path";
import {
  createDecipheriv,
  createPrivateKey,
  privateDecrypt,
  type KeyObject,
} from "crypto";
import { config } from "@/config/index.js";
import { JsonRpcErrorCode, McpError } from "@/types-global/errors.js";
import {
  logger,
  requestContextService,
  type RequestContext,
} from "@/utils/index.js";
import {
  type AuthCredentials,
  type DecryptedAuthPayload,
  type EncryptedAuthEnvelope,
} from "./types.js";

interface LoadedKeyPair {
  keyId: string;
  privateKey: KeyObject;
  publicKey: string;
}

let cachedKeyPair: LoadedKeyPair | null = null;

function resolvePath(filePath: string): string {
  return path.isAbsolute(filePath)
    ? filePath
    : path.resolve(process.cwd(), filePath);
}

function loadKeyPair(): LoadedKeyPair {
  if (cachedKeyPair) {
    return cachedKeyPair;
  }

  const { privateKeyPath, publicKeyPath, keyId } = config.ibmiHttpAuth;

  if (!privateKeyPath || !publicKeyPath || !keyId) {
    throw new Error(
      "IBM i HTTP auth keys are not configured. Ensure private key, public key, and key ID are provided.",
    );
  }

  const privateKeyPem = readFileSync(resolvePath(privateKeyPath), "utf8");
  const publicKeyPem = readFileSync(resolvePath(publicKeyPath), "utf8");

  cachedKeyPair = {
    keyId,
    publicKey: publicKeyPem,
    privateKey: createPrivateKey({ key: privateKeyPem, format: "pem" }),
  };

  return cachedKeyPair;
}

export function getPublicKeyMetadata(): { keyId: string; publicKey: string } {
  const { keyId, publicKey } = loadKeyPair();
  return { keyId, publicKey };
}

function decryptSessionKey(
  encryptedSessionKey: string,
  context: RequestContext,
): Buffer {
  try {
    const keyPair = loadKeyPair();
    const buffer = Buffer.from(encryptedSessionKey, "base64");
    return privateDecrypt(
      {
        key: keyPair.privateKey,
        oaepHash: "sha256",
      },
      buffer,
    );
  } catch (error) {
    logger.warning(
      {
        ...context,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to decrypt session key",
    );
    throw new McpError(
      JsonRpcErrorCode.InvalidRequest,
      "Unable to decrypt session key",
    );
  }
}

function decryptPayload(
  ciphertext: string,
  iv: string,
  authTag: string,
  sessionKey: Buffer,
  context: RequestContext,
): AuthCredentials & { request: unknown } {
  try {
    if (sessionKey.length !== 32) {
      throw new Error(
        `Invalid session key length: expected 32 bytes, received ${sessionKey.length}`,
      );
    }

    const decipher = createDecipheriv(
      "aes-256-gcm",
      sessionKey,
      Buffer.from(iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(authTag, "base64"));

    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64")),
      decipher.final(),
    ]);

    const parsed = JSON.parse(decrypted.toString("utf8"));

    if (!parsed || typeof parsed !== "object") {
      throw new Error("Decrypted payload is not a JSON object");
    }

    const { credentials, request } = parsed as {
      credentials?: AuthCredentials;
      request?: unknown;
    };

    if (!credentials) {
      throw new Error("Decrypted payload missing credentials");
    }

    return { ...credentials, request };
  } catch (error) {
    logger.warning(
      {
        ...context,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to decrypt authentication payload",
    );
    throw new McpError(
      JsonRpcErrorCode.InvalidRequest,
      "Unable to decrypt authentication payload",
    );
  }
}

export function decryptAuthEnvelope(
  envelope: EncryptedAuthEnvelope,
  parentContext: RequestContext,
): DecryptedAuthPayload {
  const context = requestContextService.createRequestContext({
    ...parentContext,
    operation: "decryptAuthEnvelope",
    keyId: envelope.keyId,
  });

  const keyPair = loadKeyPair();
  if (envelope.keyId !== keyPair.keyId) {
    throw new McpError(
      JsonRpcErrorCode.InvalidRequest,
      "Unsupported key identifier",
    );
  }

  const sessionKey = decryptSessionKey(envelope.encryptedSessionKey, context);
  const { username, password, request } = decryptPayload(
    envelope.ciphertext,
    envelope.iv,
    envelope.authTag,
    sessionKey,
    context,
  );

  return {
    credentials: { username, password },
    request,
  };
}

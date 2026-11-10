/**
 * Tests for POST /api/v1/auth (IBM i sign-on → bearer token).
 *
 * Drives the real handler, envelope decryption and TokenManager; only the
 * Mapepire-facing AuthenticatedPoolManager calls are stubbed.
 *
 * @module tests/ibmi-mcp-server/auth/httpAuthEndpoint.test
 */

import { createCipheriv, publicEncrypt, randomBytes } from "node:crypto";
import { Hono } from "hono";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
// Must load first: AuthenticatedPoolManager imports logger from this barrel,
// which is circular with utils/internal.
import "../../../src/utils/index.js";
import { config } from "../../../src/config/index.js";
import { handleAuthRequest } from "../../../src/ibmi-mcp-server/auth/httpAuthEndpoint.js";
import { TokenManager } from "../../../src/ibmi-mcp-server/auth/tokenManager.js";
import { AuthenticatedPoolManager } from "../../../src/ibmi-mcp-server/services/authenticatedPoolManager.js";
import {
  JsonRpcErrorCode,
  McpError,
} from "../../../src/types-global/errors.js";
import {
  createTestKeyPair,
  TEST_KEY_ID as KEY_ID,
  type TestKeyPair,
} from "./testKeyPair.js";

const ENV_KEYS = [
  "DB2i_HOST",
  "DB2i_USER",
  "DB2i_PASS",
  "DB2i_IGNORE_UNAUTHORIZED",
] as const;

const savedAuthConfig = { ...config.ibmiHttpAuth };
let savedEnv: Record<string, string | undefined>;
let keyPair: TestKeyPair;

const app = new Hono();
app.post("/api/v1/auth", handleAuthRequest);

interface Envelope {
  keyId: string;
  encryptedSessionKey: string;
  iv: string;
  authTag: string;
  ciphertext: string;
}

/** Builds the encrypted envelope the same way get-access-token.js does. */
function buildEnvelope(
  payload: unknown = {
    credentials: { username: "TESTUSER", password: "secret" },
    request: { host: "ibmi.example.com" },
  },
): Envelope {
  const sessionKey = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sessionKey, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  return {
    keyId: KEY_ID,
    encryptedSessionKey: publicEncrypt(
      { key: keyPair.publicKeyPem, oaepHash: "sha256" },
      sessionKey,
    ).toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function postAuth(envelope: Envelope) {
  return app.request("/api/v1/auth", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(envelope),
  });
}

const sessionCount = () =>
  TokenManager.getInstance().getSessionStats().totalSessions;

let createPool: ReturnType<typeof vi.spyOn>;
let removePool: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
  keyPair = createTestKeyPair();
  Object.assign(config.ibmiHttpAuth, {
    enabled: true,
    ...keyPair.settings,
    allowedHosts: ["ibmi.example.com"],
  });
});

afterAll(() => {
  TokenManager.getInstance().shutdown();
  Object.assign(config.ibmiHttpAuth, savedAuthConfig);
  keyPair.remove();
});

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  const poolManager = AuthenticatedPoolManager.getInstance();
  createPool = vi.spyOn(poolManager, "createPool").mockResolvedValue();
  removePool = vi.spyOn(poolManager, "removePool").mockResolvedValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
});

describe("POST /api/v1/auth", () => {
  it("issues a bearer token backed by a per-user pool on successful sign-on", async () => {
    const res = await postAuth(buildEnvelope());
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      access_token: string;
      token_type: string;
    };
    expect(body.token_type).toBe("Bearer");

    const validation = TokenManager.getInstance().validateToken(
      body.access_token,
    );
    expect(validation.valid).toBe(true);
    expect(validation.session?.credentials).toMatchObject({
      host: "ibmi.example.com",
      user: "TESTUSER",
    });
    expect(createPool).toHaveBeenCalledTimes(1);
    expect(createPool.mock.calls[0]![0]).toBe(body.access_token);
    expect(removePool).not.toHaveBeenCalled();
  });

  it("leaves no token session or pool behind when the sign-on fails", async () => {
    const before = sessionCount();
    createPool.mockRejectedValue(
      new McpError(
        JsonRpcErrorCode.InitializationFailed,
        "Error in performInitialization: sign-on rejected",
      ),
    );

    const res = await postAuth(buildEnvelope());
    expect(res.status).toBe(401);

    // A failed sign-on must not consume a concurrent-session slot.
    expect(sessionCount()).toBe(before);
    const failedToken = createPool.mock.calls[0]![0] as string;
    expect(TokenManager.getInstance().validateToken(failedToken).valid).toBe(
      false,
    );
    expect(removePool).toHaveBeenCalledWith(failedToken, expect.anything());
  });

  it.each([
    [
      "a rejected password",
      new McpError(
        JsonRpcErrorCode.InitializationFailed,
        "Error in performInitialization: Password is incorrect for TESTUSER",
      ),
    ],
    ["an unreachable host", new Error("connect ECONNREFUSED 127.0.0.1:8076")],
  ])(
    "answers 401 'Authentication failed' without the reason for %s",
    async (_name, failure) => {
      createPool.mockRejectedValue(failure);

      const res = await postAuth(buildEnvelope());

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({
        error: {
          code: JsonRpcErrorCode.Unauthorized,
          message: "Authentication failed",
        },
      });
    },
  );

  it("refuses a host that is not allow-listed with 403, before any connection attempt", async () => {
    const before = sessionCount();

    const res = await postAuth(
      buildEnvelope({
        credentials: { username: "TESTUSER", password: "secret" },
        request: { host: "internal.example.com" },
      }),
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: {
        code: JsonRpcErrorCode.Forbidden,
        message: "Sign-on to this host is not allowed",
      },
    });
    expect(createPool).not.toHaveBeenCalled();
    expect(sessionCount()).toBe(before);
  });

  it("matches allow-listed host names without regard to case", async () => {
    const res = await postAuth(
      buildEnvelope({
        credentials: { username: "TESTUSER", password: "secret" },
        request: { host: "IBMI.Example.com" },
      }),
    );
    expect(res.status).toBe(201);
  });

  it("opens one connection for the sign-on, whatever pool size the client asks for", async () => {
    await postAuth(
      buildEnvelope({
        credentials: { username: "TESTUSER", password: "secret" },
        request: { host: "ibmi.example.com", poolstart: 50, poolmax: 20 },
      }),
    );
    expect(createPool.mock.calls[0]![2]).toEqual({
      startingSize: 1,
      maxSize: 20,
    });
  });

  it("skips IBM i certificate verification by default", async () => {
    await postAuth(buildEnvelope());
    expect(createPool.mock.calls[0]![1]).toMatchObject({
      rejectUnauthorized: false,
    });
  });

  it("honors DB2i_IGNORE_UNAUTHORIZED=false without a DB2i service account", async () => {
    // The documented ibmi-auth setup: DB2i_HOST only, no DB2i_USER/DB2i_PASS.
    process.env.DB2i_HOST = "ibmi.example.com";
    process.env.DB2i_IGNORE_UNAUTHORIZED = "false";
    expect(config.db2i).toBeUndefined();

    await postAuth(buildEnvelope());
    expect(createPool.mock.calls[0]![1]).toMatchObject({
      rejectUnauthorized: true,
    });
  });

  it("rejects an envelope whose GCM auth tag is truncated", async () => {
    const before = sessionCount();
    const envelope = buildEnvelope();
    envelope.authTag = Buffer.from(envelope.authTag, "base64")
      .subarray(0, 4)
      .toString("base64");

    const res = await postAuth(envelope);
    expect(res.status).toBe(400);
    expect(createPool).not.toHaveBeenCalled();
    expect(sessionCount()).toBe(before);
  });

  it("rejects an envelope whose ciphertext was tampered with", async () => {
    const envelope = buildEnvelope();
    const ciphertext = Buffer.from(envelope.ciphertext, "base64");
    ciphertext[0] = ciphertext[0]! ^ 0xff;
    envelope.ciphertext = ciphertext.toString("base64");

    const res = await postAuth(envelope);
    expect(res.status).toBe(400);
    expect(createPool).not.toHaveBeenCalled();
  });

  it("rejects an envelope for an unknown key id", async () => {
    const res = await postAuth({ ...buildEnvelope(), keyId: "other-key" });
    expect(res.status).toBe(400);
    expect(createPool).not.toHaveBeenCalled();
  });
});

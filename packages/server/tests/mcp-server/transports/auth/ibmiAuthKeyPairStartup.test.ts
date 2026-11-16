/**
 * Tests that the IBM i HTTP authentication key pair is read when the HTTP
 * transport starts, so a bad key path stops startup.
 *
 * Kept in its own file: the key pair is cached once it has been read, and
 * nothing here may read one successfully.
 *
 * @module tests/mcp-server/transports/auth/ibmiAuthKeyPairStartup.test
 */

import { afterEach, describe, expect, it } from "vitest";
import { config } from "../../../../src/config/index.js";
import { createHttpAuth } from "../../../../src/mcp-server/transports/auth/index.js";
import { JsonRpcErrorCode } from "../../../../src/types-global/errors.js";
import { requestContextService } from "../../../../src/utils/index.js";

const savedConfig = {
  mcpAuthMode: config.mcpAuthMode,
  ibmiHttpAuth: { ...config.ibmiHttpAuth },
};

afterEach(() => {
  config.mcpAuthMode = savedConfig.mcpAuthMode;
  Object.assign(config.ibmiHttpAuth, savedConfig.ibmiHttpAuth);
});

describe("createHttpAuth with IBM i HTTP authentication enabled", () => {
  it("refuses to start when the key files cannot be read", async () => {
    config.mcpAuthMode = "ibmi";
    Object.assign(config.ibmiHttpAuth, {
      enabled: true,
      privateKeyPath: "/nonexistent/private.pem",
      publicKeyPath: "/nonexistent/public.pem",
      keyId: "test-key",
      allowedHosts: ["ibmi.example.com"],
    });

    await expect(
      createHttpAuth(
        requestContextService.createRequestContext({
          operation: "ibmiAuthKeyPairStartupTest",
        }),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ConfigurationError,
      message: expect.stringMatching(
        /^The IBM i HTTP authentication key pair could not be loaded \(IBMI_AUTH_PRIVATE_KEY_PATH, IBMI_AUTH_PUBLIC_KEY_PATH\): ENOENT.*\/nonexistent\/private\.pem/,
      ),
    });
  });
});

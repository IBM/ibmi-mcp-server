/**
 * Tests for auth mode selection at startup: the removed `jwt` mode is
 * refused and the deprecated IBM i token mode warns once.
 *
 * @module tests/mcp-server/transports/auth/authFactory.test
 */

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
import { config } from "../../../../src/config/index.js";
import {
  assertAuthModeSupported,
  createHttpAuth,
} from "../../../../src/mcp-server/transports/auth/index.js";
import { JsonRpcErrorCode } from "../../../../src/types-global/errors.js";
import { logger, requestContextService } from "../../../../src/utils/index.js";
import {
  createTestKeyPair,
  type TestKeyPair,
} from "../../../ibmi-mcp-server/auth/testKeyPair.js";

const DEPRECATION =
  "IBM i HTTP token authentication is deprecated and will be removed in a future major release; use MCP_AUTH_MODE=oauth for multi-user remote deployments.";

const savedConfig = {
  mcpAuthMode: config.mcpAuthMode,
  ibmiHttpAuth: { ...config.ibmiHttpAuth },
};
let keyPair: TestKeyPair;

const context = () =>
  requestContextService.createRequestContext({ operation: "authFactoryTest" });

beforeAll(() => {
  keyPair = createTestKeyPair();
});

afterAll(() => {
  keyPair.remove();
});

beforeEach(() => {
  config.mcpAuthMode = "none";
  Object.assign(config.ibmiHttpAuth, {
    enabled: false,
    ...keyPair.settings,
    allowedHosts: ["ibmi.example.com"],
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  config.mcpAuthMode = savedConfig.mcpAuthMode;
  Object.assign(config.ibmiHttpAuth, savedConfig.ibmiHttpAuth);
});

describe("assertAuthModeSupported", () => {
  it("refuses MCP_AUTH_MODE=jwt and names oauth as the replacement", () => {
    config.mcpAuthMode = "jwt";
    let thrown: unknown;
    try {
      assertAuthModeSupported();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      code: JsonRpcErrorCode.ConfigurationError,
      message:
        "MCP_AUTH_MODE=jwt is no longer supported. Use MCP_AUTH_MODE=oauth with MCP_RESOURCE_URL and OAUTH_ISSUER_URL.",
    });
  });

  it.each(["none", "oauth", "ibmi"] as const)(
    "accepts MCP_AUTH_MODE=%s",
    (mode) => {
      config.mcpAuthMode = mode;
      expect(() => assertAuthModeSupported()).not.toThrow();
    },
  );
});

describe("createHttpAuth", () => {
  it("refuses MCP_AUTH_MODE=jwt", async () => {
    config.mcpAuthMode = "jwt";
    await expect(createHttpAuth(context())).rejects.toThrow(
      /MCP_AUTH_MODE=jwt is no longer supported/,
    );
  });

  it("returns no authentication for MCP_AUTH_MODE=none, without a deprecation warning", async () => {
    const warning = vi.spyOn(logger, "warning");
    expect(await createHttpAuth(context())).toBeNull();
    expect(warning).not.toHaveBeenCalled();
  });

  it("warns once that IBM i token authentication is deprecated when MCP_AUTH_MODE=ibmi", async () => {
    const warning = vi.spyOn(logger, "warning");
    config.mcpAuthMode = "ibmi";
    config.ibmiHttpAuth.enabled = true;

    const auth = await createHttpAuth(context());

    expect(auth?.protectedResourceMetadata).toBeUndefined();
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(expect.anything(), DEPRECATION);
  });

  it("warns when only the /api/v1/auth endpoint is enabled", async () => {
    const warning = vi.spyOn(logger, "warning");
    config.ibmiHttpAuth.enabled = true;

    await createHttpAuth(context());

    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(expect.anything(), DEPRECATION);
  });

  it.each([
    ["MCP_AUTH_MODE=ibmi", "ibmi", false],
    ["only the /api/v1/auth endpoint is enabled", "none", true],
  ] as const)(
    "refuses to start without a sign-on host allow-list when %s",
    async (_name, mode, endpointEnabled) => {
      config.mcpAuthMode = mode;
      config.ibmiHttpAuth.enabled = endpointEnabled;
      config.ibmiHttpAuth.allowedHosts = [];

      await expect(createHttpAuth(context())).rejects.toMatchObject({
        code: JsonRpcErrorCode.ConfigurationError,
        message:
          "IBM i HTTP authentication needs the IBM i hosts users may sign on to: set IBMI_AUTH_ALLOWED_HOSTS (comma-separated host names) or DB2i_HOST.",
      });
    },
  );
});

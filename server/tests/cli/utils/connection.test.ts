import { describe, it, expect, afterEach } from "vitest";
import { connectSystem } from "../../../src/cli/utils/connection";
import type { ResolvedSystem } from "../../../src/cli/config/types";

describe("connectSystem", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore original env vars
    process.env = { ...originalEnv };
  });

  const testSystem: ResolvedSystem = {
    name: "test",
    config: {
      host: "test400.example.com",
      port: 8076,
      user: "TESTUSER",
      password: "testpass",
      readOnly: false,
      confirm: false,
      timeout: 60,
      maxRows: 5000,
      ignoreUnauthorized: true,
    },
    source: "flag",
  };

  it("should set DB2i_HOST env var", async () => {
    const cleanup = await connectSystem(testSystem);
    expect(process.env.DB2i_HOST).toBe("test400.example.com");
    await cleanup();
  });

  it("should set DB2i_USER env var", async () => {
    const cleanup = await connectSystem(testSystem);
    expect(process.env.DB2i_USER).toBe("TESTUSER");
    await cleanup();
  });

  it("should set DB2i_PASS env var", async () => {
    const cleanup = await connectSystem(testSystem);
    expect(process.env.DB2i_PASS).toBe("testpass");
    await cleanup();
  });

  it("should set DB2i_IGNORE_UNAUTHORIZED env var", async () => {
    const cleanup = await connectSystem(testSystem);
    expect(process.env.DB2i_IGNORE_UNAUTHORIZED).toBe("true");
    await cleanup();
  });

  it("should set ignoreUnauthorized to false when configured", async () => {
    const system: ResolvedSystem = {
      ...testSystem,
      config: { ...testSystem.config, ignoreUnauthorized: false },
    };
    const cleanup = await connectSystem(system);
    expect(process.env.DB2i_IGNORE_UNAUTHORIZED).toBe("false");
    await cleanup();
  });

  it("should expand env var references in password", async () => {
    process.env.MY_TEST_PASS = "expanded-password";
    const system: ResolvedSystem = {
      ...testSystem,
      config: { ...testSystem.config, password: "${MY_TEST_PASS}" },
    };
    const cleanup = await connectSystem(system);
    expect(process.env.DB2i_PASS).toBe("expanded-password");
    await cleanup();
  });

  it("should return a cleanup function", async () => {
    const cleanup = await connectSystem(testSystem);
    expect(typeof cleanup).toBe("function");
    // Cleanup should not throw even without a real pool
    await expect(cleanup()).resolves.toBeUndefined();
  });
});

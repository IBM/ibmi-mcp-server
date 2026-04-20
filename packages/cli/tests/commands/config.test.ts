import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { createProgram } from "../../src/index";
import type { ConfigLayer } from "../../src/config/loader";

vi.mock("../../src/config/loader.js", () => ({
  loadConfig: vi.fn(),
  loadConfigLayers: vi.fn(),
  upsertSystem: vi.fn(),
  removeSystem: vi.fn(),
  setDefaultSystem: vi.fn(),
  getUserConfigPath: vi.fn(() => "/home/user/.ibmi/config.yaml"),
  getProjectConfigPath: vi.fn(() => "/project/.ibmi/config.yaml"),
}));

vi.mock("../../src/utils/connection.js", () => ({
  connectSystem: vi.fn(() => Promise.resolve(async () => {})),
}));

vi.mock("../../src/config/credentials.js", () => ({
  resolvePassword: vi.fn(() => Promise.resolve("password")),
  expandEnvVars: vi.fn((s: string) => s),
}));

import {
  loadConfig,
  loadConfigLayers,
} from "../../src/config/loader.js";

const mockLoadConfig = vi.mocked(loadConfig);
const mockLoadConfigLayers = vi.mocked(loadConfigLayers);

/** Capture stdout during a test action. */
async function captureStdout(action: () => Promise<void>): Promise<string> {
  const writes: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string) => {
    writes.push(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    await action();
  } finally {
    process.stdout.write = originalWrite;
  }
  return writes.join("");
}

/** Build a ConfigLayer for testing. */
function makeLayer(
  scope: "user" | "project",
  path: string,
  exists: boolean,
  config: Record<string, unknown> | null,
): ConfigLayer {
  return { scope, path, exists, config } as ConfigLayer;
}

// ─── Registration tests ─────────────────────────────────────────────────────

describe("ibmi config command — registration", () => {
  it("should register the config command", () => {
    const program = createProgram();
    const config = program.commands.find((c) => c.name() === "config");
    expect(config).toBeDefined();
    expect(config?.description()).toBe("Inspect CLI configuration");
  });

  it("should register show subcommand under config", () => {
    const program = createProgram();
    const config = program.commands.find((c) => c.name() === "config");
    const show = config?.commands.find((c) => c.name() === "show");
    expect(show).toBeDefined();
    expect(show?.description()).toBe(
      "Show active configuration with file origins",
    );
  });
});

// ─── config show ─────────────────────────────────────────────────────────────

describe("ibmi config show", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  it("should show file layer status", async () => {
    mockLoadConfigLayers.mockReturnValue([
      makeLayer("user", "/home/user/.ibmi/config.yaml", true, {
        systems: {
          dev: { host: "dev.com", port: 8076, user: "DEV" },
        },
      }),
    ]);
    mockLoadConfig.mockReturnValue({
      systems: {
        dev: {
          host: "dev.com",
          port: 8076,
          user: "DEV",
          readOnly: false,
          confirm: false,
          timeout: 60,
          maxRows: 5000,
          ignoreUnauthorized: true,
        },
      },
    });

    const output = await captureStdout(async () => {
      const program = createProgram();
      program.exitOverride();
      await program.parseAsync([
        "node",
        "ibmi",
        "config",
        "show",
        "--format",
        "table",
      ]);
    });

    expect(output).toContain("[user]");
    expect(output).toContain("loaded");
  });

  it("should show both user and project layers when project config exists", async () => {
    mockLoadConfigLayers.mockReturnValue([
      makeLayer("user", "/home/user/.ibmi/config.yaml", true, {
        systems: {
          prod: { host: "prod.com", port: 8076, user: "PROD" },
        },
      }),
      makeLayer("project", "/project/.ibmi/config.yaml", true, {
        default: "dev",
        systems: {
          dev: { host: "dev.com", port: 8076, user: "DEV" },
        },
      }),
    ]);
    mockLoadConfig.mockReturnValue({
      default: "dev",
      systems: {
        prod: {
          host: "prod.com",
          port: 8076,
          user: "PROD",
          readOnly: false,
          confirm: false,
          timeout: 60,
          maxRows: 5000,
          ignoreUnauthorized: true,
        },
        dev: {
          host: "dev.com",
          port: 8076,
          user: "DEV",
          readOnly: false,
          confirm: false,
          timeout: 60,
          maxRows: 5000,
          ignoreUnauthorized: true,
        },
      },
    });

    const output = await captureStdout(async () => {
      const program = createProgram();
      program.exitOverride();
      await program.parseAsync([
        "node",
        "ibmi",
        "config",
        "show",
        "--format",
        "json",
      ]);
    });

    const parsed = JSON.parse(output);
    expect(parsed.ok).toBe(true);

    const userLayer = parsed.data.find(
      (r: Record<string, unknown>) => r.PROPERTY === "[user]",
    );
    expect(userLayer?.VALUE).toBe("loaded");

    const projectLayer = parsed.data.find(
      (r: Record<string, unknown>) => r.PROPERTY === "[project]",
    );
    expect(projectLayer?.VALUE).toBe("loaded");
    expect(projectLayer?.SOURCE).toContain("/project/");
  });

  it("should show systems with correct origin", async () => {
    mockLoadConfigLayers.mockReturnValue([
      makeLayer("user", "/home/user/.ibmi/config.yaml", true, {
        systems: {
          prod: { host: "prod.com", port: 8076, user: "PROD" },
        },
      }),
      makeLayer("project", "/project/.ibmi/config.yaml", true, {
        systems: {
          dev: { host: "dev.com", port: 8076, user: "DEV" },
        },
      }),
    ]);
    mockLoadConfig.mockReturnValue({
      systems: {
        prod: {
          host: "prod.com",
          port: 8076,
          user: "PROD",
          readOnly: false,
          confirm: false,
          timeout: 60,
          maxRows: 5000,
          ignoreUnauthorized: true,
        },
        dev: {
          host: "dev.com",
          port: 8076,
          user: "DEV",
          readOnly: false,
          confirm: false,
          timeout: 60,
          maxRows: 5000,
          ignoreUnauthorized: true,
        },
      },
    });

    const output = await captureStdout(async () => {
      const program = createProgram();
      program.exitOverride();
      await program.parseAsync([
        "node",
        "ibmi",
        "config",
        "show",
        "--format",
        "json",
      ]);
    });

    const parsed = JSON.parse(output);

    const prodRow = parsed.data.find(
      (r: Record<string, unknown>) => r.PROPERTY === "systems.prod",
    );
    expect(prodRow?.SOURCE).toBe("user");
    expect(prodRow?.VALUE).toContain("prod.com");

    const devRow = parsed.data.find(
      (r: Record<string, unknown>) => r.PROPERTY === "systems.dev",
    );
    expect(devRow?.SOURCE).toBe("project");
    expect(devRow?.VALUE).toContain("dev.com");
  });

  it("should show default setting with correct origin", async () => {
    mockLoadConfigLayers.mockReturnValue([
      makeLayer("user", "/home/user/.ibmi/config.yaml", true, {
        default: "prod",
        systems: {
          prod: { host: "prod.com", port: 8076, user: "PROD" },
        },
      }),
      makeLayer("project", "/project/.ibmi/config.yaml", true, {
        default: "dev",
        systems: {
          dev: { host: "dev.com", port: 8076, user: "DEV" },
        },
      }),
    ]);
    mockLoadConfig.mockReturnValue({
      default: "dev",
      systems: {
        prod: {
          host: "prod.com",
          port: 8076,
          user: "PROD",
          readOnly: false,
          confirm: false,
          timeout: 60,
          maxRows: 5000,
          ignoreUnauthorized: true,
        },
        dev: {
          host: "dev.com",
          port: 8076,
          user: "DEV",
          readOnly: false,
          confirm: false,
          timeout: 60,
          maxRows: 5000,
          ignoreUnauthorized: true,
        },
      },
    });

    const output = await captureStdout(async () => {
      const program = createProgram();
      program.exitOverride();
      await program.parseAsync([
        "node",
        "ibmi",
        "config",
        "show",
        "--format",
        "json",
      ]);
    });

    const parsed = JSON.parse(output);
    const defaultRow = parsed.data.find(
      (r: Record<string, unknown>) => r.PROPERTY === "default",
    );
    // Project overrides user, so origin should be "project"
    expect(defaultRow?.VALUE).toBe("dev");
    expect(defaultRow?.SOURCE).toBe("project");
  });

  it("should show active environment overrides", async () => {
    process.env["IBMI_SYSTEM"] = "test-sys";
    process.env["DB2i_HOST"] = "env-host.com";

    mockLoadConfigLayers.mockReturnValue([
      makeLayer("user", "/home/user/.ibmi/config.yaml", false, null),
    ]);
    mockLoadConfig.mockReturnValue({ systems: {} });

    const output = await captureStdout(async () => {
      const program = createProgram();
      program.exitOverride();
      await program.parseAsync([
        "node",
        "ibmi",
        "config",
        "show",
        "--format",
        "json",
      ]);
    });

    const parsed = JSON.parse(output);

    const ibmiSystemRow = parsed.data.find(
      (r: Record<string, unknown>) => r.PROPERTY === "IBMI_SYSTEM",
    );
    expect(ibmiSystemRow?.VALUE).toBe("test-sys");
    expect(ibmiSystemRow?.SOURCE).toBe("environment");

    const db2HostRow = parsed.data.find(
      (r: Record<string, unknown>) => r.PROPERTY === "DB2i_HOST",
    );
    expect(db2HostRow?.VALUE).toBe("env-host.com");
    expect(db2HostRow?.SOURCE).toBe("environment");
  });

  it("should mask DB2i_PASS in environment overrides", async () => {
    process.env["DB2i_PASS"] = "supersecret";

    mockLoadConfigLayers.mockReturnValue([
      makeLayer("user", "/home/user/.ibmi/config.yaml", false, null),
    ]);
    mockLoadConfig.mockReturnValue({ systems: {} });

    const output = await captureStdout(async () => {
      const program = createProgram();
      program.exitOverride();
      await program.parseAsync([
        "node",
        "ibmi",
        "config",
        "show",
        "--format",
        "json",
      ]);
    });

    const parsed = JSON.parse(output);
    const passRow = parsed.data.find(
      (r: Record<string, unknown>) => r.PROPERTY === "DB2i_PASS",
    );
    expect(passRow?.VALUE).toBe("****");
    expect(passRow?.VALUE).not.toBe("supersecret");
  });

  it("should handle empty config gracefully", async () => {
    mockLoadConfigLayers.mockReturnValue([
      makeLayer("user", "/home/user/.ibmi/config.yaml", false, null),
    ]);
    mockLoadConfig.mockReturnValue({ systems: {} });

    const output = await captureStdout(async () => {
      const program = createProgram();
      program.exitOverride();
      await program.parseAsync([
        "node",
        "ibmi",
        "config",
        "show",
        "--format",
        "json",
      ]);
    });

    const parsed = JSON.parse(output);
    expect(parsed.ok).toBe(true);
    // Should at least have the user layer status row
    expect(parsed.data.length).toBeGreaterThanOrEqual(1);
    const userRow = parsed.data.find(
      (r: Record<string, unknown>) => r.PROPERTY === "[user]",
    );
    expect(userRow?.VALUE).toBe("not found");
  });

  it("should show 'not found' for user config when file does not exist", async () => {
    mockLoadConfigLayers.mockReturnValue([
      makeLayer("user", "/home/user/.ibmi/config.yaml", false, null),
    ]);
    mockLoadConfig.mockReturnValue({ systems: {} });

    const output = await captureStdout(async () => {
      const program = createProgram();
      program.exitOverride();
      await program.parseAsync([
        "node",
        "ibmi",
        "config",
        "show",
        "--format",
        "table",
      ]);
    });

    expect(output).toContain("not found");
  });
});

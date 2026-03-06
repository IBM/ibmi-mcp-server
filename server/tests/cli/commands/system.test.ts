import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { createProgram } from "../../../src/cli/index";

vi.mock("../../../src/cli/config/loader.js", () => ({
  loadConfig: vi.fn(),
  upsertSystem: vi.fn(),
  removeSystem: vi.fn(),
  setDefaultSystem: vi.fn(),
  getUserConfigPath: vi.fn(() => "/home/user/.ibmi/config.yaml"),
  getProjectConfigPath: vi.fn(() => "/project/.ibmi/config.yaml"),
}));

vi.mock("../../../src/cli/utils/connection.js", () => ({
  connectSystem: vi.fn(() => Promise.resolve(async () => {})),
}));

vi.mock("../../../src/cli/config/credentials.js", () => ({
  resolvePassword: vi.fn(() => Promise.resolve("password")),
  expandEnvVars: vi.fn((s: string) => s),
}));

import {
  loadConfig,
  upsertSystem,
  removeSystem,
  setDefaultSystem,
} from "../../../src/cli/config/loader.js";

const mockLoadConfig = vi.mocked(loadConfig);
const mockUpsertSystem = vi.mocked(upsertSystem);
const mockRemoveSystem = vi.mocked(removeSystem);
const mockSetDefaultSystem = vi.mocked(setDefaultSystem);

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

/** Capture stderr during a test action. */
async function captureStderr(action: () => Promise<void>): Promise<string> {
  const writes: string[] = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: string) => {
    writes.push(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    await action();
  } finally {
    process.stderr.write = originalWrite;
  }
  return writes.join("");
}

/** A minimal populated system config for reuse across tests. */
const makeSampleConfig = (withDefault = true) => ({
  systems: {
    prod: {
      host: "prod.example.com",
      port: 8076,
      user: "produser",
      password: "secret",
      readOnly: true,
      confirm: false,
      timeout: 60,
      maxRows: 5000,
      ignoreUnauthorized: true,
      defaultSchema: "MYLIB",
      description: "Production system",
    },
    dev: {
      host: "dev.example.com",
      port: 8076,
      user: "devuser",
      password: undefined,
      readOnly: false,
      confirm: false,
      timeout: 60,
      maxRows: 5000,
      ignoreUnauthorized: true,
      defaultSchema: undefined,
      description: undefined,
    },
  },
  default: withDefault ? "prod" : undefined,
});

// ─── Registration tests ───────────────────────────────────────────────────────

describe("ibmi system command — registration", () => {
  it("should register the system command", () => {
    const program = createProgram();
    const system = program.commands.find((c) => c.name() === "system");
    expect(system).toBeDefined();
    expect(system?.description()).toBe("Manage IBM i system connections");
  });

  it("should register all 7 subcommands under system", () => {
    const program = createProgram();
    const system = program.commands.find((c) => c.name() === "system");
    const subNames = system?.commands.map((c) => c.name()).sort();
    expect(subNames).toEqual(
      ["config-path", "default", "list", "remove", "show", "test", "add"].sort(),
    );
  });

  it("should register system list subcommand", () => {
    const program = createProgram();
    const system = program.commands.find((c) => c.name() === "system");
    const list = system?.commands.find((c) => c.name() === "list");
    expect(list).toBeDefined();
    expect(list?.description()).toBe("List all configured systems");
  });

  it("should register system show <name> subcommand", () => {
    const program = createProgram();
    const system = program.commands.find((c) => c.name() === "system");
    const show = system?.commands.find((c) => c.name() === "show");
    expect(show).toBeDefined();
    expect(show?.description()).toBe("Show configuration for a system");
    expect(show?.registeredArguments).toHaveLength(1);
    expect(show?.registeredArguments[0]?.name()).toBe("name");
    expect(show?.registeredArguments[0]?.required).toBe(true);
  });

  it("should register system add <name> subcommand with correct options", () => {
    const program = createProgram();
    const system = program.commands.find((c) => c.name() === "system");
    const add = system?.commands.find((c) => c.name() === "add");
    expect(add).toBeDefined();
    expect(add?.description()).toBe("Add a new system configuration");
    expect(add?.registeredArguments[0]?.name()).toBe("name");
    expect(add?.options.find((o) => o.long === "--host")).toBeDefined();
    expect(add?.options.find((o) => o.long === "--port")).toBeDefined();
    expect(add?.options.find((o) => o.long === "--user")).toBeDefined();
    expect(add?.options.find((o) => o.long === "--password")).toBeDefined();
    expect(add?.options.find((o) => o.long === "--description")).toBeDefined();
    expect(add?.options.find((o) => o.long === "--read-only")).toBeDefined();
    expect(add?.options.find((o) => o.long === "--default-schema")).toBeDefined();
  });

  it("should register system remove <name> subcommand", () => {
    const program = createProgram();
    const system = program.commands.find((c) => c.name() === "system");
    const remove = system?.commands.find((c) => c.name() === "remove");
    expect(remove).toBeDefined();
    expect(remove?.description()).toBe("Remove a system configuration");
    expect(remove?.registeredArguments[0]?.name()).toBe("name");
  });

  it("should register system default <name> subcommand", () => {
    const program = createProgram();
    const system = program.commands.find((c) => c.name() === "system");
    const dflt = system?.commands.find((c) => c.name() === "default");
    expect(dflt).toBeDefined();
    expect(dflt?.description()).toBe("Set the default system");
    expect(dflt?.registeredArguments[0]?.name()).toBe("name");
  });

  it("should register system test [name] subcommand with --all option", () => {
    const program = createProgram();
    const system = program.commands.find((c) => c.name() === "system");
    const test = system?.commands.find((c) => c.name() === "test");
    expect(test).toBeDefined();
    expect(test?.description()).toBe("Test connectivity to a system");
    expect(test?.registeredArguments[0]?.name()).toBe("name");
    expect(test?.registeredArguments[0]?.required).toBe(false);
    expect(test?.options.find((o) => o.long === "--all")).toBeDefined();
  });

  it("should register system config-path subcommand", () => {
    const program = createProgram();
    const system = program.commands.find((c) => c.name() === "system");
    const configPath = system?.commands.find((c) => c.name() === "config-path");
    expect(configPath).toBeDefined();
    expect(configPath?.description()).toBe("Show config file paths");
  });
});

// ─── system list ──────────────────────────────────────────────────────────────

describe("ibmi system list", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should render 'No systems configured' message when config is empty", async () => {
    mockLoadConfig.mockReturnValue({ systems: {} });

    const output = await captureStdout(async () => {
      const program = createProgram();
      program.exitOverride();
      await program.parseAsync(["node", "ibmi", "system", "list", "--format", "table"]);
    });

    expect(output).toContain("No systems configured");
  });

  it("should render system data with expected columns when systems exist", async () => {
    mockLoadConfig.mockReturnValue(makeSampleConfig());

    const output = await captureStdout(async () => {
      const program = createProgram();
      program.exitOverride();
      await program.parseAsync(["node", "ibmi", "system", "list", "--format", "table"]);
    });

    expect(output).toContain("NAME");
    expect(output).toContain("HOST");
    expect(output).toContain("USER");
    expect(output).toContain("PORT");
    expect(output).toContain("READ_ONLY");
    expect(output).toContain("DEFAULT");
    expect(output).toContain("prod");
    expect(output).toContain("prod.example.com");
    expect(output).toContain("produser");
    expect(output).toContain("dev");
    expect(output).toContain("dev.example.com");
  });

  it("should mark the default system with a check mark", async () => {
    mockLoadConfig.mockReturnValue(makeSampleConfig());

    const output = await captureStdout(async () => {
      const program = createProgram();
      program.exitOverride();
      await program.parseAsync(["node", "ibmi", "system", "list", "--format", "table"]);
    });

    expect(output).toContain("✓");
  });

  it("should render JSON envelope with system data when --format json", async () => {
    mockLoadConfig.mockReturnValue(makeSampleConfig());

    const output = await captureStdout(async () => {
      const program = createProgram();
      program.exitOverride();
      await program.parseAsync(["node", "ibmi", "system", "list", "--format", "json"]);
    });

    const parsed = JSON.parse(output);
    expect(parsed.ok).toBe(true);
    expect(Array.isArray(parsed.data)).toBe(true);
    expect(parsed.data).toHaveLength(2);

    const prodRow = parsed.data.find((r: Record<string, unknown>) => r.NAME === "prod");
    expect(prodRow).toBeDefined();
    expect(prodRow.HOST).toBe("prod.example.com");
    expect(prodRow.DEFAULT).toBe("✓");

    const devRow = parsed.data.find((r: Record<string, unknown>) => r.NAME === "dev");
    expect(devRow).toBeDefined();
    expect(devRow.DEFAULT).toBe("");
  });

  it("should render read-only status correctly", async () => {
    mockLoadConfig.mockReturnValue(makeSampleConfig());

    const output = await captureStdout(async () => {
      const program = createProgram();
      program.exitOverride();
      await program.parseAsync(["node", "ibmi", "system", "list", "--format", "json"]);
    });

    const parsed = JSON.parse(output);
    const prodRow = parsed.data.find((r: Record<string, unknown>) => r.NAME === "prod");
    const devRow = parsed.data.find((r: Record<string, unknown>) => r.NAME === "dev");
    expect(prodRow.READ_ONLY).toBe("yes");
    expect(devRow.READ_ONLY).toBe("no");
  });
});

// ─── system show <name> ───────────────────────────────────────────────────────

describe("ibmi system show", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should render property/value pairs for a known system", async () => {
    mockLoadConfig.mockReturnValue(makeSampleConfig());

    const output = await captureStdout(async () => {
      const program = createProgram();
      program.exitOverride();
      await program.parseAsync(["node", "ibmi", "system", "show", "prod", "--format", "table"]);
    });

    expect(output).toContain("PROPERTY");
    expect(output).toContain("VALUE");
    expect(output).toContain("host");
    expect(output).toContain("prod.example.com");
    expect(output).toContain("user");
    expect(output).toContain("produser");
    expect(output).toContain("port");
  });

  it("should mask password with asterisks", async () => {
    mockLoadConfig.mockReturnValue(makeSampleConfig());

    const output = await captureStdout(async () => {
      const program = createProgram();
      program.exitOverride();
      await program.parseAsync(["node", "ibmi", "system", "show", "prod", "--format", "table"]);
    });

    expect(output).toContain("****");
    expect(output).not.toContain("secret");
  });

  it("should show '(not set)' for password when password is absent", async () => {
    mockLoadConfig.mockReturnValue(makeSampleConfig());

    const output = await captureStdout(async () => {
      const program = createProgram();
      program.exitOverride();
      await program.parseAsync(["node", "ibmi", "system", "show", "dev", "--format", "table"]);
    });

    expect(output).toContain("(not set)");
  });

  it("should indicate which system is the default", async () => {
    mockLoadConfig.mockReturnValue(makeSampleConfig());

    const output = await captureStdout(async () => {
      const program = createProgram();
      program.exitOverride();
      await program.parseAsync(["node", "ibmi", "system", "show", "prod", "--format", "json"]);
    });

    const parsed = JSON.parse(output);
    const defaultRow = parsed.data.find(
      (r: Record<string, unknown>) => r.PROPERTY === "default",
    );
    expect(defaultRow?.VALUE).toBe("yes");
  });

  it("should write error to stderr when system not found", async () => {
    mockLoadConfig.mockReturnValue({ systems: {} });

    const stderr = await captureStderr(async () => {
      const program = createProgram();
      program.exitOverride();
      await program.parseAsync(["node", "ibmi", "system", "show", "nonexistent", "--format", "table"]);
    });

    expect(stderr).toContain("Error:");
    expect(stderr).toContain("nonexistent");
  });

  it("should output structured JSON error when system not found with --format json", async () => {
    mockLoadConfig.mockReturnValue({ systems: {} });

    const output = await captureStdout(async () => {
      const program = createProgram();
      program.exitOverride();
      await program.parseAsync(["node", "ibmi", "system", "show", "ghost", "--format", "json"]);
    });

    const parsed = JSON.parse(output);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBeDefined();
    expect(parsed.error.message).toContain("ghost");
  });
});

// ─── system add <name> ────────────────────────────────────────────────────────

describe("ibmi system add", () => {
  beforeEach(() => {
    mockLoadConfig.mockReturnValue({ systems: {} });
    mockUpsertSystem.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should call upsertSystem and render success when all required flags are provided", async () => {
    const output = await captureStdout(async () => {
      const program = createProgram();
      program.exitOverride();
      await program.parseAsync([
        "node",
        "ibmi",
        "system",
        "add",
        "mydev",
        "--host",
        "mydev.example.com",
        "--user",
        "admin",
        "--format",
        "table",
      ]);
    });

    expect(mockUpsertSystem).toHaveBeenCalledOnce();
    const [name, sysConfig] = mockUpsertSystem.mock.calls[0]!;
    expect(name).toBe("mydev");
    expect(sysConfig.host).toBe("mydev.example.com");
    expect(sysConfig.user).toBe("admin");
    expect(output).toContain('System "mydev" added');
  });

  it("should pass optional flags to upsertSystem", async () => {
    await captureStdout(async () => {
      const program = createProgram();
      program.exitOverride();
      await program.parseAsync([
        "node",
        "ibmi",
        "system",
        "add",
        "mydev",
        "--host",
        "mydev.example.com",
        "--user",
        "admin",
        "--port",
        "9000",
        "--password",
        "mypass",
        "--description",
        "My dev system",
        "--read-only",
        "--default-schema",
        "DEVLIB",
        "--format",
        "json",
      ]);
    });

    const [, sysConfig] = mockUpsertSystem.mock.calls[0]!;
    expect(sysConfig.port).toBe(9000);
    expect(sysConfig.password).toBe("mypass");
    expect(sysConfig.description).toBe("My dev system");
    expect(sysConfig.readOnly).toBe(true);
    expect(sysConfig.defaultSchema).toBe("DEVLIB");
  });

  it("should use default port 8076 when --port is not specified", async () => {
    await captureStdout(async () => {
      const program = createProgram();
      program.exitOverride();
      await program.parseAsync([
        "node",
        "ibmi",
        "system",
        "add",
        "mydev",
        "--host",
        "mydev.example.com",
        "--user",
        "admin",
        "--format",
        "json",
      ]);
    });

    const [, sysConfig] = mockUpsertSystem.mock.calls[0]!;
    expect(sysConfig.port).toBe(8076);
  });

  it("should write error and not call upsertSystem when --host/--user are missing in non-TTY", async () => {
    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });

    try {
      const stderr = await captureStderr(async () => {
        const program = createProgram();
        program.exitOverride();
        await program.parseAsync([
          "node",
          "ibmi",
          "system",
          "add",
          "mydev",
          "--format",
          "table",
        ]);
      });

      expect(mockUpsertSystem).not.toHaveBeenCalled();
      expect(stderr).toContain("Error:");
      expect(stderr).toContain("non-interactive");
    } finally {
      Object.defineProperty(process.stdin, "isTTY", {
        value: originalIsTTY,
        configurable: true,
      });
    }
  });

  it("should render JSON success message when --format json is used", async () => {
    const output = await captureStdout(async () => {
      const program = createProgram();
      program.exitOverride();
      await program.parseAsync([
        "node",
        "ibmi",
        "system",
        "add",
        "newdev",
        "--host",
        "newdev.example.com",
        "--user",
        "devuser",
        "--format",
        "json",
      ]);
    });

    const parsed = JSON.parse(output);
    expect(parsed.ok).toBe(true);
    expect(parsed.message).toContain("newdev");
  });
});

// ─── system remove <name> ────────────────────────────────────────────────────

describe("ibmi system remove", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should call removeSystem and render success when system exists", async () => {
    mockRemoveSystem.mockReturnValue(true);

    const output = await captureStdout(async () => {
      const program = createProgram();
      program.exitOverride();
      await program.parseAsync(["node", "ibmi", "system", "remove", "prod", "--format", "table"]);
    });

    expect(mockRemoveSystem).toHaveBeenCalledWith("prod");
    expect(output).toContain('System "prod" removed');
  });

  it("should write error when system does not exist", async () => {
    mockRemoveSystem.mockReturnValue(false);

    const stderr = await captureStderr(async () => {
      const program = createProgram();
      program.exitOverride();
      await program.parseAsync(["node", "ibmi", "system", "remove", "ghost", "--format", "table"]);
    });

    expect(stderr).toContain("Error:");
    expect(stderr).toContain("ghost");
  });

  it("should render JSON success when system removed with --format json", async () => {
    mockRemoveSystem.mockReturnValue(true);

    const output = await captureStdout(async () => {
      const program = createProgram();
      program.exitOverride();
      await program.parseAsync(["node", "ibmi", "system", "remove", "dev", "--format", "json"]);
    });

    const parsed = JSON.parse(output);
    expect(parsed.ok).toBe(true);
    expect(parsed.message).toContain("dev");
  });

  it("should render JSON error when system not found with --format json", async () => {
    mockRemoveSystem.mockReturnValue(false);

    const output = await captureStdout(async () => {
      const program = createProgram();
      program.exitOverride();
      await program.parseAsync(["node", "ibmi", "system", "remove", "ghost", "--format", "json"]);
    });

    const parsed = JSON.parse(output);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBeDefined();
  });
});

// ─── system default <name> ───────────────────────────────────────────────────

describe("ibmi system default", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should call setDefaultSystem and render success for a valid system", async () => {
    mockSetDefaultSystem.mockReturnValue(undefined);

    const output = await captureStdout(async () => {
      const program = createProgram();
      program.exitOverride();
      await program.parseAsync(["node", "ibmi", "system", "default", "dev", "--format", "table"]);
    });

    expect(mockSetDefaultSystem).toHaveBeenCalledWith("dev");
    expect(output).toContain('Default system set to "dev"');
  });

  it("should write error when setDefaultSystem throws", async () => {
    mockSetDefaultSystem.mockImplementation(() => {
      throw new Error('System "unknown" not found. Available systems: prod');
    });

    const stderr = await captureStderr(async () => {
      const program = createProgram();
      program.exitOverride();
      await program.parseAsync(["node", "ibmi", "system", "default", "unknown", "--format", "table"]);
    });

    expect(stderr).toContain("Error:");
    expect(stderr).toContain("unknown");
  });

  it("should render JSON success with --format json", async () => {
    mockSetDefaultSystem.mockReturnValue(undefined);

    const output = await captureStdout(async () => {
      const program = createProgram();
      program.exitOverride();
      await program.parseAsync(["node", "ibmi", "system", "default", "prod", "--format", "json"]);
    });

    const parsed = JSON.parse(output);
    expect(parsed.ok).toBe(true);
    expect(parsed.message).toContain("prod");
  });

  it("should render JSON error when setDefaultSystem throws with --format json", async () => {
    mockSetDefaultSystem.mockImplementation(() => {
      throw new Error("System not found");
    });

    const output = await captureStdout(async () => {
      const program = createProgram();
      program.exitOverride();
      await program.parseAsync(["node", "ibmi", "system", "default", "ghost", "--format", "json"]);
    });

    const parsed = JSON.parse(output);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.message).toContain("not found");
  });
});

// ─── system config-path ───────────────────────────────────────────────────────

describe("ibmi system config-path", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should render both user and project config paths", async () => {
    const output = await captureStdout(async () => {
      const program = createProgram();
      program.exitOverride();
      await program.parseAsync(["node", "ibmi", "system", "config-path", "--format", "table"]);
    });

    expect(output).toContain("/home/user/.ibmi/config.yaml");
    expect(output).toContain("/project/.ibmi/config.yaml");
    expect(output).toContain("user");
    expect(output).toContain("project");
  });

  it("should render SCOPE and PATH columns", async () => {
    const output = await captureStdout(async () => {
      const program = createProgram();
      program.exitOverride();
      await program.parseAsync(["node", "ibmi", "system", "config-path", "--format", "table"]);
    });

    expect(output).toContain("SCOPE");
    expect(output).toContain("PATH");
  });

  it("should render JSON envelope with both paths when --format json", async () => {
    const output = await captureStdout(async () => {
      const program = createProgram();
      program.exitOverride();
      await program.parseAsync(["node", "ibmi", "system", "config-path", "--format", "json"]);
    });

    const parsed = JSON.parse(output);
    expect(parsed.ok).toBe(true);
    expect(Array.isArray(parsed.data)).toBe(true);
    expect(parsed.data).toHaveLength(2);
    expect(parsed.meta.rows).toBe(2);

    const userRow = parsed.data.find((r: Record<string, unknown>) => r.SCOPE === "user");
    const projectRow = parsed.data.find((r: Record<string, unknown>) => r.SCOPE === "project");
    expect(userRow?.PATH).toBe("/home/user/.ibmi/config.yaml");
    expect(projectRow?.PATH).toBe("/project/.ibmi/config.yaml");
  });
});

// ─── system test [name] ───────────────────────────────────────────────────────

describe("ibmi system test", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should render connection result for a named system", async () => {
    mockLoadConfig.mockReturnValue(makeSampleConfig());

    const output = await captureStdout(async () => {
      const program = createProgram();
      program.exitOverride();
      await program.parseAsync(["node", "ibmi", "system", "test", "prod", "--format", "table"]);
    });

    expect(output).toContain("PROPERTY");
    expect(output).toContain("VALUE");
    expect(output).toContain("status");
    expect(output).toContain("connected");
  });

  it("should render connection results for all systems when --all is passed", async () => {
    mockLoadConfig.mockReturnValue(makeSampleConfig());

    const output = await captureStdout(async () => {
      const program = createProgram();
      program.exitOverride();
      await program.parseAsync(["node", "ibmi", "system", "test", "--all", "--format", "json"]);
    });

    const parsed = JSON.parse(output);
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toHaveLength(2);
    const names = parsed.data.map((r: Record<string, unknown>) => r.NAME);
    expect(names).toContain("prod");
    expect(names).toContain("dev");
  });

  it("should write error when no system is specified and no default is set", async () => {
    mockLoadConfig.mockReturnValue({ systems: {}, default: undefined });

    const stderr = await captureStderr(async () => {
      const program = createProgram();
      program.exitOverride();
      await program.parseAsync(["node", "ibmi", "system", "test", "--format", "table"]);
    });

    expect(stderr).toContain("Error:");
    expect(stderr).toContain("No system specified");
  });

  it("should write error when named system does not exist", async () => {
    mockLoadConfig.mockReturnValue({ systems: {} });

    const stderr = await captureStderr(async () => {
      const program = createProgram();
      program.exitOverride();
      await program.parseAsync(["node", "ibmi", "system", "test", "nosuchsystem", "--format", "table"]);
    });

    expect(stderr).toContain("Error:");
    expect(stderr).toContain("nosuchsystem");
  });

  it("should use the default system when no name argument is given", async () => {
    mockLoadConfig.mockReturnValue(makeSampleConfig());

    const output = await captureStdout(async () => {
      const program = createProgram();
      program.exitOverride();
      await program.parseAsync(["node", "ibmi", "system", "test", "--format", "json"]);
    });

    const parsed = JSON.parse(output);
    expect(parsed.ok).toBe(true);
    const systemRow = parsed.data.find(
      (r: Record<string, unknown>) => r.PROPERTY === "system",
    );
    expect(systemRow?.VALUE).toBe("prod");
  });

  it("should render error row when connection fails", async () => {
    const { connectSystem } = await import("../../../src/cli/utils/connection.js");
    vi.mocked(connectSystem).mockRejectedValue(new Error("Connection refused"));

    mockLoadConfig.mockReturnValue(makeSampleConfig());

    const output = await captureStdout(async () => {
      const program = createProgram();
      program.exitOverride();
      await program.parseAsync(["node", "ibmi", "system", "test", "prod", "--format", "json"]);
    });

    const parsed = JSON.parse(output);
    expect(parsed.ok).toBe(true);
    const statusRow = parsed.data.find(
      (r: Record<string, unknown>) => r.PROPERTY === "status",
    );
    expect(statusRow?.VALUE).toBe("error");
  });
});

/**
 * @fileoverview Tests for the per-source SSH setting: a YAML source connects
 * over SSH when it has an SSH key (`ssh-key` on the source, or `DB2i_SSH_KEY`),
 * to its own host as its own user. mapepire-js is mocked; no network or SSH
 * access is performed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const { mockConnectSSH2, mockWithConfig, MockPool, mockPoolInstance } =
  vi.hoisted(() => {
    const mockPoolInstance = {
      init: vi.fn().mockResolvedValue(undefined),
      end: vi.fn().mockResolvedValue(undefined),
      query: vi.fn(),
    };
    return {
      mockConnectSSH2: vi.fn(),
      mockWithConfig: vi.fn(),
      mockPoolInstance,
      MockPool: vi.fn(function () {
        return mockPoolInstance;
      }),
    };
  });

vi.mock("../../../src/utils/scheduling/index.js", () => ({
  SchedulerService: { getInstance: vi.fn() },
  schedulerService: {},
}));

vi.mock("@ibm/mapepire-js", () => ({
  default: {
    SQLJob: { withConfig: mockWithConfig },
    connectSSH2: mockConnectSSH2,
    createSSH2Connection: vi.fn(() => ({ exec: vi.fn(), upload: vi.fn() })),
    Pool: MockPool,
    getRootCertificate: vi.fn().mockResolvedValue("cert"),
  },
}));

import "../../../src/utils/index.js";
import { SourceManager } from "../../../src/ibmi-mcp-server/services/sourceManager.js";
import { SourceConfigSchema } from "../../../src/ibmi-mcp-server/schemas/config.js";
import type { RequestContext } from "../../../src/utils/internal/requestContext.js";

class TestSourceManager extends SourceManager {
  getPoolsMap() {
    return this.pools;
  }
  connect(sourceName: string, context: RequestContext) {
    return this.initializePool(
      sourceName,
      this.pools.get(sourceName)!.config,
      context,
    );
  }
}

const ctx: RequestContext = {
  requestId: "source-ssh-test",
  timestamp: new Date().toISOString(),
  operation: "Test",
};

describe("per-source SSH", () => {
  const originalEnv = { ...process.env };
  let dir: string;
  let keyA: string;
  let keyB: string;
  let sm: TestSourceManager;

  beforeEach(() => {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith("DB2i_")) delete process.env[k];
    }
    dir = mkdtempSync(path.join(tmpdir(), "source-ssh-"));
    keyA = path.join(dir, "id_a");
    keyB = path.join(dir, "id_b");
    writeFileSync(keyA, "fake-key-a");
    writeFileSync(keyB, "fake-key-b");

    MockPool.mockClear();
    mockPoolInstance.init.mockClear();
    mockConnectSSH2.mockReset().mockImplementation(async () => ({
      on: vi.fn(),
      end: vi.fn(),
    }));
    mockWithConfig.mockReset().mockImplementation(() => ({
      connect: vi.fn().mockResolvedValue({}),
      close: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn(() => "ready"),
      query: vi.fn(),
    }));
    sm = new TestSourceManager();
  });

  afterEach(async () => {
    await sm.closeAllSources();
    process.env = { ...originalEnv };
    rmSync(dir, { recursive: true, force: true });
  });

  it("connects each source with ssh-key to its own host as its own user", async () => {
    await sm.registerSource("dev", {
      host: "dev.example.com",
      user: "DEVUSER",
      "ssh-key": keyA,
    });
    await sm.registerSource("test", {
      host: "test.example.com",
      user: "TESTUSER",
      "ssh-key": keyB,
    });

    const pools = sm.getPoolsMap();
    expect(pools.get("dev")!.config.ssh).toMatchObject({
      host: "dev.example.com",
      username: "DEVUSER",
    });
    expect(pools.get("test")!.config.ssh).toMatchObject({
      host: "test.example.com",
      username: "TESTUSER",
    });
    // Lazy: nothing connects at registration.
    expect(mockConnectSSH2).not.toHaveBeenCalled();

    await sm.connect("dev", ctx);
    await sm.connect("test", ctx);

    expect(mockConnectSSH2).toHaveBeenCalledTimes(2);
    const [first, second] = mockConnectSSH2.mock.calls.map((c) => c[0]);
    expect(first).toMatchObject({
      host: "dev.example.com",
      username: "DEVUSER",
    });
    expect(first.privateKey.toString()).toBe("fake-key-a");
    expect(second).toMatchObject({
      host: "test.example.com",
      username: "TESTUSER",
    });
    expect(second.privateKey.toString()).toBe("fake-key-b");
    expect(first).not.toHaveProperty("password");
    expect(second).not.toHaveProperty("password");
    expect(MockPool).not.toHaveBeenCalled();
  });

  it("keeps a password-only source on the Mapepire daemon next to an SSH source", async () => {
    await sm.registerSource("dev", {
      host: "dev.example.com",
      user: "DEVUSER",
      "ssh-key": keyA,
    });
    await sm.registerSource("prod", {
      host: "prod.example.com",
      user: "PRODUSER",
      password: "prod-secret",
    });

    const prod = sm.getPoolsMap().get("prod")!.config;
    expect(prod.ssh).toBeUndefined();
    expect(prod.password).toBe("prod-secret");

    await sm.connect("prod", ctx);
    expect(MockPool).toHaveBeenCalledTimes(1);
    expect(MockPool.mock.calls[0]![0].creds).toMatchObject({
      host: "prod.example.com",
      user: "PRODUSER",
    });
    expect(mockConnectSSH2).not.toHaveBeenCalled();
  });

  it("does not send a source's password over SSH when it also has ssh-key", async () => {
    await sm.registerSource("dev", {
      host: "dev.example.com",
      user: "DEVUSER",
      password: "dev-secret",
      "ssh-key": keyA,
    });

    expect(sm.getPoolsMap().get("dev")!.config.password).toBe("");
    await sm.connect("dev", ctx);
    expect(JSON.stringify(mockConnectSSH2.mock.calls[0]![0])).not.toContain(
      "dev-secret",
    );
    expect(MockPool).not.toHaveBeenCalled();
  });

  it("uses DB2i_SSH_KEY for every source, each on its own host and user", async () => {
    process.env.DB2i_HOST = "env.example.com";
    process.env.DB2i_USER = "ENVUSER";
    process.env.DB2i_SSH_KEY = keyA;

    // An existing tools file: password sources, no ssh-key.
    await sm.registerSource("one", {
      host: "one.example.com",
      user: "ONE",
      password: "unused",
    });
    // `password: ${DB2i_PASS}` with a blank DB2i_PASS loads as null.
    await sm.registerSource("two", {
      host: "two.example.com",
      user: "TWO",
      password: null,
    });

    const pools = sm.getPoolsMap();
    expect(pools.get("one")!.config.ssh).toMatchObject({
      host: "one.example.com",
      username: "ONE",
    });
    expect(pools.get("two")!.config.ssh).toMatchObject({
      host: "two.example.com",
      username: "TWO",
    });
    expect(pools.get("one")!.config.ssh!.privateKey.toString()).toBe(
      "fake-key-a",
    );
  });

  it("lets a source's ssh-key override DB2i_SSH_KEY", async () => {
    process.env.DB2i_SSH_KEY = keyA;
    await sm.registerSource("dev", {
      host: "dev.example.com",
      user: "DEVUSER",
      "ssh-key": keyB,
    });
    expect(sm.getPoolsMap().get("dev")!.config.ssh!.privateKey.toString()).toBe(
      "fake-key-b",
    );
  });

  it("pins the host key per source", async () => {
    process.env.DB2i_SSH_HOST_KEY_SHA256 = "SHA256:env";
    await sm.registerSource("dev", {
      host: "dev.example.com",
      user: "DEVUSER",
      "ssh-key": keyA,
      "ssh-host-key-sha256": "SHA256:dev",
    });
    await sm.registerSource("test", {
      host: "test.example.com",
      user: "TESTUSER",
      "ssh-key": keyA,
    });
    const pools = sm.getPoolsMap();
    expect(pools.get("dev")!.config.ssh!.hostKeySha256).toBe("SHA256:dev");
    expect(pools.get("test")!.config.ssh!.hostKeySha256).toBe("SHA256:env");
  });

  it("rejects a source with neither a password nor an SSH key", async () => {
    await expect(
      sm.registerSource("nocreds", { host: "h", user: "u" }),
    ).rejects.toThrow(/Source 'nocreds' has no credential/);
  });

  it("names the source when its key file cannot be read", async () => {
    await expect(
      sm.registerSource("badkey", {
        host: "h",
        user: "u",
        "ssh-key": path.join(dir, "missing"),
      }),
    ).rejects.toThrow(/Source 'badkey'/);
  });

  it("replaces the pool on reload when the source switches to another key or to a password", async () => {
    const source = { host: "dev.example.com", user: "DEVUSER" };
    await sm.registerSource("dev", { ...source, "ssh-key": keyA });
    const first = sm.getPoolsMap().get("dev");

    // Unchanged: the same pool entry is kept.
    await sm.registerSource("dev", { ...source, "ssh-key": keyA });
    expect(sm.getPoolsMap().get("dev")).toBe(first);

    await sm.registerSource("dev", { ...source, "ssh-key": keyB });
    const second = sm.getPoolsMap().get("dev");
    expect(second).not.toBe(first);
    expect(second!.config.ssh!.privateKey.toString()).toBe("fake-key-b");

    await sm.registerSource("dev", { ...source, password: "pw" });
    const third = sm.getPoolsMap().get("dev");
    expect(third).not.toBe(second);
    expect(third!.config.ssh).toBeUndefined();
  });
});

describe("SourceConfigSchema – SSH fields", () => {
  it("accepts a source with ssh-key and no password", () => {
    const parsed = SourceConfigSchema.safeParse({
      host: "dev.example.com",
      user: "MYUSER",
      "ssh-key": "~/.ssh/id_ed25519",
      "ssh-host-key-sha256": "SHA256:abc",
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts a null password (blank ${DB2i_PASS})", () => {
    expect(
      SourceConfigSchema.safeParse({ host: "h", user: "u", password: null })
        .success,
    ).toBe(true);
  });

  it("rejects an empty ssh-key", () => {
    expect(
      SourceConfigSchema.safeParse({ host: "h", user: "u", "ssh-key": "" })
        .success,
    ).toBe(false);
  });
});

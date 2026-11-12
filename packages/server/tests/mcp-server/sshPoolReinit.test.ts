/**
 * @fileoverview Re-initialization of a pool whose SSH session died.
 * mapepire-js is mocked; no network or SSH access is performed.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PoolConnectionConfig } from "../../src/ibmi-mcp-server/services/baseConnectionPool.js";

const { mockConnectSSH2, mockWithConfig, makeJob } = vi.hoisted(() => {
  const makeJob = () => {
    const job = {
      status: "ready",
      connect: vi.fn().mockResolvedValue({}),
      close: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn(() => job.status),
      query: vi.fn(() => ({
        execute: vi.fn().mockResolvedValue({ success: true, data: [] }),
        close: vi.fn().mockResolvedValue(undefined),
      })),
    };
    return job;
  };
  return { mockConnectSSH2: vi.fn(), mockWithConfig: vi.fn(), makeJob };
});

vi.mock("../../src/utils/scheduling/index.js", () => ({
  SchedulerService: { getInstance: vi.fn() },
  schedulerService: {},
}));

vi.mock("@ibm/mapepire-js", () => ({
  default: {
    SQLJob: { withConfig: mockWithConfig },
    connectSSH2: mockConnectSSH2,
    createSSH2Connection: vi.fn(() => ({ exec: vi.fn(), upload: vi.fn() })),
    Pool: class {},
    getRootCertificate: vi.fn(),
  },
}));

import { BaseConnectionPool } from "../../src/ibmi-mcp-server/services/baseConnectionPool.js";

class TestPool extends BaseConnectionPool<string> {
  init(id: string, cfg: PoolConnectionConfig) {
    return this.initializePool(id, cfg, {} as never);
  }
  run(id: string) {
    return this.executeQuery(id, "SELECT 1 FROM SYSIBM.SYSDUMMY1");
  }
}

const makeClient = () => ({ on: vi.fn(), end: vi.fn() });

describe("pool re-initialization over a dead SSH session", () => {
  let jobs: ReturnType<typeof makeJob>[];
  let clients: ReturnType<typeof makeClient>[];

  beforeEach(() => {
    vi.clearAllMocks();
    jobs = [];
    clients = [];
    mockConnectSSH2.mockImplementation(async () => {
      const client = makeClient();
      clients.push(client);
      return client;
    });
    mockWithConfig.mockImplementation(() => {
      const job = makeJob();
      jobs.push(job);
      return job;
    });
  });

  it("closes the new session when two queries re-initialize a dead pool together", async () => {
    const pool = new TestPool();
    await pool.init("p", {
      host: "unused",
      user: "unused",
      password: "",
      ssh: {
        host: "reinit.example.com",
        port: 22,
        username: "TESTUSER",
        privateKey: Buffer.from("fake-key"),
        technique: "tcp",
      },
    });

    // The session dies, and reconnecting takes longer than the 100ms a second
    // initializer waits on `isConnecting`.
    jobs[0]!.status = "ended";
    mockConnectSSH2.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const client = makeClient();
      clients.push(client);
      return client;
    });

    await Promise.all([pool.run("p"), pool.run("p")]);
    expect(jobs).toHaveLength(2);

    // Closing the pool must release the only lease on the new session.
    await pool.closePool("p");
    await vi.waitFor(() => expect(jobs[1]!.close).toHaveBeenCalledTimes(1));
    expect(clients[1]!.end).toHaveBeenCalledTimes(1);
  });
});

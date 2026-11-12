/**
 * @fileoverview Unit tests for the shared SSH session (one ssh-single SQLJob
 * per IBM i target, leased by every pool). mapepire-js is mocked; no network or
 * SSH access is performed.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockConnectSSH2, mockWithConfig, makeJob, clientHandlers, mockClient } =
  vi.hoisted(() => {
    const clientHandlers: Record<string, (...args: unknown[]) => void> = {};
    const mockClient = {
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        clientHandlers[event] = cb;
      }),
      end: vi.fn(),
    };
    const makeJob = () => {
      const job = {
        status: "ready",
        connect: vi.fn().mockResolvedValue({}),
        close: vi.fn().mockResolvedValue(undefined),
        getStatus: vi.fn(() => job.status),
        query: vi.fn(() => ({ execute: vi.fn(), close: vi.fn() })),
      };
      return job;
    };
    return {
      mockConnectSSH2: vi.fn(),
      mockWithConfig: vi.fn(),
      makeJob,
      clientHandlers,
      mockClient,
    };
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

import {
  acquireSSHSession,
  hostKeyMatches,
} from "../../src/ibmi-mcp-server/services/sshSession.js";

const ssh = {
  host: "ibmi.example.com",
  port: 22,
  username: "TESTUSER",
  privateKey: Buffer.from("fake-key"),
  technique: "tcp" as const,
};

type MockJob = ReturnType<typeof makeJob>;

describe("shared SSH session", () => {
  let created: MockJob[];

  beforeEach(() => {
    vi.clearAllMocks();
    for (const k of Object.keys(clientHandlers)) delete clientHandlers[k];
    created = [];
    mockConnectSSH2.mockResolvedValue(mockClient);
    mockWithConfig.mockImplementation(() => {
      const job = makeJob();
      created.push(job);
      return job;
    });
  });

  it("opens one SSH session and one ssh-single job on init", async () => {
    const lease = acquireSSHSession(ssh);
    await lease.init();

    expect(mockConnectSSH2).toHaveBeenCalledTimes(1);
    expect(mockConnectSSH2).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "ibmi.example.com",
        port: 22,
        username: "TESTUSER",
        privateKey: expect.any(Buffer),
      }),
    );
    expect(mockWithConfig).toHaveBeenCalledTimes(1);
    expect(mockWithConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        transport: "ssh-single",
        sshSingleTechnique: "tcp",
      }),
      undefined,
    );
    expect(created[0]!.connect).toHaveBeenCalledTimes(1);
    expect(lease.isAlive?.()).toBe(true);
    lease.end();
  });

  it("uses password auth when no private key is given", async () => {
    const lease = acquireSSHSession({
      host: "h-pw",
      port: 22,
      username: "u",
      password: "secret",
      technique: "tcp",
    });
    await lease.init();
    expect(mockConnectSSH2).toHaveBeenCalledWith(
      expect.objectContaining({ password: "secret" }),
    );
    lease.end();
  });

  it("shares one session and job between leases with the same credentials", async () => {
    const a = acquireSSHSession(ssh);
    const b = acquireSSHSession(ssh);
    await Promise.all([a.init(), b.init()]);

    expect(mockConnectSSH2).toHaveBeenCalledTimes(1);
    expect(mockWithConfig).toHaveBeenCalledTimes(1);

    a.query("SELECT 1");
    b.query("SELECT 2");
    expect(created[0]!.query).toHaveBeenCalledTimes(2);
    a.end();
    b.end();
  });

  it("uses separate sessions for different credentials or JDBC options", async () => {
    const a = acquireSSHSession(ssh);
    const b = acquireSSHSession({ ...ssh, username: "OTHER" });
    const c = acquireSSHSession(ssh, { libraries: ["MYLIB"] });
    await Promise.all([a.init(), b.init(), c.init()]);

    expect(mockConnectSSH2).toHaveBeenCalledTimes(3);
    expect(created).toHaveLength(3);
    a.end();
    b.end();
    c.end();
  });

  it("closes the session only when the last lease ends", async () => {
    const a = acquireSSHSession(ssh);
    const b = acquireSSHSession(ssh);
    await Promise.all([a.init(), b.init()]);

    a.end();
    a.end(); // idempotent
    await Promise.resolve();
    expect(created[0]!.close).not.toHaveBeenCalled();
    expect(b.isAlive?.()).toBe(true);

    b.end();
    await vi.waitFor(() => expect(created[0]!.close).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(mockClient.end).toHaveBeenCalledTimes(1));
  });

  it("re-creates the session for a new lease after the last one ended", async () => {
    const a = acquireSSHSession(ssh);
    await a.init();
    a.end();
    await vi.waitFor(() => expect(created[0]!.close).toHaveBeenCalled());

    const b = acquireSSHSession(ssh);
    await b.init();
    expect(mockConnectSSH2).toHaveBeenCalledTimes(2);
    expect(created).toHaveLength(2);
    b.end();
  });

  it("marks every lease dead when the SSH client closes", async () => {
    const a = acquireSSHSession(ssh);
    const b = acquireSSHSession(ssh);
    await Promise.all([a.init(), b.init()]);

    clientHandlers["close"]!();
    await vi.waitFor(() => expect(a.isAlive?.()).toBe(false));
    expect(b.isAlive?.()).toBe(false);
    expect(() => a.query("SELECT 1")).toThrow(/not available/);

    // A fresh lease gets a new session.
    const c = acquireSSHSession(ssh);
    await c.init();
    expect(mockConnectSSH2).toHaveBeenCalledTimes(2);
    expect(c.isAlive?.()).toBe(true);
    a.end();
    b.end();
    c.end();
  });

  it("reports not alive when the job has ended", async () => {
    const lease = acquireSSHSession(ssh);
    await lease.init();
    created[0]!.status = "ended";
    expect(lease.isAlive?.()).toBe(false);
    lease.end();
  });

  it("closes the SSH client and rejects when the job fails to connect", async () => {
    mockWithConfig.mockImplementationOnce(() => {
      const job = makeJob();
      job.connect.mockRejectedValue(new Error("jvm failed"));
      created.push(job);
      return job;
    });

    const lease = acquireSSHSession(ssh);
    await expect(lease.init()).rejects.toThrow("jvm failed");
    expect(mockClient.end).toHaveBeenCalled();

    // The failed session is discarded; the next lease starts over.
    const retry = acquireSSHSession(ssh);
    await retry.init();
    expect(retry.isAlive?.()).toBe(true);
    retry.end();
  });

  it("shares a single connect attempt between concurrent init() calls", async () => {
    let release!: () => void;
    mockConnectSSH2.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(mockClient);
        }),
    );
    const a = acquireSSHSession(ssh);
    const b = acquireSSHSession(ssh);
    const inits = Promise.all([a.init(), b.init()]);
    release();
    await inits;
    expect(mockConnectSSH2).toHaveBeenCalledTimes(1);
    a.end();
    b.end();
  });

  it("onQueryTimeout tears the session down and tells the caller to close its pool", async () => {
    const a = acquireSSHSession(ssh);
    const b = acquireSSHSession(ssh);
    await Promise.all([a.init(), b.init()]);

    expect(a.onQueryTimeout?.({})).toBe(false);
    await vi.waitFor(() => expect(created[0]!.close).toHaveBeenCalledTimes(1));
    expect(b.isAlive?.()).toBe(false);
    a.end();
    b.end();
  });

  it("does not share a session between different private keys", async () => {
    const a = acquireSSHSession(ssh);
    const b = acquireSSHSession({ ...ssh, privateKey: Buffer.from("other") });
    await Promise.all([a.init(), b.init()]);
    expect(mockConnectSSH2).toHaveBeenCalledTimes(2);
    a.end();
    b.end();
  });

  it("passes a host key verifier to ssh2 when a fingerprint is pinned", async () => {
    const hex = "ab".repeat(32);
    const lease = acquireSSHSession({ ...ssh, hostKeySha256: hex });
    await lease.init();
    const opts = mockConnectSSH2.mock.calls[0]![0];
    expect(opts.hostHash).toBe("sha256");
    expect(opts.hostVerifier(hex)).toBe(true);
    expect(opts.hostVerifier("cd".repeat(32))).toBe(false);
    lease.end();
  });

  it("enables SSH keepalive so a silently dropped connection is detected", async () => {
    const lease = acquireSSHSession(ssh);
    await lease.init();
    expect(mockConnectSSH2).toHaveBeenCalledWith(
      expect.objectContaining({
        keepaliveInterval: 15_000,
        keepaliveCountMax: 3,
      }),
    );
    lease.end();
  });

  it("ends the client when the session is closed while SSH is connecting", async () => {
    let resolveConnect!: (client: typeof mockClient) => void;
    mockConnectSSH2.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveConnect = resolve;
        }),
    );
    const lease = acquireSSHSession(ssh);
    const init = lease.init();
    await Promise.resolve();

    lease.end(); // last lease: the session closes while connectSSH2 is pending
    resolveConnect(mockClient);

    await expect(init).rejects.toThrow(/closed while it was connecting/);
    expect(mockClient.end).toHaveBeenCalledTimes(1);
    expect(mockWithConfig).not.toHaveBeenCalled();
  });

  it("closes the job when the session is closed while the job is connecting", async () => {
    let resolveJob!: () => void;
    mockWithConfig.mockImplementationOnce(() => {
      const job = makeJob();
      job.connect.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveJob = () => resolve({});
          }),
      );
      created.push(job);
      return job;
    });
    const lease = acquireSSHSession(ssh);
    const init = lease.init();
    await vi.waitFor(() => expect(created).toHaveLength(1));

    lease.end();
    resolveJob();

    await expect(init).rejects.toThrow(/closed while it was connecting/);
    expect(created[0]!.close).toHaveBeenCalledTimes(1);
    expect(mockClient.end).toHaveBeenCalledTimes(1);
  });

  it("does not set a host key verifier when no fingerprint is pinned", async () => {
    const lease = acquireSSHSession(ssh);
    await lease.init();
    const opts = mockConnectSSH2.mock.calls[0]![0];
    expect(opts.hostVerifier).toBeUndefined();
    lease.end();
  });
});

describe("hostKeyMatches", () => {
  const raw = Buffer.alloc(32, 7);
  const hex = raw.toString("hex");

  it("accepts hex, SHA256:base64 and unpadded OpenSSH form", () => {
    expect(hostKeyMatches(hex, hex)).toBe(true);
    expect(hostKeyMatches(hex, `SHA256:${raw.toString("base64")}`)).toBe(true);
    expect(
      hostKeyMatches(
        hex,
        `SHA256:${raw.toString("base64").replace(/=+$/, "")}`,
      ),
    ).toBe(true);
  });

  it("rejects a different key or a malformed fingerprint", () => {
    expect(hostKeyMatches(hex, "ab".repeat(32))).toBe(false);
    expect(hostKeyMatches(hex, "SHA256:nope")).toBe(false);
  });
});

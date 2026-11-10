/**
 * @fileoverview Connection pool lifecycle against mapepire's real Pool and
 * Query classes: sign-on back-off, idle close, timeouts, dropped connections
 * and query clean-up.
 *
 * Only the socket layer is faked: SQLJob.connect() and SQLJob.send() are
 * replaced, so nothing is opened, while job status and request counting,
 * query state and Pool.end() behave as they do in production.
 */

import type { EventEmitter } from "events";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import mapepire from "@ibm/mapepire-js";

// Must load first: AuthenticatedPoolManager imports logger from this barrel,
// which is circular with utils/internal (see jdbcOptions.test.ts).
import "../../../src/utils/index.js";
import { BaseConnectionPool } from "../../../src/ibmi-mcp-server/services/baseConnectionPool.js";
import { SourceManager } from "../../../src/ibmi-mcp-server/services/sourceManager.js";
import { AuthenticatedPoolManager } from "../../../src/ibmi-mcp-server/services/authenticatedPoolManager.js";
import { config } from "../../../src/config/index.js";
import {
  JsonRpcErrorCode,
  McpError,
} from "../../../src/types-global/errors.js";

const { Pool, SQLJob } = mapepire;
type Job = InstanceType<typeof SQLJob>;
type MapepirePool = InstanceType<typeof Pool>;

// ---------------------------------------------------------------------------
// Fake socket layer
// ---------------------------------------------------------------------------

interface JobRequest {
  id: string;
  type: string;
}

/** One sign-on attempt against IBM i; reject it to fail the connection */
const signOn = vi.fn<() => Promise<void>>();

/** The server's answer to a request; return a pending promise to hang it */
const reply = vi.fn<(request: JobRequest) => unknown>();

const defaultReply = (request: JobRequest) => ({
  id: request.id,
  success: true,
  has_results: true,
  is_done: true,
  data: [{ RESULT: 1 }],
});

/** Status a job has once its sign-on succeeded; "ended" drops it at once */
let statusAfterSignOn = "ready";

const setStatus = (job: Job, status: string) => {
  (job as unknown as { status: string }).status = status;
};

/** Runs right after a request is answered, before its caller continues */
let afterAnswer: (job: Job, request: JobRequest) => void;

const emitterOf = (job: Job) =>
  (job as unknown as { responseEmitter: EventEmitter }).responseEmitter;

const jobsOf = (pool: MapepirePool) =>
  (pool as unknown as { jobs: Job[] }).jobs;

/**
 * What mapepire does when a job's socket closes: the requests waiting on it
 * fail, and the job has ended.
 */
function dropConnection(job: Job) {
  const emitter = emitterOf(job);
  for (const event of emitter.eventNames()) {
    if (typeof event === "string" && event.endsWith("_conn_fail")) {
      emitter.emit(event, new Error("Connection failed with code 1006"));
    }
  }
  void job.close();
}

/** What a network reset or IPL does to a pool: every job's socket closes */
function dropConnections(pool: MapepirePool) {
  jobsOf(pool).forEach(dropConnection);
}

// mapepire does not export its Query class; reach the static list of every
// query it has created through an instance.
const probeQuery = new SQLJob().query("VALUES 1");
const queriesHeldByMapepire = () =>
  (
    probeQuery.constructor as unknown as { globalQueryList: unknown[] }
  ).globalQueryList.filter((query) => query !== probeQuery);

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

class TestSourceManager extends SourceManager {
  mapepirePool(sourceName: string): MapepirePool | null {
    return this.pools.get(sourceName)?.pool ?? null;
  }
}

const SOURCE = {
  host: "ibmi.example.test",
  user: "TESTUSER",
  password: "s3cret-pass",
  port: 8076,
};

const SIGN_ON_REJECTED =
  "java.sql.SQLNonTransientConnectionException: The application server rejected the connection. (Password is incorrect.:TESTUSER)";

const CONTEXT = {
  requestId: "pool-lifecycle-test",
  timestamp: new Date().toISOString(),
  operation: "Test",
} as never;

const ORIGINAL_IDLE_TIMEOUT = config.poolTimeouts.idleTimeoutMs;
const ORIGINAL_QUERY_TIMEOUT = config.poolTimeouts.queryTimeoutMs;

async function newSource(): Promise<TestSourceManager> {
  const sources = new TestSourceManager();
  await sources.registerSource("src", SOURCE, CONTEXT);
  return sources;
}

const run = (sources: SourceManager, sql = "SELECT 1") =>
  sources.executeQuery("src", sql, undefined, CONTEXT);

/** Resolves with the error a request is rejected with */
const failure = (request: Promise<unknown>) =>
  request.then(
    () => {
      throw new Error("expected the request to be rejected");
    },
    (error: McpError) => error,
  );

const pending = () => new Promise<never>(() => {});

/** Let everything that is already settled run */
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  config.poolTimeouts.queryTimeoutMs = 0;
  config.poolTimeouts.idleTimeoutMs = 0;

  statusAfterSignOn = "ready";
  afterAnswer = () => {};
  signOn.mockReset().mockResolvedValue(undefined);
  reply.mockReset().mockImplementation(defaultReply);

  vi.spyOn(SQLJob.prototype, "connect").mockImplementation(async function (
    this: Job,
  ) {
    setStatus(this, "connecting");
    await signOn();
    setStatus(this, statusAfterSignOn);
    return { success: true } as never;
  });
  // The real send() without the socket: the job is busy until its requests
  // are answered, and getRunningCount() counts their listeners. A request
  // sent on a closed socket is never answered, but marks the job busy too.
  vi.spyOn(SQLJob.prototype, "send").mockImplementation(function (
    this: Job,
    content,
  ) {
    const request = content as JobRequest;
    const emitter = emitterOf(this);
    const closed = this.getStatus() === "ended";
    return new Promise((resolve, reject) => {
      setStatus(this, "busy");
      const removeListeners = () => {
        emitter.removeAllListeners(request.id);
        emitter.removeAllListeners(`${request.id}_conn_fail`);
      };
      emitter.on(request.id, (answer: unknown) => {
        removeListeners();
        setStatus(this, this.getRunningCount() === 0 ? "ready" : "busy");
        resolve(answer);
      });
      emitter.on(`${request.id}_conn_fail`, (error: Error) => {
        removeListeners();
        reject(error);
      });
      if (!closed) {
        void Promise.resolve(reply(request)).then((answer) => {
          if (emitter.emit(request.id, answer)) {
            afterAnswer(this, request);
          }
        });
      }
    }) as never;
  });
});

afterEach(async () => {
  // The singleton outlives shutdownAll's registry, so stop it directly
  await AuthenticatedPoolManager.getInstance().shutdown();
  await BaseConnectionPool.shutdownAll();
  vi.restoreAllMocks();
  config.poolTimeouts.idleTimeoutMs = ORIGINAL_IDLE_TIMEOUT;
  config.poolTimeouts.queryTimeoutMs = ORIGINAL_QUERY_TIMEOUT;
  vi.useRealTimers();
});

// ═══════════════════════════════════════════════════════════════════════════
// Sign-on failure back-off
// ═══════════════════════════════════════════════════════════════════════════
describe("pool initialization – sign-on back-off", () => {
  it("opens one probe connection and the remaining ones only after it succeeds", async () => {
    let finishProbe!: () => void;
    signOn.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishProbe = resolve;
        }),
    );
    const sources = await newSource();

    const query = run(sources);
    await flush();
    expect(signOn).toHaveBeenCalledTimes(1);

    finishProbe();
    await query;
    expect(signOn).toHaveBeenCalledTimes(2);
    expect(sources.mapepirePool("src")!.getActiveJobCount()).toBe(2);
  });

  it("spends one sign-on on rejected credentials, then fails fast for 60 s", async () => {
    signOn.mockRejectedValue(new Error(SIGN_ON_REJECTED));
    const sources = await newSource();

    const first = await failure(run(sources));

    // The probe only, not one attempt per starting connection
    expect(signOn).toHaveBeenCalledTimes(1);
    expect(first.message).toMatch(/sign-on failed/i);
    expect(first.message).toMatch(/for 60 s\b/);
    const sentToClient = JSON.stringify([first.message, first.details]);
    for (const secret of [SOURCE.user, SOURCE.password, SOURCE.host]) {
      expect(sentToClient).not.toContain(secret);
    }

    // Every tool call during the cool-down is refused without a sign-on
    await vi.advanceTimersByTimeAsync(59_000);
    const second = await failure(run(sources));
    expect(second.message).toMatch(/sign-on failed/i);
    expect(second.message).toMatch(/for 1 s\b/);
    expect(signOn).toHaveBeenCalledTimes(1);

    // After it, the next call signs on again
    signOn.mockResolvedValue(undefined);
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await run(sources)).success).toBe(true);
    expect(signOn).toHaveBeenCalledTimes(3);
  });

  it("applies the cool-down to per-user pools, for the rejected credentials only", async () => {
    const credentials = {
      host: SOURCE.host,
      user: SOURCE.user,
      password: SOURCE.password,
      rejectUnauthorized: false,
    };
    const manager = AuthenticatedPoolManager.getInstance();
    signOn.mockRejectedValueOnce(new Error(SIGN_ON_REJECTED));

    await expect(
      manager.createPool("token-1", credentials, {}, CONTEXT),
    ).rejects.toThrow(/sign-on failed/i);
    // A second sign-on request with the same credentials gets a new token
    await expect(
      manager.createPool("token-2", credentials, {}, CONTEXT),
    ).rejects.toThrow(/sign-on failed/i);
    expect(signOn).toHaveBeenCalledTimes(1);

    // A corrected password is a different sign-on and is tried at once
    await manager.createPool(
      "token-3",
      { ...credentials, password: "corrected" },
      {},
      CONTEXT,
    );
    expect(signOn).toHaveBeenCalledTimes(3);
  });

  it("makes one sign-on for pools that try the same rejected credentials at the same time", async () => {
    signOn.mockRejectedValue(new Error(SIGN_ON_REJECTED));
    const sources = new TestSourceManager();
    // The same profile on the same system, however it is spelled
    await sources.registerSource("a", SOURCE, CONTEXT);
    await sources.registerSource(
      "b",
      { ...SOURCE, user: SOURCE.user.toLowerCase() },
      CONTEXT,
    );
    await sources.registerSource(
      "c",
      { ...SOURCE, host: SOURCE.host.toUpperCase() },
      CONTEXT,
    );

    const errors = await Promise.all(
      ["a", "b", "c"].map((name) =>
        failure(sources.executeQuery(name, "SELECT 1", undefined, CONTEXT)),
      ),
    );

    expect(signOn).toHaveBeenCalledTimes(1);
    for (const error of errors) {
      expect(error.message).toMatch(/sign-on failed/i);
    }
  });

  it("uses a 5 s cool-down for other failures and releases what did connect", async () => {
    const end = vi.spyOn(Pool.prototype, "end");
    // The probe connects, the second starting connection does not
    signOn
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
    const sources = await newSource();

    const first = await failure(run(sources));
    expect(first.message).toMatch(
      /could not be initialized: connect ECONNREFUSED\. Retry in 5 s\b/,
    );
    expect(signOn).toHaveBeenCalledTimes(2);
    expect(end).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4_000);
    const second = await failure(run(sources));
    expect(second.message).toMatch(/ECONNREFUSED\. Retry in 1 s\b/);
    expect(signOn).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1_000);
    expect((await run(sources)).success).toBe(true);
    expect(signOn).toHaveBeenCalledTimes(4);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Closed while connecting
// ═══════════════════════════════════════════════════════════════════════════
describe("pool initialization – closed while it is connecting", () => {
  /** Starts a statement whose pool initialization waits on the first sign-on */
  async function startConnecting() {
    let finishSignOn!: () => void;
    signOn.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishSignOn = resolve;
        }),
    );
    const sources = await newSource();
    const waiting = failure(run(sources));
    await flush();
    return { sources, waiting, finishSignOn };
  }

  it("ends the connections once they are open (shutdown, idle close)", async () => {
    const end = vi.spyOn(Pool.prototype, "end");
    const { sources, waiting, finishSignOn } = await startConnecting();

    await sources.closePool("src");
    finishSignOn();

    const error = await waiting;
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.message).toMatch(/closed while it was connecting/);
    expect(end).toHaveBeenCalledTimes(1);
    expect((end.mock.contexts[0] as MapepirePool).getActiveJobCount()).toBe(0);
    expect(sources.mapepirePool("src")).toBeNull();

    // Not remembered as a failure: the next request connects
    expect((await run(sources)).success).toBe(true);
  });

  it("gives a source whose settings changed its own initialization", async () => {
    const end = vi.spyOn(Pool.prototype, "end");
    const { sources, waiting, finishSignOn } = await startConnecting();

    // Hot reload: the source now points at another system
    await sources.registerSource(
      "src",
      { ...SOURCE, host: "other.example.test" },
      CONTEXT,
    );
    const afterReload = run(sources);
    await flush();
    finishSignOn();

    expect((await waiting).message).toMatch(/closed while it was connecting/);
    expect((await afterReload).success).toBe(true);
    // The pool of the old settings was ended, the new one is in use
    expect(end).toHaveBeenCalledTimes(1);
    expect(sources.mapepirePool("src")).not.toBe(end.mock.contexts[0]);
    expect(sources.mapepirePool("src")!.getActiveJobCount()).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Growth
// ═══════════════════════════════════════════════════════════════════════════
describe("pool growth – a sign-on like any other", () => {
  it("adds one connection at a time, survives a rejected one and backs off", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    const sources = await newSource();
    await run(sources);
    const pool = sources.mapepirePool("src")!;
    expect(signOn).toHaveBeenCalledTimes(2);

    // From now on statements hang and IBM i rejects the profile
    reply.mockImplementation(pending);
    signOn.mockRejectedValue(new Error(SIGN_ON_REJECTED));
    const overload = async (statements: number) => {
      for (let i = 0; i < statements; i++) {
        void run(sources, "CALL SLOW()").catch(() => {});
        await flush();
      }
    };

    // Two connections with three statements each, then four more
    await overload(10);

    // One attempt, not one per statement, and the failed job is not left
    // behind where it would count against the pool's size
    expect(signOn).toHaveBeenCalledTimes(3);
    expect(jobsOf(pool).map((job) => job.getStatus())).toEqual([
      "busy",
      "busy",
      "ended",
    ]);
    // The statements run on the connections there are
    expect(sources.mapepirePool("src")).toBe(pool);
    expect(
      jobsOf(pool).reduce((sum, job) => sum + job.getRunningCount(), 0),
    ).toBe(10);

    // No further attempt during the sign-on cool-down
    await vi.advanceTimersByTimeAsync(59_000);
    await overload(1);
    expect(signOn).toHaveBeenCalledTimes(3);

    // After it the pool grows again
    signOn.mockResolvedValue(undefined);
    await vi.advanceTimersByTimeAsync(1_000);
    await overload(1);
    expect(signOn).toHaveBeenCalledTimes(4);
    expect(pool.getActiveJobCount()).toBe(3);

    // Let Node report rejections nobody handled
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 20));
    process.off("unhandledRejection", onUnhandled);
    expect(unhandled).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Idle close
// ═══════════════════════════════════════════════════════════════════════════
describe("idle timer – never strands work", () => {
  beforeEach(() => {
    config.poolTimeouts.idleTimeoutMs = 20_000; // checked every 10 s
  });

  it("leaves a pool alone while a request is in flight", async () => {
    const sources = await newSource();
    await run(sources);

    let finish!: () => void;
    reply.mockImplementationOnce(
      (request) =>
        new Promise((resolve) => {
          finish = () => resolve(defaultReply(request));
        }),
    );
    const slow = run(sources, "CALL SLOW()");

    // Three times the idle timeout, and the statement is still running
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sources.mapepirePool("src")).not.toBeNull();

    finish();
    expect((await slow).success).toBe(true);

    // The end of the request is activity too: idle is counted from here
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sources.mapepirePool("src")).not.toBeNull();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sources.mapepirePool("src")).toBeNull();
  });

  it("counts a failed query as activity", async () => {
    const sources = await newSource();
    await run(sources);

    await vi.advanceTimersByTimeAsync(15_000);
    reply.mockImplementationOnce((request) => ({
      id: request.id,
      success: false,
      error: "[SQL0204] NOPE in QGPL type *FILE not found.",
      sql_state: "42704",
      sql_rc: -204,
    }));
    await expect(run(sources, "SELECT * FROM NOPE")).rejects.toThrow(/SQL0204/);

    // 30 s after the first query, 15 s after the failed one
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sources.mapepirePool("src")).not.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Timeouts and closing
// ═══════════════════════════════════════════════════════════════════════════
describe("query timeout – settles everything", () => {
  beforeEach(() => {
    config.poolTimeouts.queryTimeoutMs = 1_000;
  });

  it("times out a page of a paginated fetch and still closes the query", async () => {
    // The first page arrives, the next one never does
    reply.mockImplementation((request) =>
      request.type === "sqlmore"
        ? pending()
        : { ...defaultReply(request), is_done: false },
    );
    const sources = await newSource();

    const paged = failure(
      sources.executeQueryWithPagination(
        "src",
        "SELECT * FROM BIG",
        undefined,
        CONTEXT,
      ),
    );
    await vi.advanceTimersByTimeAsync(1_001);

    const error = await paged;
    expect(error.code).toBe(JsonRpcErrorCode.Timeout);
    expect(error.message).toMatch(/timed out after 1000ms/);
    expect(sources.mapepirePool("src")).toBeNull();

    await flush();
    expect(queriesHeldByMapepire()).toHaveLength(0);
  });

  it("rejects the other requests on the pool before recycling it", async () => {
    const end = vi.spyOn(Pool.prototype, "end");
    const sources = await newSource();
    await run(sources);

    reply.mockImplementationOnce(pending).mockImplementationOnce(pending);
    const first = failure(run(sources, "CALL HANGS()"));
    await vi.advanceTimersByTimeAsync(500);
    const second = failure(run(sources, "SELECT 2"));
    await vi.advanceTimersByTimeAsync(501);

    expect((await first).code).toBe(JsonRpcErrorCode.Timeout);
    // Settled now, 499 ms before its own timeout, not left pending on a
    // pool whose connections are gone
    const cancelled = await second;
    expect(cancelled.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(cancelled.message).toMatch(/cancelled.*timed out/i);
    // It was sent, so the client is not told to simply run it again
    expect(cancelled.message).toMatch(/may or may not have completed/);
    expect(cancelled.message).not.toMatch(/retry/i);
    expect(end).toHaveBeenCalledTimes(1);

    // The pool re-created for the next request is not touched by the timer
    // of the cancelled one
    expect((await run(sources, "SELECT 3")).success).toBe(true);
    const recreated = sources.mapepirePool("src");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sources.mapepirePool("src")).toBe(recreated);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("rejects requests in flight when their pool is closed", async () => {
    config.poolTimeouts.queryTimeoutMs = 0;
    const sources = await newSource();
    await run(sources);

    reply.mockImplementationOnce(pending);
    const running = failure(run(sources, "CALL LONG()"));
    await flush();
    await sources.closePool("src");

    const error = await running;
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.message).toMatch(/cancelled.*the pool was closed/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Dropped connections
// ═══════════════════════════════════════════════════════════════════════════
describe("dropped connections – recover once", () => {
  it("re-initializes the pool and runs the statement", async () => {
    const sources = await newSource();
    await run(sources);
    const dropped = sources.mapepirePool("src")!;
    dropConnections(dropped);
    // What mapepire does with such a pool
    expect(() => dropped.query("SELECT 1")).toThrow(TypeError);

    expect((await run(sources)).success).toBe(true);

    expect(sources.mapepirePool("src")).not.toBe(dropped);
    expect(signOn).toHaveBeenCalledTimes(4);
  });

  it("reports a connection error when the new pool has no connection either", async () => {
    const sources = await newSource();
    await run(sources);
    dropConnections(sources.mapepirePool("src")!);
    statusAfterSignOn = "ended";

    const error = await failure(run(sources));

    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.message).toMatch(/connection to IBM i was lost/i);
    // Re-initialized once, not in a loop
    expect(signOn).toHaveBeenCalledTimes(4);
    expect(sources.getHealthSummary().src?.healthStatus).toBe("unhealthy");
  });
});

describe("one dropped connection – fails its own statement only", () => {
  beforeEach(() => {
    config.poolTimeouts.queryTimeoutMs = 30_000;
  });

  /** A statement on the pool's other connection, answered by finish() */
  function slowStatement(sources: SourceManager) {
    let finish!: () => void;
    reply.mockImplementationOnce(
      (request) =>
        new Promise((resolve) => {
          finish = () => resolve(defaultReply(request));
        }),
    );
    return { result: run(sources, "CALL SLOW()"), finish: () => finish() };
  }

  it("while a page is being fetched: fails at once and sends nothing more on it", async () => {
    // The first page arrives, the next one never does
    reply.mockImplementation((request) =>
      request.type === "sqlmore"
        ? pending()
        : { ...defaultReply(request), is_done: false },
    );
    const sources = await newSource();
    let outcome: McpError | undefined;
    void failure(
      sources.executeQueryWithPagination(
        "src",
        "SELECT * FROM BIG",
        undefined,
        CONTEXT,
      ),
    ).then((error) => (outcome = error));
    await flush();
    const pool = sources.mapepirePool("src")!;
    const [fetching] = jobsOf(pool);
    const other = slowStatement(sources);
    await flush();

    dropConnection(fetching!);
    await flush();

    // Not after the query timeout that closing its cursor would run into
    expect(outcome?.message).toMatch(/Connection failed with code 1006/);
    // The dead connection is not left looking busy, which would send the
    // next statements to it
    expect(fetching!.getStatus()).toBe("ended");
    expect(pool.getActiveJobCount()).toBe(1);

    // The other statement is not cancelled and the pool is not recycled
    await vi.advanceTimersByTimeAsync(29_000);
    other.finish();
    expect((await other.result).success).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sources.mapepirePool("src")).toBe(pool);
    expect(queriesHeldByMapepire()).toHaveLength(0);
  });

  it("between two pages: fails the next page at once", async () => {
    config.poolTimeouts.queryTimeoutMs = 0;
    reply.mockImplementation((request) => ({
      ...defaultReply(request),
      is_done: false,
    }));
    // The socket closes when no request is waiting on it
    afterAnswer = (job) => dropConnection(job);
    const sources = await newSource();

    const error = await failure(
      sources.executeQueryWithPagination(
        "src",
        "SELECT * FROM BIG",
        undefined,
        CONTEXT,
      ),
    );

    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.message).toMatch(/connection to IBM i was lost/i);
    expect(reply).toHaveBeenCalledTimes(1);
    await flush();
    expect(queriesHeldByMapepire()).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Query clean-up
// ═══════════════════════════════════════════════════════════════════════════
describe("mapepire's global query list", () => {
  it("does not grow with the statements the server runs", async () => {
    const sources = await newSource();

    for (let i = 0; i < 20; i++) {
      await run(sources, `SELECT ${i} FROM SYSIBM.SYSDUMMY1`);
    }

    // Three pages
    reply
      .mockImplementationOnce((r) => ({ ...defaultReply(r), is_done: false }))
      .mockImplementationOnce((r) => ({ ...defaultReply(r), is_done: false }));
    const paged = await sources.executeQueryWithPagination(
      "src",
      "SELECT * FROM BIG",
      undefined,
      CONTEXT,
    );
    expect(paged.data).toHaveLength(3);

    reply.mockImplementationOnce((request) => ({
      id: request.id,
      success: false,
      error: "[SQL0204] NOPE in QGPL type *FILE not found.",
    }));
    await expect(run(sources, "SELECT * FROM NOPE")).rejects.toThrow(/SQL0204/);

    await flush();
    expect(queriesHeldByMapepire()).toHaveLength(0);
  });
});

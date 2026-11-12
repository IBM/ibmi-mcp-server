/**
 * @fileoverview One shared SSH session with ONE mapepire `SQLJob` per IBM i
 * target (used when `DB2i_TRANSPORT=ssh`).
 *
 * Starting an `ssh-single` job is expensive (SSH connect, JAR checks, JVM start
 * and JDBC connect: ~10s), so the job is created once and then reused by every
 * consumer: the built-in tools and every YAML source. Each `BaseConnectionPool`
 * entry gets a cheap {@link PoolLike} lease on the shared session; the session
 * is closed when the last lease ends.
 *
 * @module src/ibmi-mcp-server/services/sshSession
 */

import { createHash, timingSafeEqual } from "node:crypto";
import pkg from "@ibm/mapepire-js";
import type { JDBCOptions, QueryOptions } from "@ibm/mapepire-js";
import type { Client } from "ssh2";
import { logger } from "@/utils/internal/logger.js";
import {
  requestContextService,
  RequestContext,
} from "@/utils/internal/requestContext.js";
import { JsonRpcErrorCode, McpError } from "@/types-global/errors.js";
import type { PoolLike } from "./baseConnectionPool.js";

const { SQLJob, connectSSH2, createSSH2Connection } = pkg;
type SQLJobInstance = InstanceType<typeof SQLJob>;

/** SSH credentials + technique, as returned by `config.db2iSsh`. */
export interface SSHCredentials {
  host: string;
  port: number;
  username: string;
  privateKey?: Buffer;
  passphrase?: string;
  password?: string;
  /** Expected host key fingerprint (`SHA256:<base64>` or 64 hex chars). */
  hostKeySha256?: string;
  technique: "tcp" | "cli";
}

/**
 * Compare the SHA-256 host key hash reported by ssh2 (hex) with the configured
 * fingerprint, which may be OpenSSH style (`SHA256:<base64>`) or plain hex.
 */
export function hostKeyMatches(actualHex: string, expected: string): boolean {
  const value = expected.trim().replace(/^SHA256:/i, "");
  const actual = Buffer.from(actualHex, "hex");
  const wanted = /^[0-9a-f]{64}$/i.test(value)
    ? Buffer.from(value, "hex")
    : Buffer.from(value, "base64");
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

/** Interval between SSH keepalive probes on an idle connection. */
const SSH_KEEPALIVE_INTERVAL_MS = 15_000;
/** Unanswered keepalive probes after which ssh2 drops the connection. */
const SSH_KEEPALIVE_COUNT_MAX = 3;

function closedWhileConnecting(): McpError {
  return new McpError(
    JsonRpcErrorCode.DatabaseError,
    "IBM i SSH session was closed while it was connecting.",
    { reconnectOnNextCall: true },
  );
}

/** One SSH client + one SQL job, shared by all leases with the same key. */
class SSHSession {
  private client: Client | null = null;
  private job: SQLJobInstance | null = null;
  private connecting: Promise<void> | null = null;
  private alive = false;
  /** True once the session failed, was closed or lost; it is never reused. */
  private dead = false;
  private refs = 0;
  private readonly context: RequestContext;

  constructor(
    private readonly ssh: SSHCredentials,
    private readonly jdbcOptions: JDBCOptions | undefined,
    private readonly onDead: (session: SSHSession) => void,
  ) {
    this.context = requestContextService.createRequestContext({
      operation: "SSHSession",
      host: ssh.host,
    });
  }

  get isDead(): boolean {
    return this.dead;
  }

  retain(): void {
    this.refs++;
  }

  /** @returns true when the last lease was released. */
  release(): boolean {
    this.refs = Math.max(0, this.refs - 1);
    return this.refs === 0;
  }

  /** Connect once; concurrent callers share the same attempt. */
  ensureConnected(): Promise<void> {
    if (this.dead) {
      return Promise.reject(
        new McpError(
          JsonRpcErrorCode.DatabaseError,
          "IBM i SSH session is not available. It will be re-established on the next request.",
          { reconnectOnNextCall: true },
        ),
      );
    }
    if (this.alive) return Promise.resolve();
    this.connecting ??= this.connect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  isAlive(): boolean {
    return (
      this.alive &&
      !this.dead &&
      this.client !== null &&
      this.job !== null &&
      this.job.getStatus() !== "ended"
    );
  }

  query(sql: string, opts?: QueryOptions) {
    if (!this.isAlive() || !this.job) {
      throw new McpError(
        JsonRpcErrorCode.DatabaseError,
        "IBM i SSH session is not available. It will be re-established on the next request.",
        { reconnectOnNextCall: true },
      );
    }
    return this.job.query(sql, opts);
  }

  /** Close the job and the SSH client. Safe to call more than once. */
  async close(): Promise<void> {
    const job = this.job;
    const client = this.client;
    this.job = null;
    this.client = null;
    this.alive = false;
    if (!this.dead) {
      this.dead = true;
      this.onDead(this);
    }
    await job?.close().catch(() => undefined);
    try {
      client?.end();
    } catch {
      // ignore
    }
  }

  private async connect(): Promise<void> {
    const { ssh } = this;
    logger.info(
      {
        ...this.context,
        host: ssh.host,
        port: ssh.port,
        user: ssh.username.substring(0, 3) + "***",
        technique: ssh.technique,
        authMethod: ssh.privateKey ? "key" : "password",
      },
      "Opening IBM i SSH session",
    );

    if (!ssh.hostKeySha256) {
      logger.warning(
        this.context,
        "DB2i_SSH_HOST_KEY_SHA256 is not set: the IBM i SSH host key is NOT verified (vulnerable to man-in-the-middle). Set it to the fingerprint from `ssh-keygen -lf`.",
      );
    }

    try {
      const client = await connectSSH2({
        host: ssh.host,
        port: ssh.port,
        username: ssh.username,
        // ssh2 sends no keepalives by default, so a connection dropped
        // silently (firewall or NAT idle timeout) would still look alive and
        // the next query would hang until the query timeout. With these, ssh2
        // closes the socket after ~45s without a reply, which fires the
        // "close" handler below.
        keepaliveInterval: SSH_KEEPALIVE_INTERVAL_MS,
        keepaliveCountMax: SSH_KEEPALIVE_COUNT_MAX,
        ...(ssh.privateKey ? { privateKey: ssh.privateKey } : {}),
        ...(ssh.passphrase ? { passphrase: ssh.passphrase } : {}),
        ...(ssh.password && !ssh.privateKey ? { password: ssh.password } : {}),
        ...(ssh.hostKeySha256
          ? {
              hostHash: "sha256",
              hostVerifier: (hash: string) => {
                const ok = hostKeyMatches(hash, ssh.hostKeySha256 as string);
                if (!ok) {
                  logger.error(
                    this.context,
                    "IBM i SSH host key does not match DB2i_SSH_HOST_KEY_SHA256; refusing to connect",
                  );
                }
                return ok;
              },
            }
          : {}),
      });
      // The session may have been closed (last lease ended, shutdown) while
      // the SSH connection was being opened. close() could not see this
      // client yet, so it is ended here.
      if (this.dead) {
        client.end();
        throw closedWhileConnecting();
      }
      this.client = client;

      client.on("error", (err: Error) => {
        logger.warning(
          { ...this.context, error: err.message },
          "IBM i SSH client error",
        );
      });
      client.on("close", () => {
        if (this.client === client && !this.dead) {
          logger.warning(
            this.context,
            "IBM i SSH session closed; it will be re-created on next request",
          );
          void this.close();
        }
      });

      const job = SQLJob.withConfig(
        {
          transport: "ssh-single",
          sshSingleTechnique: ssh.technique,
          sshSingle: createSSH2Connection(client),
        },
        this.jdbcOptions,
      );
      await job.connect();
      // Same check for the job: close() already ended the client, but it
      // never saw this job.
      if (this.dead) {
        await job.close().catch(() => undefined);
        throw closedWhileConnecting();
      }
      this.job = job;
      this.alive = true;
      logger.info(this.context, "IBM i SSH session ready");
    } catch (error) {
      await this.close();
      throw error;
    }
  }
}

const sessions = new Map<string, SSHSession>();

function sessionKey(ssh: SSHCredentials, jdbcOptions?: JDBCOptions): string {
  return JSON.stringify([
    ssh.host,
    ssh.port,
    ssh.username,
    ssh.technique,
    credentialDigest(ssh),
    ssh.hostKeySha256 ?? null,
    jdbcOptions ?? null,
  ]);
}

/**
 * SHA-256 of the private key (or password), so sessions opened with different
 * credentials are never shared and no secret ends up in the map key.
 */
function credentialDigest(ssh: SSHCredentials): string {
  const secret = ssh.privateKey ?? ssh.password ?? "";
  const kind = ssh.privateKey ? "key" : "password";
  return `${kind}:${createHash("sha256").update(secret).digest("hex")}`;
}

/**
 * Lease on a shared {@link SSHSession}; what `BaseConnectionPool` holds in place
 * of mapepire's `Pool`.
 */
class SSHSessionLease implements PoolLike {
  private released = false;

  constructor(
    private readonly session: SSHSession,
    private readonly release: () => void,
  ) {}

  async init(): Promise<void> {
    try {
      await this.session.ensureConnected();
    } catch (error) {
      this.end();
      throw error;
    }
  }

  query(sql: string, opts?: QueryOptions) {
    return this.session.query(sql, opts);
  }

  isAlive(): boolean {
    return this.session.isAlive();
  }

  /**
   * A query timed out. The single job may be stuck, so the shared session is
   * torn down; every lease re-creates it on the next request.
   *
   * @returns `false`, so the caller also closes (releases) its own lease.
   */
  onQueryTimeout(): boolean {
    void this.session.close();
    return false;
  }

  end(): void {
    if (this.released) return;
    this.released = true;
    this.release();
  }
}

/**
 * Get a lease on the shared SSH session for these credentials, creating the
 * session if needed. The session connects on the first `init()` and is closed
 * when every lease has ended.
 */
export function acquireSSHSession(
  ssh: SSHCredentials,
  jdbcOptions?: JDBCOptions,
): PoolLike {
  const key = sessionKey(ssh, jdbcOptions);
  let session = sessions.get(key);
  if (!session || session.isDead) {
    const created: SSHSession = new SSHSession(ssh, jdbcOptions, (s) => {
      if (sessions.get(key) === s) sessions.delete(key);
    });
    sessions.set(key, created);
    session = created;
  }

  const target = session;
  target.retain();
  return new SSHSessionLease(target, () => {
    if (target.release()) void target.close();
  });
}

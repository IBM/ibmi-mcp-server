/**
 * Tests the repository's get-access-token.js script as a child process,
 * against a local HTTPS server with a self-signed certificate that stands in
 * for the MCP server. No IBM i system is involved.
 *
 * @module tests/ibmi-mcp-server/auth/getAccessTokenScript.test
 */

import { execFile, execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(
  new URL("../../../../../get-access-token.js", import.meta.url),
);
const hasOpenssl = spawnSync("openssl", ["version"]).status === 0;

let tmpDir: string;

/** Runs the script with no .env in reach and nothing inherited but PATH. */
function runScript(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT, ...args],
      { cwd: tmpDir, env: { PATH: process.env.PATH ?? "" } },
      (error, stdout, stderr) =>
        resolve({
          code: error ? ((error.code as number | undefined) ?? 1) : 0,
          stdout,
          stderr,
        }),
    );
  });
}

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "get-access-token-test-"));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("get-access-token.js usage", () => {
  it.each(["-h", "--help"])("prints usage for %s and exits 0", async (flag) => {
    const result = await runScript([flag]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage: node get-access-token.js");
    expect(result.stdout).toContain("--insecure");
    expect(result.stdout).toContain("-h, --help");
  });
});

describe.skipIf(!hasOpenssl)("get-access-token.js over HTTPS", () => {
  let server: Server;
  let serverArgs: string[];

  beforeAll(async () => {
    const keyFile = path.join(tmpDir, "tls-key.pem");
    const certFile = path.join(tmpDir, "tls-cert.pem");
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "2",
        "-subj",
        "/CN=localhost",
        "-keyout",
        keyFile,
        "-out",
        certFile,
      ],
      { stdio: "ignore" },
    );
    const { publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });

    server = createServer(
      { key: readFileSync(keyFile), cert: readFileSync(certFile) },
      (req, res) => {
        res.setHeader("content-type", "application/json");
        if (req.url === "/api/v1/auth/public-key") {
          res.end(JSON.stringify({ keyId: "test-key", publicKey }));
          return;
        }
        req.resume().on("end", () => {
          res.statusCode = 201;
          res.end(
            JSON.stringify({
              access_token: "test-token",
              token_type: "Bearer",
              expires_in: 3600,
              expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            }),
          );
        });
      },
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    serverArgs = [
      "--https",
      "--server",
      "127.0.0.1",
      "--port",
      String((server.address() as AddressInfo).port),
      "--user",
      "TESTUSER",
      "--password",
      "secret",
      "--host",
      "ibmi.example.com",
      "--quiet",
    ];
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("refuses a server whose certificate it cannot verify, and names --insecure", async () => {
    const result = await runScript(serverArgs);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("self-signed certificate");
    expect(result.stderr).toContain("rerun with --insecure");
  });

  it("skips certificate verification with --insecure", async () => {
    const result = await runScript([...serverArgs, "--insecure"]);

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(
      'export IBMI_MCP_ACCESS_TOKEN="test-token"',
    );
  });
});

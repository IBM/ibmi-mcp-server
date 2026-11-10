/**
 * Tests the process entry point (src/index.ts) by running it as a child
 * process: what reaches stdout and stderr, and how and with which code the
 * process exits. No IBM i system is involved; nothing here calls a tool.
 *
 * @module tests/entryPoint.test
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";

const SERVER_ROOT = fileURLToPath(new URL("..", import.meta.url));

let tmpRoot: string;
let logsDir: string;
let emptyEnvFile: string;
const children: ChildProcessWithoutNullStreams[] = [];

interface RunningEntry {
  child: ChildProcessWithoutNullStreams;
  stdout: () => string;
  stderr: () => string;
  /** Resolves with the exit code once the process has exited. */
  exited: Promise<number | null>;
}

/**
 * Starts the server entry. The child gets only the environment given here
 * (plus PATH), and an empty env file, so neither the developer's shell nor a
 * local .env can reach it.
 */
function startEntry(env: Record<string, string>): RunningEntry {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/index.ts", "--transport", "stdio"],
    {
      cwd: SERVER_ROOT,
      env: {
        PATH: process.env.PATH ?? "",
        // The default LOGS_DIR is under the home directory.
        HOME: tmpRoot,
        MCP_SERVER_CONFIG: emptyEnvFile,
        LOGS_DIR: logsDir,
        ...env,
      },
    },
  );
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  return {
    child,
    stdout: () => stdout,
    stderr: () => stderr,
    exited: new Promise((resolve) => child.once("exit", resolve)),
  };
}

/** Sends a JSON-RPC request and resolves with the response to it. */
async function request(
  entry: RunningEntry,
  id: number,
  method: string,
  params: Record<string, unknown> = {},
): Promise<{ result?: Record<string, unknown> }> {
  entry.child.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
  );
  return vi.waitFor(
    () => {
      const response = entry
        .stdout()
        .split("\n")
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as {
              id?: number;
              result?: Record<string, unknown>;
            },
        )
        .find((message) => message.id === id);
      expect(response).toBeDefined();
      return response!;
    },
    { timeout: 10_000, interval: 50 },
  );
}

const initialize = (entry: RunningEntry) =>
  request(entry, 1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "entry-point-test", version: "0.0.0" },
  });

const stderrLines = (entry: RunningEntry) =>
  entry.stderr().split("\n").filter(Boolean);

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "ibmi-mcp-entry-"));
  logsDir = join(tmpRoot, "logs");
  mkdirSync(logsDir);
  emptyEnvFile = join(tmpRoot, "empty.env");
  writeFileSync(emptyEnvFile, "");
});

afterEach(() => {
  children.splice(0).forEach((child) => child.kill("SIGKILL"));
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("server entry point over stdio", () => {
  it("serves MCP on stdout only, ignores MCP_SESSION_MODE with one warning, and exits 0 on SIGTERM", async () => {
    const entry = startEntry({
      IBMI_ENABLE_DEFAULT_TOOLS: "true",
      MCP_SESSION_MODE: "stateful",
    });

    await initialize(entry);
    const { result } = await request(entry, 2, "tools/list");
    const tools = result?.tools as Array<{ name: string }>;
    expect(tools.map((tool) => tool.name)).toContain("list_schemas");

    entry.child.kill("SIGTERM");
    expect(await entry.exited).toBe(0);

    // Every line on stdout is a JSON-RPC message.
    for (const line of entry.stdout().split("\n").filter(Boolean)) {
      expect(JSON.parse(line)).toMatchObject({ jsonrpc: "2.0" });
    }
    expect(stderrLines(entry)).toEqual([
      "Warning: MCP_SESSION_MODE is ignored; this server is stateless.",
    ]);
  });

  it("shuts down when the client closes stdin", async () => {
    const entry = startEntry({ IBMI_ENABLE_DEFAULT_TOOLS: "true" });
    await initialize(entry);

    entry.child.stdin.end();

    expect(await entry.exited).toBe(0);
    const logs = readdirSync(logsDir)
      .map((file) => readFileSync(join(logsDir, file), "utf-8"))
      .join("");
    expect(logs).toContain("Shutting down (stdin closed)");
  });
});

describe("server entry point start-up failures", () => {
  it("MCP_AUTH_MODE=jwt: exits 1 with one stderr line naming oauth, and nothing on stdout", async () => {
    const entry = startEntry({ MCP_AUTH_MODE: "jwt" });

    expect(await entry.exited).toBe(1);
    expect(stderrLines(entry)).toEqual([
      "@ibm/ibmi-mcp-server: Startup failed. MCP_AUTH_MODE=jwt is no longer supported. Use MCP_AUTH_MODE=oauth with MCP_RESOURCE_URL and OAUTH_ISSUER_URL.",
    ]);
    expect(entry.stdout()).toBe("");
  });

  it("an invalid environment variable: exits 1 instead of running on defaults", async () => {
    const entry = startEntry({ MCP_HTTP_PORT: "not-a-port" });

    expect(await entry.exited).toBe(1);
    expect(entry.stderr()).toContain("MCP_HTTP_PORT");
    expect(entry.stderr()).toContain(
      "Startup failed. Fix the invalid environment variables reported above.",
    );
    expect(entry.stdout()).toBe("");
  });

  // root can write anywhere, so the directory would not be read-only.
  it.skipIf(process.getuid?.() === 0)(
    "a LOGS_DIR that is not writable: exits 1 promptly, naming LOGS_DIR",
    async () => {
      const readOnlyDir = join(tmpRoot, "read-only-logs");
      mkdirSync(readOnlyDir);
      chmodSync(readOnlyDir, 0o555);

      const entry = startEntry({ LOGS_DIR: readOnlyDir });

      expect(await entry.exited).toBe(1);
      expect(entry.stderr()).toContain("LOGS_DIR must be a writable directory");
      expect(entry.stdout()).toBe("");
    },
  );
});

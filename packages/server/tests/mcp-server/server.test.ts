/**
 * Tests server start-up (initializeAndStartServer): what it refuses to start
 * with, and the HTTP server it starts. The HTTP cases talk to the real
 * listening server with the real SDK client, so the tool set comes from the
 * real factory.
 *
 * @module tests/mcp-server/server.test
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { connect as connectSocket, createServer } from "net";
import { tmpdir } from "os";
import { join } from "path";
import {
  Client,
  StreamableHTTPClientTransport,
  type ClientOptions,
} from "@modelcontextprotocol/client";
import { config } from "../../src/config/index.js";
import { ToolProcessor } from "../../src/ibmi-mcp-server/utils/config/toolProcessor.js";
import {
  initializeAndStartServer,
  type RunningServer,
} from "../../src/mcp-server/server.js";

const LEGACY: ClientOptions["versionNegotiation"] = { mode: "legacy" };
const MODERN: ClientOptions["versionNegotiation"] = {
  mode: { pin: "2026-07-28" },
};

const yaml = (tools: string[]) => `
sources:
  test-source:
    host: localhost
    user: tester
    password: not-a-real-password

tools:
${tools
  .map(
    (name) => `  ${name}:
    source: test-source
    description: "${name}"
    statement: "SELECT 1 FROM SYSIBM.SYSDUMMY1"`,
  )
  .join("\n")}
`;

/** A port nothing is listening on. */
const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

const saved = {
  mcpTransportType: config.mcpTransportType,
  mcpHttpPort: config.mcpHttpPort,
  mcpHttpHost: config.mcpHttpHost,
  mcpAuthMode: config.mcpAuthMode,
  rateLimitEnabled: config.rateLimit.enabled,
  toolsYamlPath: config.toolsYamlPath,
  selectedToolsets: config.selectedToolsets,
  yamlAutoReload: config.yamlAutoReload,
  ibmi_enableDefaultTools: config.ibmi_enableDefaultTools,
  ibmi_enableExecuteSql: config.ibmi_enableExecuteSql,
};

let tmpRoot: string;
let yamlPath: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "ibmi-mcp-server-test-"));
  yamlPath = join(tmpRoot, "tools.yaml");
});

beforeEach(async () => {
  writeFileSync(yamlPath, yaml(["tool_a"]));
  config.mcpTransportType = "http";
  config.mcpHttpPort = await freePort();
  config.mcpHttpHost = "127.0.0.1";
  config.mcpAuthMode = "none";
  config.rateLimit.enabled = false;
  config.toolsYamlPath = yamlPath;
  config.selectedToolsets = undefined;
  config.yamlAutoReload = true;
  config.ibmi_enableDefaultTools = true;
  config.ibmi_enableExecuteSql = false;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  ToolProcessor.clearWatchers();
  const { rateLimitEnabled, ...rest } = saved;
  Object.assign(config, rest);
  config.rateLimit.enabled = rateLimitEnabled;
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("initializeAndStartServer refuses to start", () => {
  it("with the retired jwt auth mode", async () => {
    config.mcpAuthMode = "jwt";
    await expect(initializeAndStartServer()).rejects.toThrow(
      /MCP_AUTH_MODE=jwt is no longer supported/,
    );
  });

  it("unauthenticated on a non-loopback address when IBM i credentials are configured", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    config.mcpHttpHost = "0.0.0.0";
    await expect(initializeAndStartServer()).rejects.toThrow(
      /Refusing to start/,
    );
  });

  it("when a server instance cannot be built: a YAML tool with the name of a built-in tool", async () => {
    writeFileSync(yamlPath, yaml(["list_schemas"]));
    await expect(initializeAndStartServer()).rejects.toThrow(
      /YAML tool 'list_schemas' has the same name as the built-in tool 'list_schemas'/,
    );
  });
});

describe("initializeAndStartServer over HTTP", () => {
  let running: RunningServer;
  /** The callback the server hands to the YAML file watcher. */
  let onFileChanged: (filePath: string, eventType: string) => unknown;
  const clients: Client[] = [];

  async function connect(
    versionNegotiation: ClientOptions["versionNegotiation"],
  ): Promise<Client> {
    const client = new Client(
      { name: "server-test-client", version: "0.0.0" },
      { versionNegotiation },
    );
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${config.mcpHttpPort}/mcp`),
      ),
    );
    clients.push(client);
    return client;
  }

  beforeEach(async () => {
    vi.spyOn(ToolProcessor, "registerChangeCallback").mockImplementation(
      (callback) => {
        onFileChanged = callback;
        return "captured";
      },
    );
    running = await initializeAndStartServer();
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
    await running.close();
  });

  it.each([
    ["2025 initialize handshake", LEGACY],
    ["pinned 2026-07-28", MODERN],
  ])("serves the built-in and YAML tools (%s)", async (_era, negotiation) => {
    const client = await connect(negotiation);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("list_schemas");
    expect(names).toContain("tool_a");
  });

  it("promises list-changed notifications only to clients it can deliver them to", async () => {
    // A 2025-era request has no stream a notification could arrive on.
    const legacy = (await connect(LEGACY)).getServerCapabilities();
    expect(legacy?.tools?.listChanged).toBe(false);
    expect(legacy?.resources?.listChanged).toBe(false);

    const modern = (await connect(MODERN)).getServerCapabilities();
    expect(modern?.tools?.listChanged).toBe(true);
    expect(modern?.resources?.listChanged).toBe(true);
  });

  it("tells a listening client when the YAML tools were reloaded", async () => {
    const client = await connect(MODERN);
    const toolsChanged = vi.fn();
    client.setNotificationHandler(
      "notifications/tools/list_changed",
      toolsChanged,
    );
    await client.listen({ toolsListChanged: true });

    writeFileSync(yamlPath, yaml(["tool_a", "tool_b"]));
    await onFileChanged(yamlPath, "change");

    await vi.waitFor(() => expect(toolsChanged).toHaveBeenCalled());
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("tool_b");
  });

  it("closes although a connection that never sent a request is still open", async () => {
    const idle = connectSocket(config.mcpHttpPort, "127.0.0.1");
    idle.on("error", () => {}); // the server resets it
    await new Promise((resolve) => idle.once("connect", resolve));
    const idleClosed = new Promise((resolve) => idle.once("close", resolve));

    // The grace period for in-flight requests, without waiting for it.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const closing = running.close();
    running = { close: async () => {} };
    await vi.advanceTimersByTimeAsync(5000);

    await closing;
    await idleClosed;
  });
});

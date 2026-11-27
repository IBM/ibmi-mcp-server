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
import { JsonRpcErrorCode } from "../../src/types-global/errors.js";
import {
  startFakeMapepire,
  type FakeMapepire,
} from "../ibmi-mcp-server/oauth/fakeMapepire.js";

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

describe("initializeAndStartServer with the built-in IBM i sign-on (MCP_AUTH_MODE=oauth without OAUTH_ISSUER_URL)", () => {
  const savedSignOn = {
    mcpResourceUrl: config.mcpResourceUrl,
    oauthIssuerUrl: config.oauthIssuerUrl,
    mapepire: { ...config.oauth.mapepire },
    ibmiHttpAuthEnabled: config.ibmiHttpAuth.enabled,
    env: {
      DB2i_PASS: process.env.DB2i_PASS,
      DB2i_IGNORE_UNAUTHORIZED: process.env.DB2i_IGNORE_UNAUTHORIZED,
      DB2i_JDBC_OPTIONS: process.env.DB2i_JDBC_OPTIONS,
    },
  };
  let fake: FakeMapepire;

  beforeEach(async () => {
    fake = await startFakeMapepire();
    const pinFile = join(tmpRoot, "mapepire-pin.pem");
    writeFileSync(pinFile, fake.certPem);
    config.mcpAuthMode = "oauth";
    config.oauthIssuerUrl = undefined;
    config.mcpResourceUrl = `http://127.0.0.1:${config.mcpHttpPort}/mcp`;
    config.ibmiHttpAuth.enabled = false;
    Object.assign(config.oauth.mapepire, {
      host: "127.0.0.1",
      port: fake.port,
      serverCertFile: pinFile,
      caFile: undefined,
    });
    // The tool file of this suite names another host than DB2i_HOST.
    config.toolsYamlPath = undefined;
    for (const name of Object.keys(savedSignOn.env)) {
      delete process.env[name];
    }
  });

  afterEach(async () => {
    await fake.stop();
    config.mcpResourceUrl = savedSignOn.mcpResourceUrl;
    config.oauthIssuerUrl = savedSignOn.oauthIssuerUrl;
    config.ibmiHttpAuth.enabled = savedSignOn.ibmiHttpAuthEnabled;
    Object.assign(config.oauth.mapepire, savedSignOn.mapepire);
    for (const [name, value] of Object.entries(savedSignOn.env)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  it("starts over HTTP without contacting Mapepire, and /healthz counts sign-ons", async () => {
    const running = await initializeAndStartServer();
    try {
      const health = await fetch(
        `http://127.0.0.1:${config.mcpHttpPort}/healthz`,
      );
      expect(await health.json()).toMatchObject({
        status: "ok",
        signOn: { grants: 0, openConnections: 0 },
      });
      expect(fake.httpRequests).toBe(0);
      expect(fake.upgrades).toBe(0);
    } finally {
      await running.close();
    }
  });

  it("refuses the stdio transport", async () => {
    config.mcpTransportType = "stdio";
    await expect(initializeAndStartServer()).rejects.toMatchObject({
      code: JsonRpcErrorCode.ConfigurationError,
      message:
        "MCP_AUTH_MODE=oauth without OAUTH_ISSUER_URL (users sign on with their IBM i profile) needs the HTTP transport: set MCP_TRANSPORT_TYPE=http.",
    });
  });

  it("refuses a service password, before it loads any tool file", async () => {
    process.env.DB2i_PASS = "dummy-service-Pw";
    config.toolsYamlPath = join(tmpRoot, "no-such-tools.yaml");
    await expect(initializeAndStartServer()).rejects.toThrow(
      /^DB2i_PASS must not be set when users sign on with their IBM i profile/,
    );
  });

  it("refuses DB2i_IGNORE_UNAUTHORIZED=true together with a certificate file", async () => {
    process.env.DB2i_IGNORE_UNAUTHORIZED = "true";
    await expect(initializeAndStartServer()).rejects.toMatchObject({
      code: JsonRpcErrorCode.ConfigurationError,
      message: expect.stringMatching(
        /^DB2i_IGNORE_UNAUTHORIZED=true and DB2i_SERVER_CERT_FILE contradict each other/,
      ),
    });
  });

  it("starts with DB2i_IGNORE_UNAUTHORIZED=true and no certificate file", async () => {
    process.env.DB2i_IGNORE_UNAUTHORIZED = "true";
    config.oauth.mapepire.serverCertFile = undefined;
    const running = await initializeAndStartServer();
    await running.close();
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

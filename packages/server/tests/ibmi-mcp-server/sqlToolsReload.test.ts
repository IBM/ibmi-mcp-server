/**
 * @fileoverview Tests the YAML tool lifecycle: loaded once at startup,
 * served from the cache to every server instance, and swapped on reload.
 *
 * Reloads are run by calling the change callback the server registers with
 * the file watcher; the watcher itself is covered by toolProcessor.test.ts.
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
import { tmpdir } from "os";
import { join } from "path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { config } from "../../src/config/index.js";
import {
  loadSQLTools,
  onSQLToolsReloaded,
} from "../../src/ibmi-mcp-server/index.js";
import { SourceManager } from "../../src/ibmi-mcp-server/services/sourceManager.js";
import { SQLToolFactory } from "../../src/ibmi-mcp-server/utils/config/toolFactory.js";
import { ToolsetManager } from "../../src/ibmi-mcp-server/utils/config/toolsetManager.js";
import { ToolProcessor } from "../../src/ibmi-mcp-server/utils/config/toolProcessor.js";
import { createMcpServerInstance } from "../../src/mcp-server/server.js";
import { logger } from "../../src/utils/internal/logger.js";

const yaml = (tools: string[], toolsets: Record<string, string[]>) => `
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

toolsets:
${Object.entries(toolsets)
  .map(([name, members]) => `  ${name}:\n    tools: [${members.join(", ")}]`)
  .join("\n")}
`;

const BASELINE = yaml(["tool_a"], { alpha: ["tool_a"] });

/** Connects a client to a server instance over an in-memory transport. */
async function connect(followReloads: boolean): Promise<Client> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = await createMcpServerInstance(followReloads);
  await server.connect(serverTransport);
  const client = new Client({ name: "reload-test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

const toolNames = async (client: Client) =>
  (await client.listTools()).tools.map((tool) => tool.name).sort();
const resourceUris = async (client: Client) =>
  (await client.listResources()).resources.map((r) => r.uri).sort();

describe("YAML tools load and reload", () => {
  const original = {
    toolsYamlPath: config.toolsYamlPath,
    selectedToolsets: config.selectedToolsets,
    yamlAutoReload: config.yamlAutoReload,
    ibmi_enableDefaultTools: config.ibmi_enableDefaultTools,
    ibmi_enableExecuteSql: config.ibmi_enableExecuteSql,
  };
  let tmpRoot: string;
  let yamlPath: string;
  /** The callback loadSQLTools hands to the file watcher. */
  let onFilesChanged: () => unknown;
  const reloaded = vi.fn();
  let stopListening: () => void;

  /** Saves the YAML file and runs the reload a file change triggers. */
  async function saveAndReload(content: string): Promise<void> {
    writeFileSync(yamlPath, content);
    await onFilesChanged();
  }

  beforeAll(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "ibmi-mcp-reload-"));
    yamlPath = join(tmpRoot, "tools.yaml");
    writeFileSync(yamlPath, BASELINE);

    config.toolsYamlPath = yamlPath;
    config.selectedToolsets = undefined;
    config.yamlAutoReload = true;
    config.ibmi_enableDefaultTools = false;
    config.ibmi_enableExecuteSql = false;

    const register = vi
      .spyOn(ToolProcessor, "registerChangeCallback")
      .mockImplementation((callback) => {
        onFilesChanged = callback;
        return "captured";
      });
    await loadSQLTools();
    register.mockRestore();
    stopListening = onSQLToolsReloaded(reloaded);
  });

  // Every test starts from the baseline, whatever ran before it.
  beforeEach(async () => {
    await saveAndReload(BASELINE);
    reloaded.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => {
    stopListening();
    ToolProcessor.clearWatchers();
    Object.assign(config, original);
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("serves the loaded tools and one resource per toolset from the first instance", async () => {
    const client = await connect(false);

    expect(await toolNames(client)).toEqual(["describe_sql_object", "tool_a"]);
    expect(await resourceUris(client)).toEqual([
      "toolsets://",
      "toolsets://alpha",
    ]);
    await client.close();
  });

  it("does not read the YAML file when building an instance", async () => {
    // A broken file on disk would fail a re-parse; the cache keeps serving.
    const cached = vi.spyOn(ToolProcessor.prototype, "initialize");

    const client = await connect(false);

    expect(await toolNames(client)).toContain("tool_a");
    expect(cached).not.toHaveBeenCalled();
    await client.close();
  });

  it("drops arguments a YAML tool does not declare, and does not advertise them as forbidden", async () => {
    const execute = vi
      .spyOn(SQLToolFactory, "executeStatementWithParameters")
      .mockResolvedValue({ data: [], rowCount: 0, executionTime: 0 });
    const client = await connect(false);

    const { tools } = await client.listTools();
    const toolA = tools.find((tool) => tool.name === "tool_a");
    expect(toolA?.inputSchema.additionalProperties).toBeUndefined();

    const result = await client.callTool({
      name: "tool_a",
      arguments: { bogus: 1 },
    });
    expect(result.isError).toBeFalsy();
    expect(execute.mock.calls[0]?.[3]).toEqual({});
    await client.close();
  });

  it("after a reload, new instances and connected long-lived instances have the new tools", async () => {
    const live = await connect(true);
    const toolsChanged = vi.fn();
    const resourcesChanged = vi.fn();
    live.setNotificationHandler(
      "notifications/tools/list_changed",
      toolsChanged,
    );
    live.setNotificationHandler(
      "notifications/resources/list_changed",
      resourcesChanged,
    );

    await saveAndReload(
      yaml(["tool_a", "tool_b"], { alpha: ["tool_a"], beta: ["tool_b"] }),
    );
    expect(reloaded).toHaveBeenCalledExactlyOnceWith({
      resourcesChanged: true,
    });

    // The connected instance (stdio) was told once and now lists the new set.
    await vi.waitFor(() => {
      expect(toolsChanged).toHaveBeenCalledTimes(1);
      expect(resourcesChanged).toHaveBeenCalledTimes(1);
    });
    expect(await toolNames(live)).toEqual([
      "describe_sql_object",
      "tool_a",
      "tool_b",
    ]);
    expect(await resourceUris(live)).toEqual([
      "toolsets://",
      "toolsets://alpha",
      "toolsets://beta",
    ]);

    // A fresh instance (the next HTTP request) sees it too.
    const fresh = await connect(false);
    expect(await toolNames(fresh)).toEqual([
      "describe_sql_object",
      "tool_a",
      "tool_b",
    ]);

    await fresh.close();
    await live.close();
  });

  it("reports unchanged toolset resources when only tools changed", async () => {
    await saveAndReload(yaml(["tool_a", "tool_b"], { alpha: ["tool_a"] }));

    expect(reloaded).toHaveBeenCalledExactlyOnceWith({
      resourcesChanged: false,
    });
  });

  it("logs every reload under a request context of its own", async () => {
    const info = vi.spyOn(logger, "info");

    await saveAndReload(yaml(["tool_a", "tool_b"], { alpha: ["tool_a"] }));
    await saveAndReload(BASELINE);

    const requestIds = info.mock.calls
      .filter(([, message]) => String(message).includes("rebuilding tools"))
      .map(([context]) => (context as { requestId: string }).requestId);
    expect(requestIds).toHaveLength(2);
    expect(new Set(requestIds).size).toBe(2);
  });

  it("keeps the previous tools when the reloaded file is invalid", async () => {
    const error = vi.spyOn(logger, "error");

    await saveAndReload("tools: [this is not a tool map\n");

    expect(error).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("Error during auto-reload"),
    );
    expect(reloaded).not.toHaveBeenCalled();
    const client = await connect(false);
    expect(await toolNames(client)).toEqual(["describe_sql_object", "tool_a"]);
    await client.close();
  });

  // Problems that only show after the file has parsed: the cached tools must
  // not end up running against the rejected file's sources and toolsets.
  it.each([
    [
      "a toolset names a tool that does not exist",
      (movedHost: string) =>
        movedHost.replace("tools: [tool_a]", "tools: [tool_typo]"),
    ],
    [
      "a parameter pattern is not a regular expression",
      (movedHost: string) =>
        movedHost.replace(
          'statement: "SELECT 1 FROM SYSIBM.SYSDUMMY1"',
          `statement: "SELECT 1 FROM SYSIBM.SYSDUMMY1 WHERE 'A' = :name"
    parameters:
      - name: name
        type: string
        pattern: "("`,
        ),
    ],
  ])(
    "leaves sources and toolsets as they were when %s",
    async (_problem, breakIt) => {
      const error = vi.spyOn(logger, "error");
      const registerSource = vi.spyOn(
        SourceManager.prototype,
        "registerSource",
      );
      const movedHost = BASELINE.replace(
        "host: localhost",
        "host: other.example.test",
      ).replace("alpha:", "beta:");

      await saveAndReload(breakIt(movedHost));

      expect(error).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining("Error during auto-reload"),
      );
      expect(registerSource).not.toHaveBeenCalled();
      expect(ToolsetManager.getInstance().getAllToolsetNames()).toEqual([
        "alpha",
      ]);
      expect(reloaded).not.toHaveBeenCalled();
    },
  );
});

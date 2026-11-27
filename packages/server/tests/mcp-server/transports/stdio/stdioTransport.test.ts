/**
 * Tests stdio serving of the real server factory.
 *
 * `serveStdio` is given an in-memory transport in place of the process's
 * stdin/stdout, and a real SDK client talks to it over the linked end. The
 * server instances come from createMcpServerInstance, the factory the
 * running server uses, so the tool and resource sets are the real ones.
 *
 * @module tests/mcp-server/transports/stdio/stdioTransport.test
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  Client,
  InMemoryTransport,
  type ClientOptions,
} from "@modelcontextprotocol/client";
import {
  serveStdio,
  type StdioServerHandle,
} from "@modelcontextprotocol/server/stdio";
import { config } from "../../../../src/config/index.js";
import { createMcpServerInstance } from "../../../../src/mcp-server/server.js";

const ERAS: Array<[string, ClientOptions["versionNegotiation"]]> = [
  ["2025 initialize handshake", { mode: "legacy" }],
  ["pinned 2026-07-28", { mode: { pin: "2026-07-28" } }],
];

const saved = {
  toolsYamlPath: config.toolsYamlPath,
  ibmi_enableDefaultTools: config.ibmi_enableDefaultTools,
  ibmi_enableExecuteSql: config.ibmi_enableExecuteSql,
};

describe.each(ERAS)("stdio serving (%s)", (_era, versionNegotiation) => {
  let client: Client;
  let handle: StdioServerHandle;

  beforeEach(async () => {
    config.toolsYamlPath = undefined;
    config.ibmi_enableDefaultTools = true;
    config.ibmi_enableExecuteSql = false;

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    handle = serveStdio(() => createMcpServerInstance(true), {
      transport: serverTransport,
    });
    client = new Client(
      { name: "stdio-test-client", version: "0.0.0" },
      { versionNegotiation },
    );
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await handle.close();
    Object.assign(config, saved);
  });

  it("lists the built-in tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "describe_sql_object",
      "execute_sql",
      "get_related_objects",
      "get_table_columns",
      "list_schemas",
      "list_tables_in_schema",
      "validate_query",
    ]);
  });

  it("advertises JSON Schema 2020-12 object schemas", async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.$schema).toBe(
        "https://json-schema.org/draft/2020-12/schema",
      );
    }
  });

  it("lists the toolsets catalog resource", async () => {
    const { resources } = await client.listResources();
    expect(resources.map((resource) => resource.uri)).toEqual(["toolsets://"]);
  });

  it("answers a tool call with invalid arguments with an error result", async () => {
    // Fails input validation, so the tool (and any IBM i connection) never runs.
    const result = await client.callTool({
      name: "get_table_columns",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      {
        type: "text",
        text: expect.stringContaining("Input validation error"),
      },
    ]);
  });
});

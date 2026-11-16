/**
 * @fileoverview The repository's own tools/ directory must load with the
 * default settings, and next to the built-in tools.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "url";

import { config } from "../../../../src/config/index.js";
import { getAllToolDefinitions } from "../../../../src/ibmi-mcp-server/tools/index.js";
import { ToolConfigBuilder } from "../../../../src/ibmi-mcp-server/utils/config/toolConfigBuilder.js";

const TOOLS_DIR = fileURLToPath(
  new URL("../../../../../../tools", import.meta.url),
);
const CREDENTIALS = ["DB2i_HOST", "DB2i_USER", "DB2i_PASS"];

describe("the shipped tools/ directory", () => {
  const original = {
    mergeOptions: { ...config.yamlMergeOptions },
    enableDefaultTools: config.ibmi_enableDefaultTools,
    env: Object.fromEntries(
      CREDENTIALS.map((name) => [name, process.env[name]]),
    ),
  };

  beforeAll(() => {
    // The documented defaults, whatever a local .env says.
    Object.assign(config.yamlMergeOptions, {
      mergeArrays: true,
      allowDuplicateTools: false,
      allowDuplicateSources: false,
      validateMerged: true,
    });
    for (const name of CREDENTIALS) {
      process.env[name] = `test-${name}`;
    }
  });

  afterAll(() => {
    Object.assign(config.yamlMergeOptions, original.mergeOptions);
    config.ibmi_enableDefaultTools = original.enableDefaultTools;
    for (const name of CREDENTIALS) {
      if (original.env[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = original.env[name];
      }
    }
  });

  it("loads as a whole with the default settings", async () => {
    const { config: merged, resolvedFilePaths } =
      await ToolConfigBuilder.fromPath(TOOLS_DIR);

    expect(resolvedFilePaths.length).toBeGreaterThan(1);
    expect(Object.keys(merged.toolsets ?? {})).toEqual(
      expect.arrayContaining(["performance", "text2sql", "developer_tools"]),
    );
  });

  it("defines no tool with the name of a built-in tool", async () => {
    config.ibmi_enableDefaultTools = true;
    const builtinNames = getAllToolDefinitions().map((tool) => tool.name);

    const { config: merged } = await ToolConfigBuilder.fromPath(TOOLS_DIR);

    expect(
      Object.keys(merged.tools ?? {}).filter((name) =>
        builtinNames.includes(name),
      ),
    ).toEqual([]);
  });
});

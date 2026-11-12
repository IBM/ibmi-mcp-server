/**
 * @fileoverview Load-failure and multi-file merge tests for ToolConfigBuilder.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

import { config } from "../../../../src/config/index.js";
import { ToolConfigBuilder } from "../../../../src/ibmi-mcp-server/utils/config/toolConfigBuilder.js";

const source = (host: string) => `
sources:
  shared:
    host: ${host}
    user: tester
    password: not-a-real-password
`;

const tool = (name: string) => `
tools:
  ${name}:
    source: shared
    description: "${name}"
    statement: "SELECT 1 FROM SYSIBM.SYSDUMMY1"
`;

describe("ToolConfigBuilder loading", () => {
  const originalMergeOptions = { ...config.yamlMergeOptions };
  let tmpRoot: string;
  let dirCount = 0;

  /** Writes the files into a new directory and returns its path. */
  function toolsDir(files: Record<string, string>): string {
    const dir = join(tmpRoot, `tools-${dirCount++}`);
    mkdirSync(dir);
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content);
    }
    return dir;
  }

  const loadError = (toolsPath: string): Promise<string> =>
    ToolConfigBuilder.fromPath(toolsPath).then(
      () => "",
      (error: Error) => error.message,
    );

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "ibmi-mcp-load-"));
    // The documented defaults, whatever a local .env says.
    Object.assign(config.yamlMergeOptions, {
      mergeArrays: true,
      allowDuplicateTools: false,
      allowDuplicateSources: false,
      validateMerged: true,
    });
  });

  afterEach(() => {
    config.yamlMergeOptions.allowDuplicateSources = false;
  });

  afterAll(() => {
    Object.assign(config.yamlMergeOptions, originalMergeOptions);
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  describe("invalid files", () => {
    it("reports the file and its validation errors", async () => {
      const filePath = resolve(
        process.cwd(),
        "tests/fixtures/invalid/missing-required-fields.yaml",
      );

      const message = await loadError(filePath);

      expect(message).toContain(`Invalid tool configuration in ${filePath}`);
      expect(message).toContain("sources.invalid-source.password");
    });

    it("fails the whole load when one file of a directory is invalid", async () => {
      const dir = toolsDir({
        "a.yaml": source("localhost") + tool("tool_a"),
        "b.yaml": "tools: [this is not a tool map\n",
        "c.yaml": tool("tool_c"),
      });

      expect(await loadError(dir)).toContain(
        `Invalid tool configuration in ${join(dir, "b.yaml")}`,
      );
    });
  });

  describe("a source defined in more than one file", () => {
    it("merges silently when the definitions are the same", async () => {
      const dir = toolsDir({
        "a.yaml": source("localhost") + tool("tool_a"),
        "b.yaml": source("localhost") + tool("tool_b"),
      });

      const { config: merged } = await ToolConfigBuilder.fromPath(dir);

      expect(Object.keys(merged.sources ?? {})).toEqual(["shared"]);
      expect(Object.keys(merged.tools ?? {})).toEqual(["tool_a", "tool_b"]);
    });

    it("treats a default that is written out like one that is left out", async () => {
      const dir = toolsDir({
        "a.yaml": source("localhost") + tool("tool_a"),
        "b.yaml":
          source("localhost") +
          "    port: 8076\n    ignore-unauthorized: true\n" +
          tool("tool_b"),
      });

      const { config: merged } = await ToolConfigBuilder.fromPath(dir);

      expect(Object.keys(merged.tools ?? {})).toEqual(["tool_a", "tool_b"]);
    });

    it("is an error naming both files when the definitions differ", async () => {
      const dir = toolsDir({
        "a.yaml": source("host-a") + tool("tool_a"),
        "b.yaml": source("host-b") + tool("tool_b"),
      });

      const message = await loadError(dir);

      expect(message).toContain(
        `Source 'shared' is defined differently in ${join(dir, "a.yaml")} and ${join(dir, "b.yaml")}`,
      );
      expect(message).toContain("YAML_ALLOW_DUPLICATE_SOURCES=true");
    });

    it("lets the last file in sorted order win with YAML_ALLOW_DUPLICATE_SOURCES", async () => {
      config.yamlMergeOptions.allowDuplicateSources = true;
      const dir = toolsDir({
        "b.yaml": source("host-b") + tool("tool_b"),
        "a.yaml": source("host-a") + tool("tool_a"),
        "c.yaml": source("host-c") + tool("tool_c"),
      });

      const { config: merged } = await ToolConfigBuilder.fromPath(dir);

      expect(merged.sources?.shared?.host).toBe("host-c");
    });
  });
});

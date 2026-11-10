/**
 * @fileoverview Tests for ToolProcessor: which YAML tools get processed, and
 * the file watcher that drives auto-reload.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
  vi,
} from "vitest";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { setTimeout as sleep } from "timers/promises";
import { config } from "../../../../src/config/index.js";
import { ToolProcessor } from "../../../../src/ibmi-mcp-server/utils/config/toolProcessor.js";
import { logger } from "../../../../src/utils/internal/logger.js";

const TOOLS_YAML = `
sources:
  test-source:
    host: localhost
    user: tester
    password: not-a-real-password

tools:
  enabled_tool:
    source: test-source
    description: "Enabled by default"
    statement: "SELECT 1 FROM SYSIBM.SYSDUMMY1"

  disabled_tool:
    enabled: false
    source: test-source
    description: "Disabled, still listed in a toolset"
    statement: "SELECT 2 FROM SYSIBM.SYSDUMMY1"

toolsets:
  sample:
    tools:
      - enabled_tool
      - disabled_tool
`;

describe("ToolProcessor", () => {
  const original = {
    toolsYamlPath: config.toolsYamlPath,
    selectedToolsets: config.selectedToolsets,
    yamlAutoReload: config.yamlAutoReload,
  };
  let tmpRoot: string;

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "ibmi-mcp-tool-processor-"));
  });

  afterEach(() => {
    ToolProcessor.clearWatchers();
    Object.assign(config, original);
    vi.restoreAllMocks();
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  async function processedToolNames(): Promise<string[]> {
    const processor = new ToolProcessor();
    await processor.initialize();
    await processor.processTools();
    return processor.getToolConfigurations().map((tool) => tool.name);
  }

  describe("tool processing", () => {
    beforeAll(() => {
      writeFileSync(join(tmpRoot, "tools.yaml"), TOOLS_YAML);
    });

    it("leaves out tools marked enabled: false", async () => {
      config.toolsYamlPath = join(tmpRoot, "tools.yaml");
      config.selectedToolsets = undefined;
      config.yamlAutoReload = false;

      expect(await processedToolNames()).toEqual(["enabled_tool"]);
    });

    it("warns when a selected toolset does not exist", async () => {
      config.toolsYamlPath = join(tmpRoot, "tools.yaml");
      config.selectedToolsets = ["sample", "typo_set"];
      config.yamlAutoReload = false;
      const warning = vi.spyOn(logger, "warning");

      expect(await processedToolNames()).toEqual(["enabled_tool"]);
      expect(warning).toHaveBeenCalledWith(
        expect.anything(),
        "Unknown toolsets requested: typo_set. Available toolsets: sample",
      );
    });
  });

  describe("file watching", () => {
    it("keeps reporting changes after atomic saves replace the file", async () => {
      config.yamlAutoReload = true;
      const filePath = join(tmpRoot, "watched.yaml");
      writeFileSync(filePath, "# v0\n");

      const onChange = vi.fn();
      ToolProcessor.registerChangeCallback(onChange);
      ToolProcessor.startWatching([filePath]);

      // Editors, `sed -i` and `git checkout` save by writing a temp file and
      // renaming it over the original, which replaces the watched inode.
      for (let save = 1; save <= 3; save++) {
        // A new watcher needs a moment before it reports events.
        await sleep(250);
        writeFileSync(`${filePath}.tmp`, `# v${save}\n`);
        renameSync(`${filePath}.tmp`, filePath);

        await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(save), {
          timeout: 5000,
          interval: 50,
        });
      }
    });
  });
});

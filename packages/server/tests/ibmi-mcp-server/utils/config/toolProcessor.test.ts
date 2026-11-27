/**
 * @fileoverview Tests for ToolProcessor: which YAML tools get processed, and
 * the file watcher that drives auto-reload.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
  vi,
} from "vitest";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { setTimeout as sleep } from "timers/promises";
import { config } from "../../../../src/config/index.js";
import { SourceManager } from "../../../../src/ibmi-mcp-server/services/sourceManager.js";
import { ToolProcessor } from "../../../../src/ibmi-mcp-server/utils/config/toolProcessor.js";

const toolsYaml = (toolNames: string[]) => `
sources:
  test-source:
    host: localhost
    user: tester
    password: not-a-real-password

tools:
${toolNames
  .map(
    (name) => `  ${name}:
    source: test-source
    description: "${name}"
    statement: "SELECT 1 FROM SYSIBM.SYSDUMMY1"`,
  )
  .join("\n")}
`;

const TOOLS_YAML = `${toolsYaml(["enabled_tool"])}
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
    ibmi_enableDefaultTools: config.ibmi_enableDefaultTools,
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

    beforeEach(() => {
      config.toolsYamlPath = join(tmpRoot, "tools.yaml");
      config.selectedToolsets = undefined;
      config.yamlAutoReload = false;
      config.ibmi_enableDefaultTools = false;
    });

    it("leaves out tools marked enabled: false", async () => {
      expect(await processedToolNames()).toEqual(["enabled_tool"]);
    });

    it("fails when a selected toolset does not exist, before any source is registered", async () => {
      config.selectedToolsets = ["sample", "typo_set"];
      const registerSource = vi.spyOn(
        SourceManager.prototype,
        "registerSource",
      );

      await expect(processedToolNames()).rejects.toThrow(
        "Unknown toolsets requested: typo_set. Available toolsets: sample",
      );
      expect(registerSource).not.toHaveBeenCalled();
    });

    it("fails when a YAML tool has the name of a registered built-in tool", async () => {
      const filePath = join(tmpRoot, "collision.yaml");
      writeFileSync(filePath, toolsYaml(["list_schemas", "my_tool"]));
      config.toolsYamlPath = filePath;

      // list_schemas is a built-in tool only with --builtin-tools.
      expect(await processedToolNames()).toEqual(["list_schemas", "my_tool"]);

      config.ibmi_enableDefaultTools = true;
      await expect(processedToolNames()).rejects.toThrow(
        "YAML tool 'list_schemas' has the same name as the built-in tool 'list_schemas'.",
      );
    });
  });

  describe("file watching", () => {
    /** How long to wait to be sure no (further) reload is coming. */
    const SETTLED_MS = 1000;
    let watchedDir: string;
    let dirCount = 0;
    const onChange = vi.fn();

    /** Starts watching the tools path as a load of it would. */
    async function watchPath(toolsPath: string, filePaths: string[]) {
      config.yamlAutoReload = true;
      onChange.mockClear();
      ToolProcessor.registerChangeCallback(onChange);
      ToolProcessor.startWatching(toolsPath, filePaths);
      // A new watcher needs a moment before it reports events.
      await sleep(250);
    }

    const reloads = (count: number) =>
      vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(count), {
        timeout: 5000,
        interval: 50,
      });

    beforeEach(() => {
      watchedDir = join(tmpRoot, `watched-${dirCount++}`);
      mkdirSync(watchedDir);
      writeFileSync(join(watchedDir, "a.yaml"), "# a v0\n");
      writeFileSync(join(watchedDir, "b.yaml"), "# b v0\n");
    });

    it("keeps reporting changes after atomic saves replace the file", async () => {
      const filePath = join(watchedDir, "a.yaml");
      await watchPath(filePath, [filePath]);

      // Editors, `sed -i` and `git checkout` save by writing a temp file and
      // renaming it over the original, which replaces the watched inode.
      for (let save = 1; save <= 3; save++) {
        writeFileSync(`${filePath}.tmp`, `# a v${save}\n`);
        renameSync(`${filePath}.tmp`, filePath);

        await reloads(save);
        await sleep(250);
      }
    });

    it("reloads once for a burst of changes to several files", async () => {
      await watchPath(watchedDir, [
        join(watchedDir, "a.yaml"),
        join(watchedDir, "b.yaml"),
      ]);

      writeFileSync(join(watchedDir, "a.yaml"), "# a v1\n");
      writeFileSync(join(watchedDir, "b.yaml"), "# b v1\n");
      writeFileSync(join(watchedDir, "a.yaml"), "# a v2\n");

      await reloads(1);
      await sleep(SETTLED_MS);
      expect(onChange).toHaveBeenCalledTimes(1);
    });

    it("notices a file added to and removed from a watched directory, also in a new subdirectory", async () => {
      await watchPath(watchedDir, [
        join(watchedDir, "a.yaml"),
        join(watchedDir, "b.yaml"),
      ]);

      writeFileSync(join(watchedDir, "c.yaml"), "# c v0\n");
      await reloads(1);

      rmSync(join(watchedDir, "b.yaml"));
      await reloads(2);

      mkdirSync(join(watchedDir, "nested"));
      writeFileSync(join(watchedDir, "nested", "d.yaml"), "# d v0\n");
      await reloads(3);
    });

    it("does not reload when the files are saved unchanged", async () => {
      await watchPath(watchedDir, [
        join(watchedDir, "a.yaml"),
        join(watchedDir, "b.yaml"),
      ]);

      writeFileSync(join(watchedDir, "a.yaml"), "# a v0\n");
      writeFileSync(join(watchedDir, "notes.txt"), "not a tool file\n");

      await sleep(SETTLED_MS);
      expect(onChange).not.toHaveBeenCalled();
    });

    it("waits for a reload to finish before starting the next", async () => {
      let running = 0;
      let overlapped = false;
      onChange.mockImplementation(async () => {
        overlapped ||= running > 0;
        running++;
        await sleep(600);
        running--;
      });
      await watchPath(watchedDir, [
        join(watchedDir, "a.yaml"),
        join(watchedDir, "b.yaml"),
      ]);

      writeFileSync(join(watchedDir, "a.yaml"), "# a v1\n");
      await reloads(1);
      // The first reload is still running when this one is due.
      writeFileSync(join(watchedDir, "a.yaml"), "# a v2\n");
      await reloads(2);

      expect(overlapped).toBe(false);
      onChange.mockReset();
    });
  });
});

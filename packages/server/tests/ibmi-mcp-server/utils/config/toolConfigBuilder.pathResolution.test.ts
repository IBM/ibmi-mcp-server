/**
 * @fileoverview Path-resolution tests for ToolConfigBuilder.
 *
 * Covers how a tools path (`--tools`, `TOOLS_YAML_PATH`) is resolved to YAML
 * files: a single file, a directory, or a glob pattern.
 *
 * Regression guard for the Windows bug where a glob pattern was built with
 * path.join(), producing backslashes that a glob pattern treats as escape
 * characters rather than path separators, so no tool files were discovered.
 * The fix passes the directory via the `cwd` option and keeps the pattern
 * forward-slash only. See IBM/ibmi-mcp-server#150.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

import { ToolConfigBuilder } from "../../../../src/ibmi-mcp-server/utils/config/toolConfigBuilder.js";

// resolveDirectoryPaths / resolveGlobPaths are private; exercise them directly
// via the singleton instance to keep the test focused on path resolution
// without standing up the full YAML-parsing pipeline.
type PathResolver = {
  resolveDirectoryPaths(directoryPath: string): string[];
  resolveGlobPaths(pattern: string, baseDir?: string): string[];
};

const toolFile = (name: string) => `
sources:
  test-source:
    host: localhost
    user: tester
    password: not-a-real-password

tools:
  ${name}:
    source: test-source
    description: "${name}"
    statement: "SELECT 1 FROM SYSIBM.SYSDUMMY1"
`;

describe("ToolConfigBuilder path resolution", () => {
  let tmpRoot: string;
  let builder: PathResolver;

  beforeAll(() => {
    builder = ToolConfigBuilder.getInstance() as unknown as PathResolver;

    tmpRoot = mkdtempSync(join(tmpdir(), "ibmi-tools-"));
    mkdirSync(join(tmpRoot, "nested"), { recursive: true });

    // Written out of order: the resolved list must not depend on it.
    writeFileSync(join(tmpRoot, "nested", "c.yaml"), toolFile("tool_c"));
    writeFileSync(join(tmpRoot, "b.yml"), toolFile("tool_b"));
    writeFileSync(join(tmpRoot, "a.yaml"), toolFile("tool_a"));
    // Non-YAML files must be ignored.
    writeFileSync(join(tmpRoot, "README.md"), "ignore me\n");
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("finds all .yaml and .yml files in a directory (including nested), sorted", () => {
    const paths = builder.resolveDirectoryPaths(tmpRoot);

    expect(paths).toEqual([
      join(tmpRoot, "a.yaml"),
      join(tmpRoot, "b.yml"),
      join(tmpRoot, "nested", "c.yaml"),
    ]);
    for (const p of paths) {
      expect(resolve(p)).toBe(p);
    }
  });

  it("throws a configuration error for a missing directory", () => {
    expect(() =>
      builder.resolveDirectoryPaths(join(tmpRoot, "does-not-exist")),
    ).toThrow(/Configuration directory not found/);
  });

  it("resolves a relative glob pattern against baseDir, sorted", () => {
    const paths = builder.resolveGlobPaths("**/*.{yaml,yml}", tmpRoot);

    expect(paths).toEqual([
      join(tmpRoot, "a.yaml"),
      join(tmpRoot, "b.yml"),
      join(tmpRoot, "nested", "c.yaml"),
    ]);
  });

  it("throws when a glob pattern matches nothing", () => {
    expect(() => builder.resolveGlobPaths("**/*.json", tmpRoot)).toThrow(
      /No files found matching pattern/,
    );
  });

  describe("a tools path", () => {
    it("is a file, a directory, or a glob when nothing of that name exists", () => {
      const typeOf = (toolsPath: string) =>
        ToolConfigBuilder.sourceForPath(toolsPath).type;

      expect(typeOf(join(tmpRoot, "a.yaml"))).toBe("file");
      expect(typeOf(tmpRoot)).toBe("directory");
      expect(typeOf(join(tmpRoot, "*.yaml"))).toBe("glob");
      expect(typeOf(join(tmpRoot, "missing.yaml"))).toBe("file");
    });

    it("loads the files a glob pattern matches", async () => {
      const result = await ToolConfigBuilder.fromPath(join(tmpRoot, "*.y*ml"));

      expect(result.resolvedFilePaths).toEqual([
        join(tmpRoot, "a.yaml"),
        join(tmpRoot, "b.yml"),
      ]);
      expect(Object.keys(result.config.tools ?? {})).toEqual([
        "tool_a",
        "tool_b",
      ]);
    });

    it("fails for a glob pattern that matches nothing", async () => {
      await expect(
        ToolConfigBuilder.fromPath(join(tmpRoot, "*.json")),
      ).rejects.toThrow(/No files found matching pattern/);
    });

    it("fails for a missing path that is not a pattern", async () => {
      await expect(
        ToolConfigBuilder.fromPath(join(tmpRoot, "missing.yaml")),
      ).rejects.toThrow(/Configuration file not found/);
    });
  });
});

/**
 * @fileoverview Path-resolution tests for ToolConfigBuilder.
 *
 * Covers the directory and glob source resolution used when `--tools` points at
 * a directory (or a glob) rather than a single YAML file.
 *
 * Regression guard for the Windows bug where a glob pattern was built with
 * path.join(), producing backslashes that glob (v10+) treats as escape
 * characters rather than path separators, so no tool files were discovered.
 * The fix passes the directory via glob's `cwd` option and keeps the pattern
 * forward-slash only. See IBM/ibmi-mcp-server#150.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

// Block the scheduler singleton (loaded transitively via the utils barrel).
vi.mock("../../../../src/utils/scheduling/index.js", () => ({
  SchedulerService: { getInstance: vi.fn() },
  schedulerService: {},
}));

import { ToolConfigBuilder } from "../../../../src/ibmi-mcp-server/utils/config/toolConfigBuilder.js";

// resolveDirectoryPaths / resolveGlobPaths are private; exercise them directly
// via the singleton instance to keep the test focused on path resolution
// without standing up the full YAML-parsing pipeline.
type PathResolver = {
  resolveDirectoryPaths(directoryPath: string): string[];
  resolveGlobPaths(pattern: string, baseDir?: string): string[];
};

describe("ToolConfigBuilder path resolution", () => {
  let tmpRoot: string;
  let builder: PathResolver;

  beforeAll(() => {
    builder = ToolConfigBuilder.getInstance() as unknown as PathResolver;

    tmpRoot = mkdtempSync(join(tmpdir(), "ibmi-tools-"));
    mkdirSync(join(tmpRoot, "nested"), { recursive: true });

    writeFileSync(join(tmpRoot, "a.yaml"), "tools: {}\n");
    writeFileSync(join(tmpRoot, "b.yml"), "tools: {}\n");
    writeFileSync(join(tmpRoot, "nested", "c.yaml"), "tools: {}\n");
    // Non-YAML files must be ignored.
    writeFileSync(join(tmpRoot, "README.md"), "ignore me\n");
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("finds all .yaml and .yml files in a directory (including nested)", () => {
    const paths = builder.resolveDirectoryPaths(tmpRoot);

    expect(paths).toHaveLength(3);
    // Returned paths are absolute and forward-slash-comparable.
    const names = paths.map((p) => p.split(/[\\/]/).pop()).sort();
    expect(names).toEqual(["a.yaml", "b.yml", "c.yaml"]);
    for (const p of paths) {
      expect(resolve(p)).toBe(p);
    }
  });

  it("throws a configuration error for a missing directory", () => {
    expect(() =>
      builder.resolveDirectoryPaths(join(tmpRoot, "does-not-exist")),
    ).toThrow(/Configuration directory not found/);
  });

  it("resolves a relative glob pattern against baseDir", () => {
    const paths = builder.resolveGlobPaths("**/*.{yaml,yml}", tmpRoot);

    expect(paths).toHaveLength(3);
    const names = paths.map((p) => p.split(/[\\/]/).pop()).sort();
    expect(names).toEqual(["a.yaml", "b.yml", "c.yaml"]);
  });

  it("throws when a glob pattern matches nothing", () => {
    expect(() => builder.resolveGlobPaths("**/*.json", tmpRoot)).toThrow(
      /No files found matching pattern/,
    );
  });
});

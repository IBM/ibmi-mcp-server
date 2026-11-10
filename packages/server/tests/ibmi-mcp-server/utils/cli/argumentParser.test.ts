/**
 * @fileoverview Tests for the server's command-line argument parser.
 */

import { describe, it, expect, afterEach } from "vitest";

import { parseCliArguments } from "../../../../src/ibmi-mcp-server/utils/cli/argumentParser.js";

describe("parseCliArguments", () => {
  const originalArgv = process.argv;

  afterEach(() => {
    process.argv = originalArgv;
  });

  function parse(...args: string[]) {
    process.argv = ["node", "index.js", ...args];
    return parseCliArguments();
  }

  it("parses known flags and their values", () => {
    const parsed = parse(
      "--transport",
      "http",
      "--tools",
      "tools/sample.yaml",
      "--toolsets",
      "a, b",
      "--list-toolsets",
    );

    expect(parsed.transport).toBe("http");
    expect(parsed.tools).toBe("tools/sample.yaml");
    expect(parsed.toolsets).toEqual(["a", "b"]);
    expect(parsed.listToolsets).toBe(true);
    expect(parsed.errors).toEqual([]);
    expect(parsed.warnings).toEqual([]);
  });

  it("warns about an unknown flag without dropping the flag after it", () => {
    const parsed = parse(
      "--verbose",
      "--tools",
      "tools/sample.yaml",
      "--list-toolsets",
    );

    expect(parsed.warnings).toEqual(["Unknown argument detected: --verbose"]);
    expect(parsed.tools).toBe("tools/sample.yaml");
    expect(parsed.listToolsets).toBe(true);
  });
});

/**
 * @fileoverview Tests for the server's command-line argument parser.
 */

import { describe, it, expect, afterEach, vi } from "vitest";

import {
  parseCliArguments,
  showHelp,
} from "../../../../src/ibmi-mcp-server/utils/cli/argumentParser.js";

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
      "--builtin-tools",
      "--execute-sql",
    );

    expect(parsed).toEqual({
      transport: "http",
      tools: "tools/sample.yaml",
      toolsets: ["a", "b"],
      listToolsets: true,
      builtinTools: true,
      executeSql: true,
      help: undefined,
    });
  });

  it("accepts --flag=value", () => {
    const parsed = parse(
      "--transport=http",
      "--tools=tools/*.yaml",
      "--toolsets=a,b",
    );

    expect(parsed.transport).toBe("http");
    expect(parsed.tools).toBe("tools/*.yaml");
    expect(parsed.toolsets).toEqual(["a", "b"]);
  });

  it("accepts the short forms -t, -ts and -h", () => {
    const parsed = parse("-t", "stdio", "-ts", "a", "-h");

    expect(parsed.transport).toBe("stdio");
    expect(parsed.toolsets).toEqual(["a"]);
    expect(parsed.help).toBe(true);
  });

  it("takes the command of --admin as one value, spaces included", () => {
    expect(parse("--admin", "unblock MYUSER").admin).toBe("unblock MYUSER");
    expect(parse("--admin=status").admin).toBe("status");
    expect(parse("--transport", "http").admin).toBeUndefined();
  });

  it("describes --admin and its commands in the help", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      showHelp();
      const help = String(log.mock.calls[0]?.[0]);
      expect(help).toContain("--admin <command>");
      expect(help).toContain("OAUTH_ADMIN_SOCKET");
      for (const command of [
        "status",
        "unblock <profile>",
        "revoke <profile|grantId>",
      ]) {
        expect(help).toContain(command);
      }
    } finally {
      log.mockRestore();
    }
  });

  it("uses the last occurrence of a repeated flag", () => {
    expect(parse("--tools", "a.yaml", "--tools", "b.yaml").tools).toBe(
      "b.yaml",
    );
  });

  // The wording of the first four is Node's (util.parseArgs).
  it.each([
    ["an unknown flag", ["--verbose"], /--verbose/],
    ["a flag without its value", ["--tools"], /--tools/],
    ["--admin without a command", ["--admin"], /--admin/],
    [
      "a flag followed by another flag instead of its value",
      ["--tools", "--list-toolsets"],
      /--tools/,
    ],
    ["a positional argument", ["tools.yaml"], /tools\.yaml/],
    [
      "an invalid transport type",
      ["--transport", "sse"],
      /Invalid transport type: sse/,
    ],
  ])("rejects %s", (_case, args, message) => {
    expect(() => parse(...args)).toThrow(message);
  });
});

import { afterEach, describe, it, expect } from "vitest";
import { Command, Option } from "commander";
import {
  createCliContext,
  getFormat,
} from "../../src/utils/command-helpers.js";

describe("createCliContext", () => {
  it("should return a context with requestId and timestamp", () => {
    const ctx = createCliContext("test_tool");
    expect(ctx.requestId).toMatch(/^cli-/);
    expect(ctx.timestamp).toBeTruthy();
    expect(ctx["toolName"]).toBe("test_tool");
    expect(ctx["operation"]).toBe("CliToolExecution");
  });

  it("should generate unique requestIds", () => {
    const ctx1 = createCliContext("tool1");
    const ctx2 = createCliContext("tool2");
    expect(ctx1.requestId).not.toBe(ctx2.requestId);
  });

  it("should include ISO timestamp", () => {
    const ctx = createCliContext("test_tool");
    // Verify it's a valid ISO date string
    expect(() => new Date(ctx.timestamp as string)).not.toThrow();
    expect(new Date(ctx.timestamp as string).toISOString()).toBe(ctx.timestamp);
  });
});

describe("getFormat", () => {
  const isTTY = process.stdout.isTTY;
  afterEach(() => {
    process.stdout.isTTY = isTTY;
  });

  /** The format a subcommand sees for these global arguments. */
  function formatFor(args: string[]): string {
    let seen = "";
    const program = new Command()
      .exitOverride()
      .option("--raw")
      .option("--stream")
      .addOption(
        new Option("--format <type>").choices([
          "table",
          "json",
          "csv",
          "markdown",
        ]),
      );
    program.command("run").action((_opts, cmd: Command) => {
      seen = getFormat(cmd);
    });
    program.parse(["node", "ibmi", ...args, "run"]);
    return seen;
  }

  it("--stream selects JSON on a terminal", () => {
    process.stdout.isTTY = true;
    expect(formatFor(["--stream"])).toBe("json");
  });

  it("an explicit --format still wins over --stream", () => {
    process.stdout.isTTY = true;
    expect(formatFor(["--stream", "--format", "csv"])).toBe("csv");
  });
});

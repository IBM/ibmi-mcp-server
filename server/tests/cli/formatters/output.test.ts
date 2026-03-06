import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  detectFormat,
  renderOutput,
  renderNdjson,
  renderError,
  renderMessage,
} from "../../../src/cli/formatters/output";
import { ErrorCode } from "../../../src/cli/utils/exit-codes";

// Capture stdout/stderr writes
let stdoutOutput: string;
let stderrOutput: string;

beforeEach(() => {
  stdoutOutput = "";
  stderrOutput = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdoutOutput += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    stderrOutput += String(chunk);
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("detectFormat", () => {
  it("should return json when raw is true", () => {
    expect(detectFormat(undefined, true)).toBe("json");
  });

  it("should return explicit format when provided", () => {
    expect(detectFormat("csv")).toBe("csv");
    expect(detectFormat("markdown")).toBe("markdown");
  });

  it("should return json when raw overrides explicit format", () => {
    expect(detectFormat("table", true)).toBe("json");
  });
});

describe("renderOutput — JSON format", () => {
  it("should output JSON envelope with ok:true", () => {
    renderOutput([{ name: "test" }], "json", { rowCount: 1 });
    const parsed = JSON.parse(stdoutOutput);
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toEqual([{ name: "test" }]);
    expect(parsed.meta.rows).toBe(1);
  });

  it("should include system and host when provided", () => {
    renderOutput([{ x: 1 }], "json", {
      rowCount: 1,
      system: {
        name: "dev",
        config: { host: "dev400.example.com", port: 8076, user: "DEVUSER", readOnly: false, confirm: false, timeout: 60, maxRows: 5000, ignoreUnauthorized: false },
        source: "config-default",
      },
    });
    const parsed = JSON.parse(stdoutOutput);
    expect(parsed.system).toBe("dev");
    expect(parsed.host).toBe("dev400.example.com");
  });

  it("should include command name when provided", () => {
    renderOutput([{ x: 1 }], "json", {
      rowCount: 1,
      command: "schemas",
    });
    const parsed = JSON.parse(stdoutOutput);
    expect(parsed.command).toBe("schemas");
  });

  it("should include elapsed_ms in meta when provided", () => {
    renderOutput([], "json", {
      rowCount: 0,
      elapsedMs: 342,
    });
    const parsed = JSON.parse(stdoutOutput);
    expect(parsed.meta.elapsed_ms).toBe(342);
  });

  it("should set hasMore in meta", () => {
    renderOutput([], "json", {
      rowCount: 0,
      hasMore: true,
    });
    const parsed = JSON.parse(stdoutOutput);
    expect(parsed.meta.hasMore).toBe(true);
  });
});

describe("renderNdjson", () => {
  it("should output one JSON object per line", () => {
    renderNdjson([
      { name: "row1", value: 1 },
      { name: "row2", value: 2 },
      { name: "row3", value: 3 },
    ]);

    const lines = stdoutOutput.trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]!)).toEqual({ name: "row1", value: 1 });
    expect(JSON.parse(lines[1]!)).toEqual({ name: "row2", value: 2 });
    expect(JSON.parse(lines[2]!)).toEqual({ name: "row3", value: 3 });
  });

  it("should output nothing for empty data", () => {
    renderNdjson([]);
    expect(stdoutOutput).toBe("");
  });

  it("should not pretty-print (compact JSON per line)", () => {
    renderNdjson([{ a: 1, b: 2 }]);
    // Should be a single line, no indentation
    expect(stdoutOutput).toBe('{"a":1,"b":2}\n');
  });
});

describe("renderError", () => {
  it("should output structured JSON error with code in json format", () => {
    renderError(new Error("SQL0204 - table not found"), "json");
    const parsed = JSON.parse(stdoutOutput);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBeDefined();
    expect(parsed.error.message).toBe("SQL0204 - table not found");
  });

  it("should use provided errorCode over auto-classified", () => {
    renderError(
      new Error("Something went wrong"),
      "json",
      undefined,
      ErrorCode.USAGE_ERROR,
    );
    const parsed = JSON.parse(stdoutOutput);
    expect(parsed.error.code).toBe("USAGE_ERROR");
  });

  it("should include system name in JSON error when provided", () => {
    renderError(new Error("fail"), "json", {
      name: "prod",
      config: { host: "prod400", port: 8076, user: "X", readOnly: true, confirm: true, timeout: 30, maxRows: 1000, ignoreUnauthorized: false },
      source: "flag",
    });
    const parsed = JSON.parse(stdoutOutput);
    expect(parsed.system).toBe("prod");
  });

  it("should write to stderr in table format", () => {
    renderError(new Error("Something broke"), "table");
    expect(stderrOutput).toContain("Error: Something broke");
    expect(stdoutOutput).toBe("");
  });
});

describe("renderMessage", () => {
  it("should output JSON with ok:true and message in json format", () => {
    renderMessage("Done!", "json");
    const parsed = JSON.parse(stdoutOutput);
    expect(parsed.ok).toBe(true);
    expect(parsed.message).toBe("Done!");
  });

  it("should output plain text in table format", () => {
    renderMessage("Done!", "table");
    expect(stdoutOutput).toBe("Done!\n");
  });
});

describe("renderOutput — CSV format", () => {
  it("should output CSV with headers", () => {
    renderOutput(
      [
        { NAME: "MYLIB", TYPE: "SCHEMA" },
        { NAME: "QSYS", TYPE: "SCHEMA" },
      ],
      "csv",
    );
    const lines = stdoutOutput.trim().split("\n");
    expect(lines[0]).toBe("NAME,TYPE");
    expect(lines[1]).toBe("MYLIB,SCHEMA");
    expect(lines[2]).toBe("QSYS,SCHEMA");
  });

  it("should escape CSV fields with commas", () => {
    renderOutput([{ DESC: "hello, world" }], "csv");
    expect(stdoutOutput).toContain('"hello, world"');
  });
});

describe("--stream flag registration", () => {
  it("should register --stream as a global option", async () => {
    const { createProgram } = await import("../../../src/cli/index");
    const program = createProgram();
    const streamOpt = program.options.find((o) => o.long === "--stream");
    expect(streamOpt).toBeDefined();
  });
});

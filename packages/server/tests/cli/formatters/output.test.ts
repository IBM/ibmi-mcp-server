import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  detectFormat,
  renderOutput,
  renderNdjson,
  renderError,
  renderMessage,
  renderMultiSystemOutput,
  renderMultiSystemNdjson,
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

describe("renderMultiSystemOutput — JSON format", () => {
  it("should produce JSON envelope with ok:true, data with SYSTEM column, systems array, and meta", () => {
    const results = [
      { system: "dev", host: "dev400.com", data: [{ EMPNO: "100" }], rowCount: 1, elapsedMs: 50 },
      { system: "prod", host: "prod400.com", data: [{ EMPNO: "200" }], rowCount: 1, elapsedMs: 80 },
    ] as { system: string; host: string; data: Record<string, unknown>[]; rowCount: number; elapsedMs: number; error?: string }[];

    renderMultiSystemOutput(results, "json");
    const parsed = JSON.parse(stdoutOutput);

    expect(parsed.ok).toBe(true);
    expect(parsed.data).toEqual([
      { SYSTEM: "dev", EMPNO: "100" },
      { SYSTEM: "prod", EMPNO: "200" },
    ]);
    expect(parsed.systems).toEqual([
      { system: "dev", host: "dev400.com", rows: 1, elapsed_ms: 50 },
      { system: "prod", host: "prod400.com", rows: 1, elapsed_ms: 80 },
    ]);
    expect(parsed.meta.total_rows).toBe(2);
    expect(parsed.meta.systems_queried).toBe(2);
    expect(parsed.meta.systems_ok).toBe(2);
    expect(parsed.meta.systems_failed).toBe(0);
  });

  it("should set ok:false when any system has an error", () => {
    const results = [
      { system: "dev", host: "dev400.com", data: [{ EMPNO: "100" }], rowCount: 1, elapsedMs: 50 },
      { system: "prod", host: "prod400.com", data: [], rowCount: 0, elapsedMs: 0, error: "Connection refused" },
    ] as { system: string; host: string; data: Record<string, unknown>[]; rowCount: number; elapsedMs: number; error?: string }[];

    renderMultiSystemOutput(results, "json");
    const parsed = JSON.parse(stdoutOutput);

    expect(parsed.ok).toBe(false);
    expect(parsed.meta.systems_ok).toBe(1);
    expect(parsed.meta.systems_failed).toBe(1);
    expect(parsed.systems[1].error).toBe("Connection refused");
  });
});

describe("renderMultiSystemOutput — CSV format", () => {
  it("should include SYSTEM column in CSV output", () => {
    const results = [
      { system: "dev", host: "dev400.com", data: [{ EMPNO: "100" }], rowCount: 1, elapsedMs: 50 },
      { system: "prod", host: "prod400.com", data: [{ EMPNO: "200" }], rowCount: 1, elapsedMs: 80 },
    ] as { system: string; host: string; data: Record<string, unknown>[]; rowCount: number; elapsedMs: number; error?: string }[];

    renderMultiSystemOutput(results, "csv");
    const lines = stdoutOutput.trim().split("\n");

    expect(lines[0]).toBe("SYSTEM,EMPNO");
    expect(lines[1]).toBe("dev,100");
    expect(lines[2]).toBe("prod,200");
  });
});

describe("renderMultiSystemOutput — table format with error rows", () => {
  it("error system should produce ERROR column in merged rows", () => {
    const results = [
      { system: "dev", host: "dev400.com", data: [{ EMPNO: "100" }], rowCount: 1, elapsedMs: 50 },
      { system: "prod", host: "prod400.com", data: [], rowCount: 0, elapsedMs: 0, error: "Connection refused" },
    ] as { system: string; host: string; data: Record<string, unknown>[]; rowCount: number; elapsedMs: number; error?: string }[];

    renderMultiSystemOutput(results, "table");

    expect(stdoutOutput).toContain("dev");
    expect(stdoutOutput).toContain("100");
    expect(stdoutOutput).toContain("prod");
    // Error system shows in the footer as "[prod] ERROR"
    expect(stdoutOutput).toContain("[prod] ERROR");
  });
});

describe("renderMultiSystemNdjson", () => {
  it("each row should have _system field", () => {
    const results = [
      { system: "dev", host: "dev400.com", data: [{ EMPNO: "100" }], rowCount: 1, elapsedMs: 50 },
      { system: "prod", host: "prod400.com", data: [{ EMPNO: "200" }], rowCount: 1, elapsedMs: 80 },
    ] as { system: string; host: string; data: Record<string, unknown>[]; rowCount: number; elapsedMs: number; error?: string }[];

    renderMultiSystemNdjson(results);
    const lines = stdoutOutput.trim().split("\n");

    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({ _system: "dev", EMPNO: "100" });
    expect(JSON.parse(lines[1]!)).toEqual({ _system: "prod", EMPNO: "200" });
  });

  it("error rows should have _system and _error fields", () => {
    const results = [
      { system: "prod", host: "prod400.com", data: [], rowCount: 0, elapsedMs: 0, error: "Connection refused" },
    ] as { system: string; host: string; data: Record<string, unknown>[]; rowCount: number; elapsedMs: number; error?: string }[];

    renderMultiSystemNdjson(results);
    const lines = stdoutOutput.trim().split("\n");

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({ _system: "prod", _error: "Connection refused" });
  });

  it("should produce one JSON object per line", () => {
    const results = [
      { system: "dev", host: "dev400.com", data: [{ EMPNO: "100" }, { EMPNO: "101" }], rowCount: 2, elapsedMs: 50 },
      { system: "prod", host: "prod400.com", data: [{ EMPNO: "200" }], rowCount: 1, elapsedMs: 80 },
    ] as { system: string; host: string; data: Record<string, unknown>[]; rowCount: number; elapsedMs: number; error?: string }[];

    renderMultiSystemNdjson(results);
    const lines = stdoutOutput.trim().split("\n");

    expect(lines).toHaveLength(3);
    // Each line should be valid JSON
    for (const line of lines) {
      expect(() => JSON.parse(line!)).not.toThrow();
    }
    expect(JSON.parse(lines[0]!)._system).toBe("dev");
    expect(JSON.parse(lines[1]!)._system).toBe("dev");
    expect(JSON.parse(lines[2]!)._system).toBe("prod");
  });
});

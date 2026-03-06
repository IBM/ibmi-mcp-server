import { describe, it, expect, afterEach } from "vitest";
import {
  setOutputFile,
  finalizeOutput,
  renderOutput,
  renderNdjson,
} from "../../../src/cli/formatters/output.js";
import { existsSync, readFileSync, unlinkSync } from "fs";
import path from "path";
import os from "os";

describe("--output file redirection", () => {
  const testDir = os.tmpdir();
  let testFile: string;

  // Generate a unique file name per test via beforeEach equivalent — we set it in each test
  afterEach(() => {
    // Ensure stream is closed and state is reset after every test
    finalizeOutput();
    try {
      if (testFile && existsSync(testFile)) unlinkSync(testFile);
    } catch {
      // Ignore cleanup failures
    }
  });

  it("should write CSV output to file", () => {
    testFile = path.join(testDir, `ibmi-test-${Date.now()}-csv.txt`);
    setOutputFile(testFile);
    renderOutput([{ NAME: "test", VALUE: "123" }], "csv");
    finalizeOutput();

    expect(existsSync(testFile)).toBe(true);
    const content = readFileSync(testFile, "utf-8");
    expect(content).toContain("NAME");
    expect(content).toContain("test");
  });

  it("should write JSON output to file", () => {
    testFile = path.join(testDir, `ibmi-test-${Date.now()}-json.txt`);
    setOutputFile(testFile);
    renderOutput([{ NAME: "test" }], "json");
    finalizeOutput();

    expect(existsSync(testFile)).toBe(true);
    const content = readFileSync(testFile, "utf-8");
    const parsed = JSON.parse(content) as { ok: boolean; data: unknown[] };
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toHaveLength(1);
  });

  it("should write NDJSON to file", () => {
    testFile = path.join(testDir, `ibmi-test-${Date.now()}-ndjson.txt`);
    setOutputFile(testFile);
    renderNdjson([{ A: 1 }, { A: 2 }]);
    finalizeOutput();

    expect(existsSync(testFile)).toBe(true);
    const lines = readFileSync(testFile, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({ A: 1 });
  });

  it("should print confirmation to stderr on finalize", () => {
    testFile = path.join(testDir, `ibmi-test-${Date.now()}-stderr.txt`);
    const stderrWrites: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      stderrWrites.push(chunk);
      return true;
    }) as typeof process.stderr.write;

    try {
      setOutputFile(testFile);
      renderOutput([{ X: 1 }], "csv");
      finalizeOutput();
      expect(stderrWrites.some((s) => s.includes("Output written to"))).toBe(true);
    } finally {
      process.stderr.write = original;
    }
  });

  it("should not create a file when setOutputFile is not called", () => {
    testFile = path.join(testDir, `ibmi-test-${Date.now()}-none.txt`);
    // No setOutputFile call — output goes to stdout, file should not exist
    renderOutput([{ X: 1 }], "csv");
    expect(existsSync(testFile)).toBe(false);
  });
});

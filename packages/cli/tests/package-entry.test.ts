/**
 * @fileoverview The package's library entry (`main`) must be the module that
 * exports `createProgram`. The `ibmi` bin is a different module: importing
 * that one runs the CLI.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";

const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
) as { main: string; types: string; bin: Record<string, string> };

/** The source module a built file under dist/ comes from */
const sourceOf = (distFile: string) =>
  distFile.replace(/^dist\//, "../src/").replace(/\.d\.ts$/, ".js");

describe("@ibm/ibmi-cli package entry", () => {
  it("exports createProgram from `main`, with types from the same module", async () => {
    const entry = (await import(sourceOf(manifest.main))) as Record<
      string,
      unknown
    >;

    expect(entry.createProgram).toBeTypeOf("function");
    expect(sourceOf(manifest.types)).toBe(sourceOf(manifest.main));
  });

  it("keeps the module that runs the CLI as the bin only", () => {
    expect(manifest.bin.ibmi).toBe("dist/index.js");
    expect(manifest.main).not.toBe(manifest.bin.ibmi);
  });
});

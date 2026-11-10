/**
 * @fileoverview Load-failure reporting tests for ToolConfigBuilder.
 */

import { describe, it, expect } from "vitest";
import { resolve } from "path";

import { ToolConfigBuilder } from "../../../../src/ibmi-mcp-server/utils/config/toolConfigBuilder.js";

describe("ToolConfigBuilder load errors", () => {
  it("reports the file and its validation errors when nothing loads", async () => {
    const filePath = resolve(
      process.cwd(),
      "tests/fixtures/invalid/missing-required-fields.yaml",
    );

    const error = await ToolConfigBuilder.fromFile(filePath).then(
      () => undefined,
      (e: Error) => e,
    );

    expect(error?.message).toContain("No valid configurations to merge");
    expect(error?.message).toContain(filePath);
    expect(error?.message).toContain("sources.invalid-source.password");
  });
});

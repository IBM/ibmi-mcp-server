/**
 * @fileoverview Guards the published JSON Schema for YAML tool files against
 * drifting from the Zod schema it is generated from
 * (`npm run generate-schemas -w @ibm/ibmi-mcp-server`).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

import { buildJsonSchema } from "../../../scripts/generate-json-schemas.js";
import { SqlToolsConfigSchema } from "../../../src/ibmi-mcp-server/schemas/config.js";

describe("sql-tools-config.json", () => {
  const generated = buildJsonSchema(SqlToolsConfigSchema, "sql-tools-config");

  it("describes the tool, source and toolset sections", () => {
    const properties = generated.properties as Record<string, unknown>;
    expect(Object.keys(properties)).toEqual(
      expect.arrayContaining(["sources", "tools", "toolsets"]),
    );
  });

  it.each([
    "src/ibmi-mcp-server/schemas/json/sql-tools-config.json",
    "../../skills/ibmi-mcp-tool-builder/assets/sql-tools-config.json",
  ])("%s matches the Zod schema", (relativePath) => {
    const committed = JSON.parse(
      readFileSync(resolve(process.cwd(), relativePath), "utf8"),
    );
    expect(committed).toEqual(generated);
  });
});

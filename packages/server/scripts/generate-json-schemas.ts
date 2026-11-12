#!/usr/bin/env tsx

/**
 * @fileoverview Script to generate JSON schemas from Zod schemas for YAML Language Server integration
 * This script converts Zod schemas to JSON Schema format to enable YAML validation and autocomplete
 * in editors like VS Code with the YAML extension.
 *
 * @module scripts/generate-json-schemas
 * @see {@link https://github.com/redhat-developer/vscode-yaml} YAML Language Server
 */

import { realpathSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { z } from "zod";
import { SqlToolsConfigSchema } from "../src/ibmi-mcp-server/schemas/config.js";

// Get current directory for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Output directories: the server's schema folder and the tool-builder skill's
// bundled copy, which must stay identical.
const OUTPUT_DIRS = [
  join(__dirname, "..", "src", "ibmi-mcp-server", "schemas", "json"),
  join(
    __dirname,
    "..",
    "..",
    "..",
    "skills",
    "ibmi-mcp-tool-builder",
    "assets",
  ),
];

/**
 * Converts a Zod schema to the JSON Schema document written to disk
 * @param zodSchema - The Zod schema to convert
 * @param fileName - Output file name (without extension), used in the `$id`
 */
export function buildJsonSchema(
  zodSchema: z.ZodType,
  fileName: string,
): Record<string, unknown> {
  // Convert Zod schema to JSON Schema (draft-07, as YAML is authored)
  const jsonSchema = z.toJSONSchema(zodSchema, {
    target: "draft-7",
    io: "input",
  });

  // Add schema metadata for YAML Language Server
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: `https://github.com/IBM/ibmi-mcp-server.git/src/ibmi-mcp-server/schemas/json/${fileName}.json`,
    ...jsonSchema,
  };
}

/**
 * Generates JSON schema from Zod schema and writes to file
 * @param zodSchema - The Zod schema to convert
 * @param fileName - Output file name (without extension)
 */
function generateJsonSchema(zodSchema: z.ZodType, fileName: string): void {
  console.log(`Generating JSON schema for ${fileName}...`);

  try {
    const content =
      JSON.stringify(buildJsonSchema(zodSchema, fileName), null, 2) + "\n";

    for (const outputDir of OUTPUT_DIRS) {
      const outputPath = join(outputDir, `${fileName}.json`);
      writeFileSync(outputPath, content, "utf8");
      console.log(`✓ Generated: ${outputPath}`);
    }
  } catch (error) {
    console.error(`✗ Failed to generate ${fileName}:`, error);
    process.exit(1);
  }
}

/**
 * Main function to generate all JSON schemas
 */
function main(): void {
  console.log("Starting JSON schema generation...\n");

  // Generate schema for YAML tool configuration files
  generateJsonSchema(SqlToolsConfigSchema, "sql-tools-config");

  console.log("\n✓ All JSON schemas generated successfully!");
  console.log("\nTo associate these schemas with YAML files in VS Code:");
  console.log("1. Install the YAML extension by Red Hat");
  console.log("2. Add to your VS Code settings.json:");
  console.log(`{
  "yaml.schemas": {
    "./packages/server/src/ibmi-mcp-server/schemas/json/sql-tools-config.json": [
      "tools/*.yaml",
      "tools/*.yml",
      "configs/*.yaml",
      "configs/*.yml"
    ]
  }
}`);
}

// Execute only when run as a script (not when imported by tests).
// import.meta.url is percent-encoded and symlink-resolved; argv[1] is neither.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  main();
}

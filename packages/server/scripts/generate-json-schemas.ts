#!/usr/bin/env tsx

/**
 * @fileoverview Script to generate JSON schemas from Zod schemas for YAML Language Server integration
 * This script converts Zod schemas to JSON Schema format to enable YAML validation and autocomplete
 * in editors like VS Code with the YAML extension.
 *
 * @module scripts/generate-json-schemas
 * @see {@link https://github.com/redhat-developer/vscode-yaml} YAML Language Server
 */

import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ZodSchema } from "zod";
import { SqlToolsConfigSchema } from "../src/ibmi-mcp-server/schemas/config.js";

// Get current directory for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Define output directory
const OUTPUT_DIR = join(
  __dirname,
  "..",
  "src",
  "ibmi-mcp-server",
  "schemas",
  "json",
);

/**
 * Generates JSON schema from Zod schema and writes to file
 * @param zodSchema - The Zod schema to convert
 * @param fileName - Output file name (without extension)
 * @param title - Schema title for JSON Schema metadata
 * @param description - Schema description for JSON Schema metadata
 */
function generateJsonSchema(
  zodSchema: ZodSchema,
  fileName: string,
  title: string,
  _description: string,
): void {
  console.log(`Generating JSON schema for ${fileName}...`);

  try {
    // Convert Zod schema to JSON Schema
    const jsonSchema = zodToJsonSchema(zodSchema, {
      name: title,
      $refStrategy: "root",
      target: "jsonSchema7",
      strictUnions: true,
      definitions: {},
    });

    // Add schema metadata for YAML Language Server
    // NOTE: We don't add additionalProperties or type at root level when there's a $ref
    // because those constraints should be in the referenced definition, not at the root
    const enhancedSchema = {
      $schema: "http://json-schema.org/draft-07/schema#",
      $id: `https://github.com/IBM/ibmi-mcp-server.git/src/ibmi-mcp-server/schemas/json/${fileName}.json`,
      ...jsonSchema,
    };

    // Write to file
    const outputPath = join(OUTPUT_DIR, `${fileName}.json`);
    writeFileSync(outputPath, JSON.stringify(enhancedSchema, null, 2), "utf8");

    console.log(`✓ Generated: ${outputPath}`);
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
  generateJsonSchema(
    SqlToolsConfigSchema,
    "sql-tools-config",
    "IBM i MCP Server SQL Tools Configuration",
    "JSON Schema for IBM i MCP Server YAML configuration files defining SQL tools, sources, and toolsets",
  );

  console.log("\n✓ All JSON schemas generated successfully!");
  console.log("\nTo associate these schemas with YAML files in VS Code:");
  console.log("1. Install the YAML extension by Red Hat");
  console.log("2. Add to your VS Code settings.json:");
  console.log(`{
  "yaml.schemas": {
    "./src/ibmi-mcp-server/schemas/json/sql-tools-config.json": [
      "tools/*.yaml",
      "tools/*.yml",
      "configs/*.yaml",
      "configs/*.yml"
    ]
  }
}`);
}

// Execute the script
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

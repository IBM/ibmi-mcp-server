#!/usr/bin/env node

/**
 * @fileoverview Standalone YAML Configuration Validation CLI Script
 *
 * This script validates YAML tool configurations against the JSON schema without
 * importing any server source code. It uses Ajv for JSON Schema validation.
 *
 * Usage:
 *   npm run validate -- --tools file.yaml
 *   npm run validate -- --tools-dir tools/
 *
 * @module scripts/validate-config
 */

import { readFileSync, readdirSync, statSync } from "fs";
import { resolve, extname, relative, dirname } from "path";
import { fileURLToPath } from "url";
import { parseArgs } from "util";
import * as yaml from "js-yaml";
import Ajv from "ajv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Path to the JSON schema
const SCHEMA_PATH = resolve(
  __dirname,
  "../server/src/ibmi-mcp-server/schemas/json/sql-tools-config.json"
);

interface ValidationResult {
  success: boolean;
  errors: string[];
  config?: unknown;
}

interface FileValidationResult {
  filePath: string;
  relativePath: string;
  isValid: boolean;
  errors: string[];
  processingTime: number;
  stats?: ConfigStats;
  config?: any; // Keep the parsed config for cross-reference validation
}

interface CrossReferenceValidationResult {
  isValid: boolean;
  errors: string[];
}

interface ConfigStats {
  sourceCount: number;
  toolCount: number;
  toolsetCount: number;
  parameterCount: number;
}

interface ValidationReport {
  totalFiles: number;
  validFiles: number;
  invalidFiles: number;
  files: FileValidationResult[];
  summary: ValidationSummary;
  crossReferenceErrors?: string[]; // Cross-file validation errors
}

interface ValidationSummary {
  totalSources: number;
  totalTools: number;
  totalToolsets: number;
  totalParameters: number;
  commonErrors: string[];
}

/**
 * CLI argument parser configuration
 */
const ARGS_CONFIG = {
  tools: {
    type: "string" as const,
    short: "t",
    description: "Path to a single YAML file to validate",
  },
  "tools-dir": {
    type: "string" as const,
    short: "d",
    description: "Path to a directory containing YAML files to validate",
  },
  verbose: {
    type: "boolean" as const,
    short: "v",
    default: false,
    description: "Enable verbose output with detailed validation results",
  },
  help: {
    type: "boolean" as const,
    short: "h",
    default: false,
    description: "Show this help message",
  },
} as const;

/**
 * Display usage information and help text
 */
function showHelp(): void {
  console.log(`
YAML Configuration Validation Tool

Usage:
  npm run validate -- --tools <file.yaml>       Validate a single YAML file
  npm run validate -- --tools-dir <directory>   Validate all YAML files in a directory

Options:
  -t, --tools <file>        Path to a single YAML file to validate
  -d, --tools-dir <dir>     Path to a directory containing YAML files
  -v, --verbose             Enable verbose output with detailed validation results
  -h, --help                Show this help message

Examples:
  npm run validate -- --tools tools/performance.yaml
  npm run validate -- --tools-dir tools/
  npm run validate -- --tools-dir ../tools/ --verbose

Note: The "--" is required to separate npm arguments from script arguments.

The script validates YAML configurations against the JSON schema located at:
${SCHEMA_PATH}
`);
}

/**
 * Parse command line arguments using Node.js built-in parseArgs
 */
function parseCliArgs(): {
  tools?: string;
  toolsDir?: string;
  verbose: boolean;
  help: boolean;
} {
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      options: ARGS_CONFIG,
      allowPositionals: false,
    });

    return {
      tools: values.tools,
      toolsDir: values["tools-dir"],
      verbose: values.verbose || false,
      help: values.help || false,
    };
  } catch (error) {
    console.error(
      `❌ Invalid arguments: ${error instanceof Error ? error.message : "Unknown error"}`
    );
    showHelp();
    process.exit(1);
  }
}

/**
 * Load and parse the JSON schema
 */
function loadJsonSchema(): any {
  try {
    const schemaContent = readFileSync(SCHEMA_PATH, "utf-8");
    return JSON.parse(schemaContent);
  } catch (error) {
    console.error(`❌ Failed to load JSON schema from ${SCHEMA_PATH}`);
    console.error(
      `   Error: ${error instanceof Error ? error.message : "Unknown error"}`
    );
    process.exit(1);
  }
}

/**
 * Validate a parsed YAML config against the JSON schema
 */
function validateAgainstSchema(
  config: unknown,
  ajvInstance: any
): ValidationResult {
  let valid: boolean;
  let errors: any[] = [];

  try {
    // Validate using the schema - Ajv will follow the $ref
    valid = ajvInstance.validate(
      "https://github.com/IBM/ibmi-mcp-server.git/src/ibmi-mcp-server/schemas/json/sql-tools-config.json",
      config
    );
    errors = ajvInstance.errors || [];
  } catch (error) {
    return {
      success: false,
      errors: [error instanceof Error ? error.message : "Validation error"],
      config,
    };
  }

  if (!valid && errors.length > 0) {
    const formattedErrors = errors.map((err: any) => {
      const path = err.instancePath || "root";
      const message = err.message || "validation error";
      const params = err.params ? ` (${JSON.stringify(err.params)})` : "";
      return `${path}: ${message}${params}`;
    });

    return {
      success: false,
      errors: formattedErrors,
      config,
    };
  }

  return {
    success: true,
    errors: [],
    config,
  };
}

/**
 * Calculate statistics from a valid config
 */
function calculateStats(config: unknown): ConfigStats {
  const stats: ConfigStats = {
    sourceCount: 0,
    toolCount: 0,
    toolsetCount: 0,
    parameterCount: 0,
  };

  if (typeof config !== "object" || config === null) {
    return stats;
  }

  const configObj = config as Record<string, unknown>;

  // Count sources
  if (configObj.sources && typeof configObj.sources === "object") {
    stats.sourceCount = Object.keys(configObj.sources).length;
  }

  // Count tools and parameters
  if (configObj.tools && typeof configObj.tools === "object") {
    const tools = configObj.tools as Record<string, unknown>;
    stats.toolCount = Object.keys(tools).length;

    // Count parameters
    for (const tool of Object.values(tools)) {
      if (
        typeof tool === "object" &&
        tool !== null &&
        "parameters" in tool &&
        Array.isArray(tool.parameters)
      ) {
        stats.parameterCount += tool.parameters.length;
      }
    }
  }

  // Count toolsets
  if (configObj.toolsets && typeof configObj.toolsets === "object") {
    stats.toolsetCount = Object.keys(configObj.toolsets).length;
  }

  return stats;
}

/**
 * Get all YAML files in a directory recursively
 */
function getYamlFilesInDirectory(dirPath: string): string[] {
  const yamlFiles: string[] = [];
  const resolvedDir = resolve(dirPath);

  function scanDirectory(currentDir: string): void {
    try {
      const entries = readdirSync(currentDir);

      for (const entry of entries) {
        const fullPath = resolve(currentDir, entry);
        const stat = statSync(fullPath);

        if (stat.isDirectory()) {
          scanDirectory(fullPath);
        } else if (
          stat.isFile() &&
          [".yaml", ".yml"].includes(extname(entry).toLowerCase())
        ) {
          yamlFiles.push(fullPath);
        }
      }
    } catch (error) {
      console.warn(
        `⚠️  Warning: Could not scan directory ${currentDir}: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  }

  scanDirectory(resolvedDir);
  return yamlFiles.sort();
}

/**
 * Validate a single YAML file and return detailed results
 */
function validateSingleFile(
  filePath: string,
  ajv: any
): FileValidationResult {
  const startTime = process.hrtime.bigint();
  const absolutePath = resolve(filePath);
  const relativePath = relative(process.cwd(), absolutePath);

  try {
    // Read and parse YAML
    const yamlContent = readFileSync(absolutePath, "utf-8");
    const config = yaml.load(yamlContent);

    // Validate against schema
    const validationResult = validateAgainstSchema(config, ajv);

    const endTime = process.hrtime.bigint();
    const processingTime = Number(endTime - startTime) / 1_000_000; // Convert to milliseconds

    const stats = validationResult.success
      ? calculateStats(config)
      : undefined;

    return {
      filePath: absolutePath,
      relativePath,
      isValid: validationResult.success,
      errors: validationResult.errors,
      processingTime,
      stats,
      config: validationResult.success ? config : undefined,
    };
  } catch (error) {
    const endTime = process.hrtime.bigint();
    const processingTime = Number(endTime - startTime) / 1_000_000;

    return {
      filePath: absolutePath,
      relativePath,
      isValid: false,
      errors: [
        error instanceof Error ? error.message : "Unknown validation error",
      ],
      processingTime,
    };
  }
}

/**
 * Generate a comprehensive validation summary
 */
function generateValidationSummary(
  results: FileValidationResult[]
): ValidationSummary {
  let totalSources = 0;
  let totalTools = 0;
  let totalToolsets = 0;
  let totalParameters = 0;
  const errorMap: Record<string, number> = {};

  for (const result of results) {
    if (result.stats) {
      totalSources += result.stats.sourceCount;
      totalTools += result.stats.toolCount;
      totalToolsets += result.stats.toolsetCount;
      totalParameters += result.stats.parameterCount;
    }

    if (!result.isValid) {
      for (const error of result.errors) {
        const normalizedError = error.split(":")[0].trim(); // Get error type
        errorMap[normalizedError] = (errorMap[normalizedError] || 0) + 1;
      }
    }
  }

  // Get most common errors (top 5)
  const commonErrors = Object.entries(errorMap)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([error, count]) => `${error} (${count} occurrences)`);

  return {
    totalSources,
    totalTools,
    totalToolsets,
    totalParameters,
    commonErrors,
  };
}

/**
 * Perform cross-reference validation across all valid configurations
 * Validates that:
 * 1. All tools reference sources that exist (across all files)
 * 2. All toolsets reference tools that exist (across all files)
 */
function validateCrossReferences(
  validResults: FileValidationResult[]
): CrossReferenceValidationResult {
  const errors: string[] = [];

  // Aggregate all sources, tools, and toolsets from valid configs
  const allSources = new Set<string>();
  const allTools = new Set<string>();
  const allToolsets: Record<string, { tools: string[]; file: string }> = {};

  // First pass: collect all sources and tools
  for (const result of validResults) {
    const config = result.config;
    if (!config) continue;

    // Collect sources
    if (config.sources && typeof config.sources === "object") {
      Object.keys(config.sources).forEach((sourceName) =>
        allSources.add(sourceName)
      );
    }

    // Collect tools
    if (config.tools && typeof config.tools === "object") {
      Object.keys(config.tools).forEach((toolName) => allTools.add(toolName));
    }

    // Collect toolsets
    if (config.toolsets && typeof config.toolsets === "object") {
      Object.entries(config.toolsets).forEach(([toolsetName, toolset]) => {
        if (
          typeof toolset === "object" &&
          toolset !== null &&
          "tools" in toolset &&
          Array.isArray(toolset.tools)
        ) {
          allToolsets[toolsetName] = {
            tools: toolset.tools,
            file: result.relativePath,
          };
        }
      });
    }
  }

  // Second pass: validate tool source references
  for (const result of validResults) {
    const config = result.config;
    if (!config || !config.tools) continue;

    Object.entries(config.tools).forEach(([toolName, tool]) => {
      if (
        typeof tool === "object" &&
        tool !== null &&
        "source" in tool &&
        typeof tool.source === "string"
      ) {
        if (!allSources.has(tool.source)) {
          errors.push(
            `[${result.relativePath}] Tool '${toolName}' references unknown source '${tool.source}'. ` +
              `Available sources: ${allSources.size > 0 ? Array.from(allSources).join(", ") : "none"}`
          );
        }
      }
    });
  }

  // Third pass: validate toolset tool references
  Object.entries(allToolsets).forEach(([toolsetName, toolsetInfo]) => {
    toolsetInfo.tools.forEach((toolName) => {
      if (!allTools.has(toolName)) {
        errors.push(
          `[${toolsetInfo.file}] Toolset '${toolsetName}' references unknown tool '${toolName}'. ` +
            `Available tools: ${allTools.size > 0 ? Array.from(allTools).join(", ") : "none"}`
        );
      }
    });
  });

  return {
    isValid: errors.length === 0,
    errors,
  };
}

/**
 * Format and display validation results
 */
function displayResults(report: ValidationReport, verbose: boolean): void {
  const { totalFiles, validFiles, invalidFiles, files, summary } = report;

  // Header
  console.log("\n📋 YAML Configuration Validation Report");
  console.log("═".repeat(50));

  // Overall statistics
  const successRate =
    totalFiles > 0 ? ((validFiles / totalFiles) * 100).toFixed(1) : "0.0";
  console.log(`\n📊 Overall Results:`);
  console.log(`   Total files processed: ${totalFiles}`);
  console.log(`   ✅ Valid configurations: ${validFiles}`);
  console.log(`   ❌ Invalid configurations: ${invalidFiles}`);
  console.log(`   📈 Success rate: ${successRate}%`);

  // Configuration summary for valid files
  if (validFiles > 0) {
    console.log(`\n🔧 Configuration Summary:`);
    console.log(`   Total sources defined: ${summary.totalSources}`);
    console.log(`   Total tools defined: ${summary.totalTools}`);
    console.log(`   Total toolsets defined: ${summary.totalToolsets}`);
    console.log(`   Total parameters defined: ${summary.totalParameters}`);
  }

  // Common errors
  if (summary.commonErrors.length > 0) {
    console.log(`\n🚨 Most Common Errors:`);
    summary.commonErrors.forEach((error, index) => {
      console.log(`   ${index + 1}. ${error}`);
    });
  }

  // Cross-reference validation errors
  if (report.crossReferenceErrors && report.crossReferenceErrors.length > 0) {
    console.log(`\n🔗 Cross-Reference Validation Errors:`);
    report.crossReferenceErrors.forEach((error) => {
      console.log(`   ❌ ${error}`);
    });
  }

  // Detailed file results
  console.log(`\n📄 File Validation Results:`);
  files.forEach((fileResult) => {
    const status = fileResult.isValid ? "✅" : "❌";
    const timeStr = fileResult.processingTime.toFixed(2);
    console.log(`   ${status} ${fileResult.relativePath} (${timeStr}ms)`);

    // Show errors for invalid files
    if (!fileResult.isValid) {
      fileResult.errors.forEach((error) => {
        console.log(`      ❌ ${error}`);
      });
    }

    // Show stats for valid files
    if (fileResult.isValid && fileResult.stats) {
      const stats = fileResult.stats;
      console.log(
        `      📊 Sources: ${stats.sourceCount}, Tools: ${stats.toolCount}, Toolsets: ${stats.toolsetCount}, Parameters: ${stats.parameterCount}`
      );
    }

    // Verbose mode can be extended here for more details
    if (verbose && fileResult.isValid) {
      console.log(`      ℹ️  Validation completed successfully`);
    }
  });

  // Footer with recommendations
  console.log("\n💡 Recommendations:");
  if (invalidFiles > 0) {
    console.log(
      "   • Fix validation errors in invalid files before deployment"
    );
    console.log("   • Review the JSON schema for expected structure");
  }
  if (report.crossReferenceErrors && report.crossReferenceErrors.length > 0) {
    console.log(
      "   • Fix cross-reference errors (tools referencing non-existent sources or toolsets referencing non-existent tools)"
    );
    console.log(
      "   • Ensure all referenced sources are defined in at least one configuration file"
    );
    console.log(
      "   • Ensure all tools referenced by toolsets exist in at least one configuration file"
    );
  }
  if (
    validFiles > 0 &&
    (!report.crossReferenceErrors || report.crossReferenceErrors.length === 0)
  ) {
    console.log("   • Valid configurations are ready for use");
  }
  console.log(
    "   • Run this script regularly during development to catch issues early"
  );
  console.log("═".repeat(50));
}

/**
 * Main execution function
 */
async function main(): Promise<void> {
  const args = parseCliArgs();

  if (args.help) {
    showHelp();
    return;
  }

  if (!args.tools && !args.toolsDir) {
    console.error("❌ Error: You must specify either --tools or --tools-dir");
    showHelp();
    process.exit(1);
  }

  if (args.tools && args.toolsDir) {
    console.error(
      "❌ Error: Cannot specify both --tools and --tools-dir at the same time"
    );
    process.exit(1);
  }

  console.log("🔍 Starting YAML configuration validation...\n");

  try {
    // Load JSON schema
    const schema = loadJsonSchema();
    const ajvConstructor: any = Ajv;
    const ajv = new ajvConstructor({ strict: false, allErrors: true });
    ajv.addSchema(schema);

    let filesToValidate: string[] = [];

    if (args.tools) {
      const resolvedPath = resolve(args.tools);
      filesToValidate = [resolvedPath];
      console.log(
        `📁 Validating single file: ${relative(process.cwd(), resolvedPath)}`
      );
    } else if (args.toolsDir) {
      const resolvedDir = resolve(args.toolsDir);
      filesToValidate = getYamlFilesInDirectory(resolvedDir);
      console.log(
        `📁 Validating directory: ${relative(process.cwd(), resolvedDir)}`
      );
      console.log(`📄 Found ${filesToValidate.length} YAML file(s)`);
    }

    if (filesToValidate.length === 0) {
      console.log("ℹ️  No YAML files found to validate");
      return;
    }

    // Validate all files
    const results = filesToValidate.map((file) =>
      validateSingleFile(file, ajv)
    );

    // Perform cross-reference validation on valid files
    const validResults = results.filter((r) => r.isValid);
    const crossRefValidation = validateCrossReferences(validResults);

    // Generate report
    const report: ValidationReport = {
      totalFiles: results.length,
      validFiles: results.filter((r) => r.isValid).length,
      invalidFiles: results.filter((r) => !r.isValid).length,
      files: results,
      summary: generateValidationSummary(results),
      crossReferenceErrors: crossRefValidation.errors,
    };

    // Display results
    displayResults(report, args.verbose);

    // Set appropriate exit code
    // Exit with error if there are invalid files OR cross-reference errors
    const exitCode =
      report.invalidFiles > 0 || !crossRefValidation.isValid ? 1 : 0;
    process.exit(exitCode);
  } catch (error) {
    console.error(
      `❌ Validation failed: ${error instanceof Error ? error.message : "Unknown error"}`
    );
    process.exit(1);
  }
}

// Execute main function
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(
      `❌ Unexpected error: ${error instanceof Error ? error.message : "Unknown error"}`
    );
    process.exit(1);
  });
}

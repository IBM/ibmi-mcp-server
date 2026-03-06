/**
 * @fileoverview Central output controller for the IBM i CLI.
 * Handles TTY detection, format routing, and consistent output rendering.
 *
 * Supports two JSON output modes:
 * - **Envelope** (default): `{ok, system, host, command, data, meta}` — full result in one object
 * - **NDJSON** (--stream): One JSON object per row, newline-delimited — for piped workflows
 *
 * @module cli/formatters/output
 */

import { writeFileSync } from "fs";
import { tableFormatter } from "@/utils/formatting/tableFormatter.js";
import type { OutputFormat, ResolvedSystem } from "../config/types.js";
import {
  classifyError,
  type ErrorCodeValue,
} from "../utils/exit-codes.js";

/** Module-level output file path set by --output global option. */
let outputFilePath: string | undefined;
let outputBuffer: string[] | undefined;

/**
 * Set the output file path. When set, all output is buffered and written
 * to the file on `finalizeOutput()`.
 */
export function setOutputFile(filePath: string | undefined): void {
  outputFilePath = filePath;
  outputBuffer = filePath ? [] : undefined;
}

/**
 * Finalize file output — write buffered content to file and print confirmation to stderr.
 */
export function finalizeOutput(): void {
  if (outputBuffer && outputFilePath) {
    writeFileSync(outputFilePath, outputBuffer.join(""), "utf-8");
    process.stderr.write(`Output written to ${outputFilePath}\n`);
    outputBuffer = undefined;
    outputFilePath = undefined;
  }
}

/** Write to the current output destination (file buffer or stdout). */
function writeOutput(data: string): void {
  if (outputBuffer) {
    outputBuffer.push(data);
  } else {
    process.stdout.write(data);
  }
}

/** Result metadata for output rendering. */
export interface OutputMeta {
  /** Number of rows returned. */
  rowCount: number;
  /** Whether more rows exist beyond the current result. */
  hasMore?: boolean;
  /** Time taken for the query in milliseconds. */
  elapsedMs?: number;
  /** The resolved system used for this command. */
  system?: ResolvedSystem;
  /** The command name (e.g., "schemas", "sql", "tool:system_status"). */
  command?: string;
}

/**
 * Detect the appropriate output format based on environment.
 * TTY → table, piped → json.
 */
export function detectFormat(
  explicitFormat?: OutputFormat,
  raw?: boolean,
): OutputFormat {
  if (raw) return "json";
  if (explicitFormat) return explicitFormat;
  return process.stdout.isTTY ? "table" : "json";
}

/**
 * Render query results to stdout in the specified format.
 */
export function renderOutput(
  data: Record<string, unknown>[],
  format: OutputFormat,
  meta?: OutputMeta,
): void {
  switch (format) {
    case "json":
      renderJson(data, meta);
      break;
    case "csv":
      renderCsv(data);
      break;
    case "markdown":
      renderTable(data, "markdown", meta);
      break;
    case "table":
    default:
      renderTable(data, "grid", meta);
      break;
  }
}

/**
 * Render results as NDJSON (newline-delimited JSON) for streaming.
 * Each row is a separate JSON object on its own line.
 * Agents and tools like `jq` can process rows incrementally.
 */
export function renderNdjson(
  data: Record<string, unknown>[],
): void {
  for (const row of data) {
    writeOutput(JSON.stringify(row) + "\n");
  }
}

/**
 * Render as JSON envelope to stdout.
 */
function renderJson(
  data: Record<string, unknown>[],
  meta?: OutputMeta,
): void {
  const output = {
    ok: true,
    ...(meta?.system ? { system: meta.system.name, host: meta.system.config.host } : {}),
    ...(meta?.command ? { command: meta.command } : {}),
    data,
    meta: {
      rows: meta?.rowCount ?? data.length,
      hasMore: meta?.hasMore ?? false,
      ...(meta?.elapsedMs !== undefined ? { elapsed_ms: meta.elapsedMs } : {}),
    },
  };
  writeOutput(JSON.stringify(output, null, 2) + "\n");
}

/**
 * Render as CSV to stdout.
 */
function renderCsv(data: Record<string, unknown>[]): void {
  if (data.length === 0) return;

  const headers = Object.keys(data[0]!);

  // Header row
  writeOutput(headers.map(escapeCsvField).join(",") + "\n");

  // Data rows
  for (const row of data) {
    const values = headers.map((h) => {
      const val = row[h];
      return val === null || val === undefined ? "" : String(val);
    });
    writeOutput(values.map(escapeCsvField).join(",") + "\n");
  }
}

function escapeCsvField(field: string): string {
  if (field.includes(",") || field.includes('"') || field.includes("\n")) {
    return `"${field.replace(/"/g, '""')}"`;
  }
  return field;
}

/**
 * Render as a formatted table to stdout.
 */
function renderTable(
  data: Record<string, unknown>[],
  style: "grid" | "markdown",
  meta?: OutputMeta,
): void {
  if (data.length === 0) {
    writeOutput("No results.\n");
    return;
  }

  const table = tableFormatter.format(data, { style, headerStyle: "uppercase" });
  writeOutput(table + "\n");

  // Footer with metadata
  const parts: string[] = [];
  if (meta?.system) {
    parts.push(`[${meta.system.name}] ${meta.system.config.host}`);
  }
  if (meta?.rowCount !== undefined) {
    parts.push(`${meta.rowCount} row${meta.rowCount !== 1 ? "s" : ""}`);
  }
  if (meta?.hasMore) {
    parts.push("(more available — use --limit/--offset)");
  }
  if (meta?.elapsedMs !== undefined) {
    parts.push(`${(meta.elapsedMs / 1000).toFixed(2)}s`);
  }

  if (parts.length > 0) {
    writeOutput(parts.join(" · ") + "\n");
  }
}

/**
 * Render an error to stderr. In JSON mode, outputs structured error JSON to stdout
 * with an error code for programmatic consumption.
 */
export function renderError(
  error: Error,
  format: OutputFormat,
  system?: ResolvedSystem,
  errorCode?: ErrorCodeValue,
): void {
  if (format === "json") {
    const classified = classifyError(error);
    const output = {
      ok: false,
      ...(system ? { system: system.name } : {}),
      error: {
        code: errorCode ?? classified.errorCode,
        message: error.message,
      },
    };
    writeOutput(JSON.stringify(output, null, 2) + "\n");
  } else {
    process.stderr.write(`Error: ${error.message}\n`);
  }
}

/**
 * Render a simple message to stdout (e.g., success confirmation).
 */
export function renderMessage(
  message: string,
  format: OutputFormat,
): void {
  if (format === "json") {
    writeOutput(JSON.stringify({ ok: true, message }) + "\n");
  } else {
    writeOutput(message + "\n");
  }
}

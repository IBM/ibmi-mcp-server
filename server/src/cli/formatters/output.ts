/**
 * @fileoverview Central output controller for the IBM i CLI.
 * Handles TTY detection, format routing, and consistent output rendering.
 * @module cli/formatters/output
 */

import { tableFormatter } from "@/utils/formatting/tableFormatter.js";
import type { OutputFormat, ResolvedSystem } from "../config/types.js";

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
 * Render as JSON to stdout.
 */
function renderJson(
  data: Record<string, unknown>[],
  meta?: OutputMeta,
): void {
  const output = {
    ok: true,
    ...(meta?.system ? { system: meta.system.name, host: meta.system.config.host } : {}),
    data,
    meta: {
      rows: meta?.rowCount ?? data.length,
      hasMore: meta?.hasMore ?? false,
      ...(meta?.elapsedMs !== undefined ? { elapsed_ms: meta.elapsedMs } : {}),
    },
  };
  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
}

/**
 * Render as CSV to stdout.
 */
function renderCsv(data: Record<string, unknown>[]): void {
  if (data.length === 0) return;

  const headers = Object.keys(data[0]!);

  // Header row
  process.stdout.write(headers.map(escapeCsvField).join(",") + "\n");

  // Data rows
  for (const row of data) {
    const values = headers.map((h) => {
      const val = row[h];
      return val === null || val === undefined ? "" : String(val);
    });
    process.stdout.write(values.map(escapeCsvField).join(",") + "\n");
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
    process.stdout.write("No results.\n");
    return;
  }

  const table = tableFormatter.format(data, { style, headerStyle: "uppercase" });
  process.stdout.write(table + "\n");

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
    process.stdout.write(parts.join(" · ") + "\n");
  }
}

/**
 * Render an error to stderr. In JSON mode, outputs structured error JSON to stdout.
 */
export function renderError(
  error: Error,
  format: OutputFormat,
  system?: ResolvedSystem,
): void {
  if (format === "json") {
    const output = {
      ok: false,
      ...(system ? { system: system.name } : {}),
      error: {
        message: error.message,
      },
    };
    process.stdout.write(JSON.stringify(output, null, 2) + "\n");
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
    process.stdout.write(JSON.stringify({ ok: true, message }) + "\n");
  } else {
    process.stdout.write(message + "\n");
  }
}

/**
 * @fileoverview SQL formatting utilities for database result presentation.
 * Provides type-aware formatting helpers for SQL results, including column alignment
 * and type indicators.
 * @module src/utils/formatting/sqlFormattingUtils
 */

import type { Alignment } from "./tableFormatter.js";

/**
 * IBM i DB2 numeric data types that should be right-aligned in tables.
 * @private
 */
const NUMERIC_TYPES = new Set([
  "INTEGER",
  "SMALLINT",
  "BIGINT",
  "DECIMAL",
  "NUMERIC",
  "FLOAT",
  "REAL",
  "DOUBLE",
  "DECFLOAT",
  "INT",
  "DEC",
]);

/**
 * IBM i DB2 text data types that should be left-aligned in tables.
 * @private
 */
const TEXT_TYPES = new Set([
  "VARCHAR",
  "CHAR",
  "CHARACTER",
  "CLOB",
  "VARGRAPHIC",
  "GRAPHIC",
  "DBCLOB",
  "BLOB",
  "BINARY",
  "VARBINARY",
]);

/**
 * IBM i DB2 temporal data types that should be left-aligned in tables.
 * @private
 */
const TEMPORAL_TYPES = new Set(["DATE", "TIME", "TIMESTAMP", "TIMESTMP"]);

/**
 * Determine the appropriate column alignment based on IBM i DB2 data type.
 * Numeric types are right-aligned for better visual comparison,
 * while text and temporal types are left-aligned.
 *
 * @param columnType - The database column type (e.g., 'INTEGER', 'VARCHAR')
 * @returns The recommended alignment for this column type
 *
 * @example
 * ```typescript
 * getColumnAlignment('INTEGER');    // 'right'
 * getColumnAlignment('VARCHAR');    // 'left'
 * getColumnAlignment('TIMESTAMP');  // 'left'
 * getColumnAlignment('UNKNOWN');    // 'left' (default)
 * ```
 */
export function getColumnAlignment(columnType: string | undefined): Alignment {
  if (!columnType) {
    return "left"; // Default for unknown types
  }

  // Normalize type name (uppercase, remove precision/scale info)
  const normalizedType = columnType.toUpperCase().split("(")[0]!.trim();

  // Check type categories
  if (NUMERIC_TYPES.has(normalizedType)) {
    return "right";
  }

  if (TEXT_TYPES.has(normalizedType) || TEMPORAL_TYPES.has(normalizedType)) {
    return "left";
  }

  // Default to left alignment for unknown types
  return "left";
}

/**
 * Format a column header with type indicator.
 * Appends the data type in parentheses for LLM clarity.
 *
 * @param columnName - The column name
 * @param columnType - The database column type (optional)
 * @returns Formatted header string
 *
 * @example
 * ```typescript
 * formatColumnHeader('EMPLOYEE_ID', 'INTEGER');
 * // Returns: 'EMPLOYEE_ID (INTEGER)'
 *
 * formatColumnHeader('NAME', 'VARCHAR(50)');
 * // Returns: 'NAME (VARCHAR)'
 *
 * formatColumnHeader('STATUS');
 * // Returns: 'STATUS'
 * ```
 */
export function formatColumnHeader(
  columnName: string,
  columnType?: string,
): string {
  if (!columnType) {
    return columnName;
  }

  // Extract base type without precision/scale
  const baseType = columnType.split("(")[0]!.trim().toUpperCase();
  return `${columnName} (${baseType})`;
}

/**
 * Build a column alignment map for use with TableFormatter.
 * Maps column names to their appropriate alignment based on their data types.
 *
 * @param columns - Array of column definitions with name and type
 * @returns Record mapping column names to alignment values
 *
 * @example
 * ```typescript
 * const columns = [
 *   { name: 'ID', type: 'INTEGER' },
 *   { name: 'NAME', type: 'VARCHAR' },
 *   { name: 'SALARY', type: 'DECIMAL' }
 * ];
 *
 * buildColumnAlignmentMap(columns);
 * // Returns: { ID: 'right', NAME: 'left', SALARY: 'right' }
 * ```
 */
export function buildColumnAlignmentMap(
  columns: Array<{ name: string; type?: string }>,
): Record<string, Alignment> {
  const alignmentMap: Record<string, Alignment> = {};

  for (const column of columns) {
    alignmentMap[column.name] = getColumnAlignment(column.type);
  }

  return alignmentMap;
}

/**
 * @fileoverview SQL formatting utilities for database result presentation.
 * Provides the type indicator shown in SQL result column headers.
 * @module src/utils/formatting/sqlFormattingUtils
 */

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

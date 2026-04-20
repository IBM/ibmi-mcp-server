/**
 * @fileoverview Security validation types and constants for SQL query validation
 * Centralized configuration for dangerous operations and patterns
 *
 * @module src/services/securityValidation
 */

/**
 * Dangerous SQL operations that should be blocked in read-only mode
 */
export const DANGEROUS_OPERATIONS = [
  // Data manipulation
  "INSERT",
  "UPDATE",
  "DELETE",
  "REPLACE",
  "MERGE",
  "TRUNCATE",
  // Schema operations
  "DROP",
  "CREATE",
  "ALTER",
  "RENAME",
  // System operations
  "CALL",
  "EXEC",
  "EXECUTE",
  "SET",
  "DECLARE",
  // Security operations
  "GRANT",
  "REVOKE",
  "DENY",
  // Data transfer
  "LOAD",
  "IMPORT",
  "EXPORT",
  "BULK",
  // System control
  "SHUTDOWN",
  "RESTART",
  "KILL",
  "STOP",
  "START",
  // Backup/restore
  "BACKUP",
  "RESTORE",
  "DUMP",
  // Locking
  "LOCK",
  "UNLOCK",
  // Transaction control (in some contexts dangerous)
  "COMMIT",
  "ROLLBACK",
  "SAVEPOINT",
  // IBM i specific
  "QCMDEXC",
  "SQL_EXECUTE_IMMEDIATE",
] as const;

/**
 * Dangerous SQL functions that should be blocked
 */
export const DANGEROUS_FUNCTIONS = [
  "SYSTEM",
  "QCMDEXC",
  "SQL_EXECUTE_IMMEDIATE",
  "SQLCMD",
  "LOAD_EXTENSION",
  "EXEC",
  "EXECUTE_IMMEDIATE",
  "EVAL",
  "CONCAT",
  "CHAR",
  "VARCHAR", // Can be used for dynamic SQL construction
] as const;

/**
 * Regex patterns for detecting dangerous SQL constructs
 */
export const DANGEROUS_PATTERNS = [
  // Dynamic SQL patterns
  /\bCONCAT\s*\(/i,
  /\b(CHAR|VARCHAR|CLOB)\s*\(/i,
  // System function patterns
  /\bSYSTEM\s*\(/i,
  /\bLOAD_EXTENSION\s*\(/i,
  /\bQCMDEXC\s*\(/i,
  // Comment-based bypass attempts
  /\/\*.*?(DROP|DELETE|INSERT|UPDATE).*?\*\//i,
  // Multiple statement patterns
  /;\s*(DROP|DELETE|INSERT|UPDATE|CREATE|ALTER)/i,
  // Union-based attacks
  /\bUNION\s+(ALL\s+)?\s*\(\s*(DROP|DELETE|INSERT|UPDATE)/i,
] as const;

/**
 * Type for dangerous operations
 */
export type DangerousOperation = (typeof DANGEROUS_OPERATIONS)[number];

/**
 * Type for dangerous functions
 */
export type DangerousFunction = (typeof DANGEROUS_FUNCTIONS)[number];

/**
 * Security validation result
 */
export interface SecurityValidationResult {
  isValid: boolean;
  violations: string[];
  validationMethod: "ast" | "regex" | "both";
}

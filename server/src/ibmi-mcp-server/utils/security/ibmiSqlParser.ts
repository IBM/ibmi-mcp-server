/**
 * @fileoverview IBM i-aware SQL Parser using vscode-db2i's SQL language module
 * Handles IBM i-specific SQL syntax that standard parsers don't support
 *
 * @module src/ibmi-mcp-server/utils/security/ibmiSqlParser
 */

import { logger } from "@/utils/internal/logger.js";
import { RequestContext } from "@/utils/internal/requestContext.js";
import Document from "@/ibmi-mcp-server/utils/language/document.js";
import { StatementType } from "@/ibmi-mcp-server/utils/language/types.js";

/**
 * Parse result from IBM i SQL parser
 */
export interface IbmiParseResult {
  success: boolean;
  isReadOnly: boolean;
  statementTypes: string[];
  hasIbmiFeatures: boolean;
  violations: string[];
  error?: string;
}

/**
 * IBM i-specific SQL features that indicate advanced queries
 */
const IBMI_READ_ONLY_PATTERNS = {
  // TABLE() function - used to invoke table-valued functions
  TABLE_FUNCTION: /\bTABLE\s*\(/i,

  // LATERAL join - modern SQL feature for correlated table expressions
  LATERAL_JOIN: /\bLATERAL\s+/i,

  // Named parameters using => (IBM i syntax)
  NAMED_PARAMETERS: /\w+\s*=>\s*['"\w]/i,

  // JSON_TABLE function (often used with LATERAL)
  JSON_TABLE: /\bJSON_TABLE\s*\(/i,

  // XMLTABLE function
  XML_TABLE: /\bXMLTABLE\s*\(/i,
} as const;

/**
 * Dangerous SQL functions that should be blocked
 */
const DANGEROUS_FUNCTIONS = [
  "SYSTEM",
  "QCMDEXC",
  "SQL_EXECUTE_IMMEDIATE",
  "SQLCMD",
  "LOAD_EXTENSION",
  "EXEC",
  "EXECUTE_IMMEDIATE",
  "EVAL",
] as const;

/**
 * IBM i-aware SQL parser using vscode-db2i's Document class
 */
export class IbmiSqlParser {
  /**
   * Parse and validate SQL query for IBM i
   *
   * @param query - SQL query to parse
   * @param context - Request context for logging
   * @returns Parse result with read-only validation
   */
  static parseQuery(query: string, context: RequestContext): IbmiParseResult {
    try {
      // Parse query using vscode-db2i's Document class
      const document = new Document(query);

      // Detect IBM i-specific features
      const hasIbmiFeatures = this.hasIbmiFeatures(query);

      // Extract statement types from parsed statements
      const statementTypes = document.statements.map(
        (stmt) => StatementType[stmt.type] || "Unknown",
      );

      // Check for write operations by analyzing statement types
      const violations = this.detectWriteOperations(document);

      // Check for dangerous functions in all statements
      violations.push(...this.detectDangerousFunctions(document));

      // Determine if query is read-only
      const isReadOnly = violations.length === 0;

      logger.debug(
        {
          ...context,
          hasIbmiFeatures,
          statementTypes,
          isReadOnly,
          violationCount: violations.length,
          statementCount: document.statements.length,
        },
        "IBM i SQL parsed successfully with vscode-db2i parser",
      );

      return {
        success: true,
        isReadOnly,
        statementTypes,
        hasIbmiFeatures,
        violations,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      logger.debug(
        {
          ...context,
          error: errorMessage,
        },
        "vscode-db2i parsing failed - will fall back to other validators",
      );

      return {
        success: false,
        isReadOnly: false,
        statementTypes: [],
        hasIbmiFeatures: false,
        violations: ["Parse error"],
        error: errorMessage,
      };
    }
  }

  /**
   * Check if query uses IBM i-specific features
   *
   * @param query - SQL query
   * @returns True if IBM i features detected
   */
  private static hasIbmiFeatures(query: string): boolean {
    return (
      IBMI_READ_ONLY_PATTERNS.TABLE_FUNCTION.test(query) ||
      IBMI_READ_ONLY_PATTERNS.LATERAL_JOIN.test(query) ||
      IBMI_READ_ONLY_PATTERNS.NAMED_PARAMETERS.test(query) ||
      IBMI_READ_ONLY_PATTERNS.JSON_TABLE.test(query) ||
      IBMI_READ_ONLY_PATTERNS.XML_TABLE.test(query)
    );
  }

  /**
   * Detect write operations by analyzing statement types
   *
   * @param document - Parsed SQL document
   * @returns Array of violation messages
   */
  private static detectWriteOperations(document: Document): string[] {
    const violations: string[] = [];

    for (const statement of document.statements) {
      const stmtType = statement.type;

      // Check if statement type is a write operation
      if (this.isWriteOperation(stmtType)) {
        violations.push(
          `Write operation detected: ${StatementType[stmtType] || "Unknown"}`,
        );
      }
    }

    return violations;
  }

  /**
   * Determine if a statement type is a write operation
   *
   * @param type - Statement type enum value
   * @returns True if the statement modifies data
   */
  private static isWriteOperation(type: StatementType): boolean {
    // Only SELECT and WITH (CTE) are read-only
    // All other statement types (including CALL) are write operations
    const readOnlyTypes = [StatementType.Select, StatementType.With];

    return !readOnlyTypes.includes(type);
  }

  /**
   * Detect dangerous functions in SQL statements using token analysis
   *
   * @param document - Parsed SQL document
   * @returns Array of violation messages for dangerous functions found
   */
  private static detectDangerousFunctions(document: Document): string[] {
    const violations: string[] = [];

    for (const statement of document.statements) {
      const tokens = statement.tokens || [];

      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (!token || !token.value) continue;

        const tokenValue = token.value.toUpperCase();

        // Check if this token is a dangerous function
        // Look for function pattern: FUNCTION_NAME followed by (
        if ((DANGEROUS_FUNCTIONS as readonly string[]).includes(tokenValue)) {
          // Check if next token is an open parenthesis (indicates function call)
          const nextToken = tokens[i + 1];
          if (nextToken && nextToken.type === "openbracket") {
            violations.push(`Dangerous function: ${tokenValue}`);
          }
        }
      }
    }

    return violations;
  }
}

// Re-export StatementType for convenience
export { StatementType } from "@/ibmi-mcp-server/utils/language/types.js";

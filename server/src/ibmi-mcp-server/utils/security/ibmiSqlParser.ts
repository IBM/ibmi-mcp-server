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
  violations: string[];
  error?: string;
}

export const readOnlyTypes = [StatementType.Select, StatementType.With];

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

      // Extract statement types from parsed statements
      const statementTypes = document.statements.map(
        (stmt) => StatementType[stmt.type] || "Unknown",
      );

      // Check for write operations by analyzing statement types
      const violations = this.detectWriteOperations(document);

      // Determine if query is read-only
      const isReadOnly = violations.length === 0;

      logger.debug(
        {
          ...context,
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
        violations: ["Parse error"],
        error: errorMessage,
      };
    }
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
    // TODO: Consider refining this logic if certain CALL statements are allowed
    return !readOnlyTypes.includes(type);
  }
}

// Re-export StatementType for convenience
export { StatementType } from "@/ibmi-mcp-server/utils/language/types.js";

/**
 * @fileoverview IBM i-aware SQL Parser using vscode-db2i's SQL language module
 * Handles IBM i-specific SQL syntax that standard parsers don't support
 *
 * @module src/ibmi-mcp-server/utils/security/ibmiSqlParser
 */

import { logger } from '@/utils/internal/logger.js';
import { RequestContext } from '@/utils/internal/requestContext.js';
import Document from '@/ibmi-mcp-server/utils/language/document.js';
import { StatementType } from '@/ibmi-mcp-server/utils/language/types.js';
import Statement from '../language/statement.js';

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
      const statementTypes = document.statements.map((stmt) =>
        StatementType[stmt.type] || 'Unknown'
      );

      // Check for write operations by analyzing statement types
      const violations = this.detectWriteOperations(document);

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
        'IBM i SQL parsed successfully with vscode-db2i parser'
      );

      return {
        success: true,
        isReadOnly,
        statementTypes,
        hasIbmiFeatures,
        violations,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.debug(
        {
          ...context,
          error: errorMessage,
        },
        'vscode-db2i parsing failed - will fall back to other validators'
      );

      return {
        success: false,
        isReadOnly: false,
        statementTypes: [],
        hasIbmiFeatures: false,
        violations: ['Parse error'],
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

      // Special handling for CALL statements - check if calling safe IBM i system procedures
      if (stmtType === StatementType.Call) {
        if (!this.isReadOnlyCallStatement(statement)) {
          violations.push(
            `Write operation detected: CALL statement to non-system procedure`
          );
        }
        // If it's a read-only CALL, don't add violation
        continue;
      }

      // Check if statement type is a write operation
      if (this.isWriteOperation(stmtType)) {
        violations.push(
          `Write operation detected: ${StatementType[stmtType] || 'Unknown'}`
        );
      }
    }

    return violations;
  }

  /**
   * Determine if a CALL statement is calling a read-only IBM i system procedure
   *
   * @param statement - Statement object from parser
   * @returns True if calling a safe read-only system procedure
   */
  private static isReadOnlyCallStatement(statement: Statement): boolean {
    try {
      // Get the tokens from the statement to find what's being called
      const tokens = statement.tokens || [];

      // Look for QSYS2 or SYSTOOLS schema references
      // These are IBM i system catalog schemas with read-only procedures
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (token && token.value) {
          const value = token.value.toUpperCase();

          // Check if calling QSYS2.* or SYSTOOLS.* procedures
          if (value === 'QSYS2' || value === 'SYSTOOLS' || value === 'QSYS') {
            return true;
          }

          // Also check for qualified names like QSYS2.PROCEDURE_NAME
          if (value.startsWith('QSYS2.') || value.startsWith('SYSTOOLS.') || value.startsWith('QSYS.')) {
            return true;
          }
        }
      }

      return false;
    } catch {
      // If we can't determine, treat as potentially unsafe
      return false;
    }
  }

  /**
   * Determine if a statement type is a write operation
   *
   * @param type - Statement type enum value
   * @returns True if the statement modifies data
   */
  private static isWriteOperation(type: StatementType): boolean {
    // Only SELECT and WITH (CTE) are read-only
    // All other statement types are potentially write operations
    // Note: CALL is handled separately in detectWriteOperations
    const readOnlyTypes = [StatementType.Select, StatementType.With];

    return !readOnlyTypes.includes(type);
  }
}

// Re-export StatementType for convenience
export { StatementType } from '@/ibmi-mcp-server/utils/language/types.js';

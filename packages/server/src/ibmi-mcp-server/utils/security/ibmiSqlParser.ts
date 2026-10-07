/**
 * @fileoverview IBM i-aware SQL Parser using vscode-db2i's SQL language module
 * Handles IBM i-specific SQL syntax that standard parsers don't support
 *
 * @module src/ibmi-mcp-server/utils/security/ibmiSqlParser
 */

import { logger } from "@/utils/internal/logger.js";
import { RequestContext } from "@/utils/internal/requestContext.js";
import Document from "@/ibmi-mcp-server/utils/language/document.js";
import {
  StatementType,
  Token,
} from "@/ibmi-mcp-server/utils/language/types.js";
import { DANGEROUS_OPERATIONS } from "./sqlSecurityValidator.js";

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
   * Detect write operations by analyzing statement types and dangerous scalar
   * function calls embedded inside otherwise read-only statements.
   *
   * A SELECT that contains QSYS2.QCMDEXC (or any other entry from
   * DANGEROUS_OPERATIONS used as a scalar function) must be treated as a write
   * operation even though its outer statement type is Select.
   *
   * @param document - Parsed SQL document
   * @returns Array of violation messages
   */
  private static detectWriteOperations(document: Document): string[] {
    const violations: string[] = [];

    const dangerousSet = new Set(
      DANGEROUS_OPERATIONS.map((op) => op.toUpperCase()),
    );

    for (const statement of document.statements) {
      const stmtType = statement.type;

      // Check if the outer statement type is a write operation
      if (this.isWriteOperation(stmtType)) {
        violations.push(
          `Write operation detected: ${StatementType[stmtType] || "Unknown"}`,
        );
        continue;
      }

      // Even for read-only statement types (SELECT, WITH), scan every token for
      // dangerous scalar function calls such as QSYS2.QCMDEXC('...').
      // The vscode-db2i tokeniser marks any word immediately followed by '(' as
      // type "function", so QCMDEXC(...) surfaces as { type: "function", value: "QCMDEXC" }.
      const dangerousCall = this.findDangerousScalarCall(
        statement.tokens,
        dangerousSet,
      );
      if (dangerousCall) {
        violations.push(`Write operation '${dangerousCall}' detected`);
      }
    }

    return violations;
  }

  /**
   * Recursively walk tokens (including nested blocks) to find any scalar
   * function call whose name appears in the dangerous-operations set.
   *
   * @param tokens - Token array from a parsed statement
   * @param dangerousSet - Upper-cased set of forbidden operation names
   * @returns The first dangerous function name found, or undefined
   */
  private static findDangerousScalarCall(
    tokens: Token[],
    dangerousSet: Set<string>,
  ): string | undefined {
    for (const [i, token] of tokens.entries()) {
      if (
        token.type === "function" &&
        token.value &&
        dangerousSet.has(token.value.toUpperCase())
      ) {
        return token.value.toUpperCase();
      }

      // The tokeniser only marks unquoted words as "function", so a delimited
      // name such as QSYS2."QCMDEXC"(...) arrives as sqlName + openbracket.
      // Delimited identifiers are case-sensitive, so compare without folding.
      if (
        token.type === "sqlName" &&
        token.value &&
        tokens[i + 1]?.type === "openbracket"
      ) {
        const name = token.value.slice(1, -1);
        if (dangerousSet.has(name)) return name;
      }

      // Recurse into parenthesised blocks (type "block") so nested calls are caught
      if (token.type === "block" && Array.isArray(token.block)) {
        const found = this.findDangerousScalarCall(token.block, dangerousSet);
        if (found) return found;
      }
    }

    return undefined;
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

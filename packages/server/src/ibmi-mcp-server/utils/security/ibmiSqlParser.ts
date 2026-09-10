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
import type { ExecuteSqlAccess } from "@/ibmi-mcp-server/services/executeSqlAccess.js";

/**
 * Parse result from IBM i SQL parser
 */
export interface IbmiParseResult {
  success: boolean;
  /** True when every statement is permitted at the requested access level */
  allowed: boolean;
  statementTypes: string[];
  /** One entry per statement not permitted at the requested access level */
  violations: string[];
  error?: string;
}

/** Statement types permitted in `read` mode. */
export const readTypes: readonly StatementType[] = [
  StatementType.Select,
  StatementType.With,
];

/** Statement types permitted in `read-call` mode. */
export const readCallTypes: readonly StatementType[] = [
  ...readTypes,
  StatementType.Call,
];

/**
 * Statement types permitted at an access level. `undefined` for `write`
 * means every statement type is permitted.
 */
export function allowedTypesFor(
  access: ExecuteSqlAccess,
): readonly StatementType[] | undefined {
  switch (access) {
    case "read":
      return readTypes;
    case "read-call":
      return readCallTypes;
    case "write":
      return undefined;
  }
}

/**
 * IBM i-aware SQL parser using vscode-db2i's Document class
 */
export class IbmiSqlParser {
  /**
   * Parse SQL and check every statement against an access level
   *
   * @param query - SQL query to parse
   * @param context - Request context for logging
   * @param access - Access level to enforce (default `read`)
   * @returns Parse result with per-statement violations
   */
  static parseQuery(
    query: string,
    context: RequestContext,
    access: ExecuteSqlAccess = "read",
  ): IbmiParseResult {
    try {
      // Parse query using vscode-db2i's Document class
      const document = new Document(query);

      // Extract statement types from parsed statements
      const statementTypes = document.statements.map(
        (stmt) => StatementType[stmt.type] || "Unknown",
      );

      const violations = this.detectDisallowedStatements(document, access);
      const allowed = violations.length === 0;

      logger.debug(
        {
          ...context,
          statementTypes,
          access,
          allowed,
          violationCount: violations.length,
          statementCount: document.statements.length,
        },
        "IBM i SQL parsed successfully with vscode-db2i parser",
      );

      return {
        success: true,
        allowed,
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
        allowed: false,
        statementTypes: [],
        violations: ["Parse error"],
        error: errorMessage,
      };
    }
  }

  /**
   * Find statements not permitted at the given access level
   *
   * @param document - Parsed SQL document
   * @param access - Access level to enforce
   * @returns Array of violation messages
   */
  private static detectDisallowedStatements(
    document: Document,
    access: ExecuteSqlAccess,
  ): string[] {
    const allowedTypes = allowedTypesFor(access);
    if (!allowedTypes) return [];

    const violations: string[] = [];
    for (const statement of document.statements) {
      if (!allowedTypes.includes(statement.type)) {
        violations.push(
          `${StatementType[statement.type] || "Unknown"} statement not permitted in ${access} mode`,
        );
      }
    }
    return violations;
  }
}

// Re-export StatementType for convenience
export { StatementType } from "@/ibmi-mcp-server/utils/language/types.js";

/**
 * @fileoverview SQL Security Validator for validating SQL queries against security policies
 * Provides both AST-based and regex-based validation with comprehensive security checks
 *
 * @module src/utils/security/sqlSecurityValidator
 */

import pkg from "node-sql-parser";
const { Parser } = pkg;
import { logger } from "@/utils/internal/logger.js";
import { RequestContext } from "@/utils/internal/requestContext.js";
import { JsonRpcErrorCode, McpError } from "@/types-global/errors.js";
import { SqlToolSecurityConfig } from "../../schemas/index.js";

/**
 * Security validation result
 */
export interface SecurityValidationResult {
  /** Whether the validation passed */
  isValid: boolean;
  /** List of security violations found */
  violations: string[];
  /** Validation method used */
  validationMethod: "ast" | "regex" | "combined";
}

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
 * Dangerous SQL functions that should be monitored/blocked
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
  // Removed: CONCAT, CHAR, VARCHAR - these are benign functions with high false-positive rates
  // They are not execution primitives and don't represent security risks
] as const;

/**
 * Dangerous SQL patterns that should be detected
 */
export const DANGEROUS_PATTERNS = [
  // Removed: CONCAT and CHAR/VARCHAR/CLOB patterns - benign functions with high false-positive rates
  // System function patterns
  /\bSYSTEM\s*\(/i,
  /\bLOAD_EXTENSION\s*\(/i,
  /\bQCMDEXC\s*\(/i,
  // Multiple statement patterns
  /;\s*(DROP|DELETE|INSERT|UPDATE|CREATE|ALTER)/i,
  // Union-based attacks
  /\bUNION\s+(ALL\s+)?\s*\(\s*(DROP|DELETE|INSERT|UPDATE)/i,
] as const;

/**
 * SQL Security Validator class for comprehensive SQL security validation
 */
export class SqlSecurityValidator {
  private static parser = new Parser();

  /**
   * Validate SQL query against security configuration
   * @param query - SQL query to validate
   * @param securityConfig - Security configuration
   * @param context - Request context for logging
   * @throws {McpError} If validation fails
   */
  static validateQuery(
    query: string,
    securityConfig: SqlToolSecurityConfig,
    context: RequestContext,
  ): void {
    logger.debug(
      {
        ...context,
        queryLength: query.length,
        readOnly: securityConfig.readOnly,
        maxQueryLength: securityConfig.maxQueryLength,
      },
      "Starting SQL security validation",
    );

    // 1. Check query length limit
    this.validateQueryLength(query, securityConfig);

    // 2. Always validate forbidden keywords (regardless of read-only setting)
    this.validateForbiddenKeywords(query, securityConfig, context);

    // 3. If in read-only mode, perform comprehensive write operation validation
    if (securityConfig.readOnly !== false) {
      this.validateReadOnlyRestrictions(query, context);
    }

    logger.debug(
      {
        ...context,
      },
      "SQL security validation passed",
    );
  }

  /**
   * Validate query length against configured limits
   * @param query - SQL query to validate
   * @param securityConfig - Security configuration
   * @private
   */
  private static validateQueryLength(
    query: string,
    securityConfig: SqlToolSecurityConfig,
  ): void {
    const maxLength = securityConfig.maxQueryLength ?? 10000;
    if (query.length > maxLength) {
      throw new McpError(
        JsonRpcErrorCode.ValidationError,
        `Query exceeds maximum length of ${maxLength} characters`,
        {
          queryLength: query.length,
          maxLength,
          query: query.substring(0, 100) + (query.length > 100 ? "..." : ""),
        },
      );
    }
  }

  /**
   * Validate forbidden keywords using both AST and regex approaches
   * @param query - SQL query to validate
   * @param securityConfig - Security configuration
   * @param context - Request context for logging
   * @private
   */
  private static validateForbiddenKeywords(
    query: string,
    securityConfig: SqlToolSecurityConfig,
    context: RequestContext,
  ): void {
    if (
      !securityConfig.forbiddenKeywords ||
      securityConfig.forbiddenKeywords.length === 0
    ) {
      return;
    }

    // Try AST-based validation first
    const astResult = this.validateForbiddenKeywordsAST(
      query,
      securityConfig.forbiddenKeywords,
      context,
    );
    if (!astResult.isValid) {
      throw new McpError(
        JsonRpcErrorCode.ValidationError,
        `Forbidden keywords detected: ${astResult.violations.join(", ")}`,
        {
          violations: astResult.violations,
          forbiddenKeywords: securityConfig.forbiddenKeywords,
          query: query.substring(0, 100) + (query.length > 100 ? "..." : ""),
        },
      );
    }

    // Fallback to regex validation
    const regexResult = this.validateForbiddenKeywordsRegex(
      query,
      securityConfig.forbiddenKeywords,
    );
    if (!regexResult.isValid) {
      throw new McpError(
        JsonRpcErrorCode.ValidationError,
        `Forbidden keywords detected: ${regexResult.violations.join(", ")}`,
        {
          violations: regexResult.violations,
          forbiddenKeywords: securityConfig.forbiddenKeywords,
          query: query.substring(0, 100) + (query.length > 100 ? "..." : ""),
        },
      );
    }
  }

  /**
   * Validate read-only restrictions using comprehensive validation
   * @param query - SQL query to validate
   * @param context - Request context for logging
   * @private
   */
  private static validateReadOnlyRestrictions(
    query: string,
    context: RequestContext,
  ): void {
    // Try AST-based validation first (more reliable)
    const astResult = this.validateQueryAST(query, context);
    if (!astResult.isValid) {
      throw new McpError(
        JsonRpcErrorCode.ValidationError,
        `Write operations detected: ${astResult.violations.join(", ")}`,
        {
          violations: astResult.violations,
          readOnly: true,
          query: query.substring(0, 100) + (query.length > 100 ? "..." : ""),
        },
      );
    }

    // Fallback to regex validation for additional coverage
    const regexResult = this.validateQueryRegex(query, context);
    if (!regexResult.isValid) {
      throw new McpError(
        JsonRpcErrorCode.ValidationError,
        `Write operations detected: ${regexResult.violations.join(", ")}`,
        {
          violations: regexResult.violations,
          readOnly: true,
          query: query.substring(0, 100) + (query.length > 100 ? "..." : ""),
        },
      );
    }
  }

  /**
   * Strip string literals from SQL to prevent false positives in regex validation
   * Comments are not allowed in DB2 SQL statements, so only string literals need stripping
   * @param sql - Raw SQL query
   * @returns Normalized SQL with strings replaced with empty literals
   * @private
   */
  private static stripSqlLiteralsAndComments(sql: string): string {
    let normalized = sql;

    // Replace single-quoted strings with empty string literals
    // Pattern handles escaped quotes: 'can''t' -> ''
    normalized = normalized.replace(/'(?:''|[^'])*'/g, "''");

    return normalized;
  }

  /**
   * Determine if an AST node represents a SQL statement (vs expression/literal)
   * @param node - AST node to check
   * @returns True if node has a statement-type .type field
   * @private
   */
  private static isStatementTypeNode(node: unknown): boolean {
    if (!node || typeof node !== "object") return false;

    const objNode = node as Record<string, unknown>;
    if (!objNode.type || typeof objNode.type !== "string") return false;

    const nodeType = objNode.type.toUpperCase();

    // Known statement types from DANGEROUS_OPERATIONS and SELECT
    const STATEMENT_TYPES = new Set([
      "SELECT",
      "INSERT",
      "UPDATE",
      "DELETE",
      "REPLACE",
      "MERGE",
      "TRUNCATE",
      "DROP",
      "CREATE",
      "ALTER",
      "RENAME",
      "CALL",
      "EXEC",
      "EXECUTE",
      "SET",
      "DECLARE",
      "GRANT",
      "REVOKE",
      "DENY",
      "LOAD",
      "IMPORT",
      "EXPORT",
      "BULK",
      "SHUTDOWN",
      "RESTART",
      "KILL",
      "STOP",
      "START",
      "BACKUP",
      "RESTORE",
      "DUMP",
      "LOCK",
      "UNLOCK",
      "COMMIT",
      "ROLLBACK",
      "SAVEPOINT",
    ]);

    return STATEMENT_TYPES.has(nodeType);
  }

  /**
   * Recursively traverse AST to find all statement nodes
   * @param node - Current AST node
   * @param callback - Function to call for each statement node found
   * @private
   */
  private static traverseAstForStatements(
    node: unknown,
    callback: (node: Record<string, unknown>) => void,
  ): void {
    if (!node || typeof node !== "object") return;

    const objNode = node as Record<string, unknown>;

    // If this is a statement-type node, invoke callback
    if (this.isStatementTypeNode(objNode)) {
      callback(objNode);
    }

    // Recurse into all object/array properties
    for (const key in objNode) {
      const value = objNode[key];

      if (Array.isArray(value)) {
        value.forEach((item) => this.traverseAstForStatements(item, callback));
      } else if (typeof value === "object" && value !== null) {
        this.traverseAstForStatements(value, callback);
      }
    }
  }

  /**
   * Validate SQL query using AST parsing with fail-closed security model
   * In read-only mode, enforces allowlist (only SELECT) and blocks SELECT INTO
   * @param query - SQL query to validate
   * @param context - Request context for logging
   * @private
   */
  private static validateQueryAST(
    query: string,
    context: RequestContext,
  ): SecurityValidationResult {
    const violations: string[] = [];

    try {
      const ast = this.parser.astify(query, { database: "db2" });

      logger.debug(
        {
          ...context,
          astType: Array.isArray(ast) ? "multiple" : "single",
          statementCount: Array.isArray(ast) ? ast.length : 1,
        },
        "SQL AST parsed successfully",
      );

      const statements = Array.isArray(ast) ? ast : [ast];

      // Phase 1: Top-level statement type validation (allowlist enforcement)
      for (const statement of statements) {
        if (!statement || typeof statement !== "object") continue;

        const objStmt = statement as unknown as Record<string, unknown>;
        const stmtType = String(objStmt.type || "").toUpperCase();

        // Allowlist: only SELECT is allowed in read-only mode
        if (stmtType !== "SELECT") {
          violations.push(`Non-read-only statement detected: ${stmtType}`);
        }

        // Note: SELECT INTO detection via AST is unreliable with this parser
        // Regex validation provides coverage for SELECT INTO patterns
      }

      // Phase 2: Nested statement validation (CTEs, subqueries, unions)
      // Traverse AST to find all statement nodes including nested ones
      for (const statement of statements) {
        this.traverseAstForStatements(statement, (node) => {
          const nodeType = String(node.type || "").toUpperCase();

          if (nodeType !== "SELECT") {
            // Any non-SELECT statement in nested context is a violation
            violations.push(
              `Non-read-only statement in nested context: ${nodeType}`,
            );
          }
          // Note: SELECT INTO checking is unreliable in AST, rely on regex instead
        });
      }

      // Phase 3: Dangerous function scanning (keep existing logic)
      for (const statement of statements) {
        const dangerousFunctions = this.findDangerousFunctionsInAST(statement);
        if (dangerousFunctions.length > 0) {
          violations.push(
            ...dangerousFunctions.map(
              (f: string) => `Dangerous function: ${f}`,
            ),
          );
        }
      }

      // Phase 4: UNION validation (keep existing logic)
      for (const statement of statements) {
        if (this.hasUnionWithDangerousStatements(statement)) {
          violations.push("UNION with dangerous statements detected");
        }
      }

      return {
        isValid: violations.length === 0,
        violations,
        validationMethod: "ast",
      };
    } catch (parseError) {
      // CRITICAL SECURITY CHANGE: Fail closed instead of allowing fallback
      // If we can't parse the AST in read-only mode, we must reject the query
      logger.warning(
        {
          ...context,
          error:
            parseError instanceof Error
              ? parseError.message
              : String(parseError),
          queryLength: query.length,
        },
        "SQL AST parsing failed in read-only mode - rejecting query",
      );

      return {
        isValid: false, // CHANGED: Fail closed for security
        violations: ["SQL parsing failed (cannot validate read-only safely)"],
        validationMethod: "ast",
      };
    }
  }

  /**
   * Validate SQL query using regex patterns
   * @param query - SQL query to validate
   * @param _context - Request context for logging (unused but kept for consistency)
   * @private
   */
  private static validateQueryRegex(
    query: string,
    _context: RequestContext,
  ): SecurityValidationResult {
    const violations: string[] = [];

    // Normalize SQL by stripping comments and string literals to prevent false positives
    const normalizedQuery = this.stripSqlLiteralsAndComments(query);

    // Check for dangerous operations
    for (const operation of DANGEROUS_OPERATIONS) {
      const pattern = new RegExp(`\\b${operation}\\b`, "i");
      if (pattern.test(normalizedQuery)) {
        violations.push(`Write operation '${operation}' detected`);
      }
    }

    // Check for dangerous patterns
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(normalizedQuery)) {
        violations.push(`Dangerous pattern detected: ${pattern.source}`);
      }
    }

    // Check for suspicious function calls
    for (const func of DANGEROUS_FUNCTIONS) {
      const pattern = new RegExp(`\\b${func}\\s*\\(`, "i");
      if (pattern.test(normalizedQuery)) {
        violations.push(`Suspicious function '${func}' detected`);
      }
    }

    return {
      isValid: violations.length === 0,
      violations,
      validationMethod: "regex",
    };
  }

  /**
   * Validate forbidden keywords using AST parsing
   * @param query - SQL query to validate
   * @param forbiddenKeywords - List of forbidden keywords
   * @param context - Request context for logging
   * @private
   */
  private static validateForbiddenKeywordsAST(
    query: string,
    forbiddenKeywords: string[],
    context: RequestContext,
  ): SecurityValidationResult {
    const violations: string[] = [];

    try {
      const ast = this.parser.astify(query, { database: "db2" });
      const statements = Array.isArray(ast) ? ast : [ast];

      for (const statement of statements) {
        const foundKeywords = this.findForbiddenKeywordsInAST(
          statement,
          forbiddenKeywords,
        );
        violations.push(...foundKeywords.map((k) => `Forbidden keyword: ${k}`));
      }
    } catch (parseError) {
      logger.debug(
        {
          ...context,
          error:
            parseError instanceof Error
              ? parseError.message
              : String(parseError),
        },
        "AST parsing failed for forbidden keyword validation",
      );
    }

    return {
      isValid: violations.length === 0,
      violations,
      validationMethod: "ast",
    };
  }

  /**
   * Validate forbidden keywords using regex patterns
   * @param query - SQL query to validate
   * @param forbiddenKeywords - List of forbidden keywords
   * @private
   */
  private static validateForbiddenKeywordsRegex(
    query: string,
    forbiddenKeywords: string[],
  ): SecurityValidationResult {
    const violations: string[] = [];

    // Normalize SQL by stripping comments and string literals to prevent false positives
    const normalizedQuery = this.stripSqlLiteralsAndComments(query);

    for (const keyword of forbiddenKeywords) {
      const pattern = new RegExp(
        `\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
        "i",
      );
      if (pattern.test(normalizedQuery)) {
        violations.push(`Forbidden keyword: ${keyword}`);
      }
    }

    return {
      isValid: violations.length === 0,
      violations,
      validationMethod: "regex",
    };
  }

  /**
   * Find dangerous functions anywhere in the AST
   * @param node - AST node to analyze
   * @private
   */
  private static findDangerousFunctionsInAST(node: unknown): string[] {
    const violations: string[] = [];

    if (!node || typeof node !== "object") return violations;

    const objNode = node as Record<string, unknown>;

    // Check if this node is a function call
    if (objNode.type === "function" && objNode.name) {
      const funcName = String(objNode.name).toUpperCase();

      if ((DANGEROUS_FUNCTIONS as readonly string[]).includes(funcName)) {
        violations.push(funcName);
      }
    }

    // Recursively check all properties
    for (const key in objNode) {
      const value = objNode[key];
      if (Array.isArray(value)) {
        value.forEach((item) =>
          violations.push(...this.findDangerousFunctionsInAST(item)),
        );
      } else if (typeof value === "object") {
        violations.push(...this.findDangerousFunctionsInAST(value));
      }
    }

    return violations;
  }

  /**
   * Find forbidden keywords anywhere in the AST
   * @param node - AST node to analyze
   * @param forbiddenKeywords - List of forbidden keywords
   * @private
   */
  private static findForbiddenKeywordsInAST(
    node: unknown,
    forbiddenKeywords: string[],
  ): string[] {
    const violations: string[] = [];

    if (!node || typeof node !== "object") return violations;

    const objNode = node as Record<string, unknown>;

    // Check string values for forbidden keywords
    // Skip 'value' key which contains string literals, not SQL keywords
    for (const key in objNode) {
      if (key === "value") continue; // Skip string literal values

      const value = objNode[key];
      if (typeof value === "string") {
        for (const keyword of forbiddenKeywords) {
          const pattern = new RegExp(
            `\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
            "i",
          );
          if (pattern.test(value)) {
            violations.push(keyword);
          }
        }
      } else if (Array.isArray(value)) {
        value.forEach((item) =>
          violations.push(
            ...this.findForbiddenKeywordsInAST(item, forbiddenKeywords),
          ),
        );
      } else if (typeof value === "object") {
        violations.push(
          ...this.findForbiddenKeywordsInAST(value, forbiddenKeywords),
        );
      }
    }

    return violations;
  }

  /**
   * Check for UNION with dangerous statements
   * @param statement - AST statement to check
   * @private
   */
  private static hasUnionWithDangerousStatements(statement: unknown): boolean {
    if (!statement || typeof statement !== "object") return false;

    const stmt = statement as Record<string, unknown>;

    // Check if this is a UNION statement
    if (stmt.type === "select" && stmt.union) {
      // Check each part of the union
      const unionParts = Array.isArray(stmt.union) ? stmt.union : [stmt.union];
      for (const part of unionParts) {
        const partObj = part as Record<string, unknown>;
        if (partObj.type && String(partObj.type).toUpperCase() !== "SELECT") {
          return true;
        }
      }
    }

    return false;
  }
}

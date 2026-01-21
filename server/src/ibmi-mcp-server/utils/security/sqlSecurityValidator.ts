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
import { IbmiSqlParser } from "./ibmiSqlParser.js";

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
  // "REPLACE",
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
 * All SQL statement types for AST node identification
 * Combines DANGEROUS_OPERATIONS with SELECT for complete statement type recognition
 */
const STATEMENT_TYPES: Set<string> = new Set([
  "SELECT",
  ...DANGEROUS_OPERATIONS,
]);

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
 * Note: Individual function calls (SYSTEM, QCMDEXC, etc.) are handled by DANGEROUS_FUNCTIONS
 * This array is for structural attack patterns that can't be expressed as simple function names
 */
export const DANGEROUS_PATTERNS = [
  // Multiple statement patterns (SQL injection via statement chaining)
  /;\s*(DROP|DELETE|INSERT|UPDATE|CREATE|ALTER)/i,
  // Union-based attacks (SQL injection via UNION with dangerous operations)
  /\bUNION\s+(ALL\s+)?\s*\(\s*(DROP|DELETE|INSERT|UPDATE)/i,
  // REPLACE statement (MySQL-specific write operation)
  /\bREPLACE\s+INTO\b/i,
] as const;

/**
 * SQL Security Validator class for comprehensive SQL security validation
 */
export class SqlSecurityValidator {
  private static parser = new Parser();

  /**
   * Truncate query string for error messages and logging
   * @param query - SQL query to truncate
   * @param maxLength - Maximum length before truncation (default: 100)
   * @returns Truncated query with ellipsis if needed
   * @private
   */
  private static truncateQuery(query: string, maxLength = 100): string {
    return query.length > maxLength
      ? query.substring(0, maxLength) + "..."
      : query;
  }

  /**
   * Create standardized validation result
   * @param violations - List of validation violations
   * @param method - Validation method used
   * @returns Security validation result object
   * @private
   */
  private static createValidationResult(
    violations: string[],
    method: "ast" | "regex" | "combined",
  ): SecurityValidationResult {
    return {
      isValid: violations.length === 0,
      violations,
      validationMethod: method,
    };
  }

  /**
   * Throw validation error with standardized format
   * @param message - Error message
   * @param violations - List of violations
   * @param context - Additional context for error
   * @param query - SQL query being validated
   * @throws McpError with ValidationError code
   * @private
   */
  private static throwValidationError(
    message: string,
    violations: string[],
    context: Record<string, unknown>,
    query: string,
  ): never {
    throw new McpError(JsonRpcErrorCode.ValidationError, message, {
      violations,
      ...context,
      query: this.truncateQuery(query),
    });
  }

  /**
   * Parse SQL query to AST with error handling
   * @param query - SQL query to parse
   * @param context - Request context for logging
   * @param failClosed - If true, returns null on parse error (fail-closed security); if false, allows fallback
   * @returns Array of AST statements or null on error
   * @private
   */
  private static parseQueryToStatements(
    query: string,
    context: RequestContext,
    failClosed = false,
  ): unknown[] | null {
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

      return Array.isArray(ast) ? ast : [ast];
    } catch (parseError) {
      const errorMessage =
        parseError instanceof Error ? parseError.message : String(parseError);

      if (failClosed) {
        logger.warning(
          {
            ...context,
            error: errorMessage,
            queryLength: query.length,
          },
          "SQL AST parsing failed - rejecting query for security",
        );
        return null;
      }

      logger.debug(
        {
          ...context,
          error: errorMessage,
        },
        "AST parsing failed - falling back to regex validation",
      );

      return null;
    }
  }

  /**
   * Recursively traverse AST and collect results from visitor function
   * Generic traversal utility that eliminates duplicate traversal logic
   * @param node - Current AST node to traverse
   * @param visitor - Function to check each node, returns result or null
   * @returns Array of collected results
   * @private
   */
  private static traverseAST<T>(
    node: unknown,
    visitor: (node: Record<string, unknown>) => T | null,
  ): T[] {
    const results: T[] = [];

    if (!node || typeof node !== "object") {
      return results;
    }

    const objNode = node as Record<string, unknown>;

    // Visit current node
    const result = visitor(objNode);
    if (result !== null) {
      results.push(result);
    }

    // Recursively traverse all properties
    for (const key in objNode) {
      const value = objNode[key];

      if (Array.isArray(value)) {
        value.forEach((item) => {
          results.push(...this.traverseAST(item, visitor));
        });
      } else if (typeof value === "object" && value !== null) {
        results.push(...this.traverseAST(value, visitor));
      }
    }

    return results;
  }

  /**
   * Validate query against list of keywords using regex patterns
   * Generic regex validation utility that eliminates duplicate regex iteration logic
   * @param query - SQL query to validate
   * @param keywords - Keywords to check for
   * @param patternBuilder - Function to build regex pattern from keyword
   * @param violationFormatter - Function to format violation message
   * @returns Array of violation messages
   * @private
   */
  private static validateWithRegexList(
    query: string,
    keywords: readonly string[] | string[],
    patternBuilder: (keyword: string) => RegExp,
    violationFormatter: (keyword: string) => string,
  ): string[] {
    const violations: string[] = [];
    const normalizedQuery = this.stripSqlLiteralsAndComments(query);

    for (const keyword of keywords) {
      const pattern = patternBuilder(keyword);
      if (pattern.test(normalizedQuery)) {
        violations.push(violationFormatter(keyword));
      }
    }

    return violations;
  }

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
          query: this.truncateQuery(query),
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
      this.throwValidationError(
        `Forbidden keywords detected: ${astResult.violations.join(", ")}`,
        astResult.violations,
        { forbiddenKeywords: securityConfig.forbiddenKeywords },
        query,
      );
    }

    // Fallback to regex validation
    const regexResult = this.validateForbiddenKeywordsRegex(
      query,
      securityConfig.forbiddenKeywords,
    );
    if (!regexResult.isValid) {
      this.throwValidationError(
        `Forbidden keywords detected: ${regexResult.violations.join(", ")}`,
        regexResult.violations,
        { forbiddenKeywords: securityConfig.forbiddenKeywords },
        query,
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
    // Try IBM i-specific regex parser first (understands IBM i syntax)
    const ibmiResult = IbmiSqlParser.parseQuery(query, context);

    if (ibmiResult.success) {
      // If IBM i parser successfully validated, use its results
      if (!ibmiResult.isReadOnly) {
        this.throwValidationError(
          `Write operations detected: ${ibmiResult.violations.join(', ')}`,
          ibmiResult.violations,
          { readOnly: true, validatedBy: 'ibmi-regex', hasIbmiFeatures: ibmiResult.hasIbmiFeatures },
          query,
        );
      }

      logger.debug(
        {
          ...context,
          validatedBy: 'ibmi-regex',
          hasIbmiFeatures: ibmiResult.hasIbmiFeatures,
          statementTypes: ibmiResult.statementTypes,
        },
        'Read-only validation passed using IBM i regex parser'
      );

      return; // Success - skip node-sql-parser fallback
    }

    // Fall back to existing node-sql-parser + regex validation
    logger.debug(
      { ...context },
      'Falling back to node-sql-parser for validation'
    );

    // Try AST-based validation first (more reliable)
    const astResult = this.validateQueryAST(query, context);
    if (!astResult.isValid) {
      this.throwValidationError(
        `Write operations detected: ${astResult.violations.join(", ")}`,
        astResult.violations,
        { readOnly: true, validatedBy: 'node-sql-parser' },
        query,
      );
    }

    // Fallback to regex validation for additional coverage
    const regexResult = this.validateQueryRegex(query, context);
    if (!regexResult.isValid) {
      this.throwValidationError(
        `Write operations detected: ${regexResult.violations.join(", ")}`,
        regexResult.violations,
        { readOnly: true, validatedBy: 'regex' },
        query,
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

    // Use pre-computed STATEMENT_TYPES constant (derived from DANGEROUS_OPERATIONS + SELECT)
    return STATEMENT_TYPES.has(nodeType);
  }

  /**
   * Recursively traverse AST to find all statement nodes
   * Uses generic AST traversal with visitor pattern
   * @param node - Current AST node
   * @param callback - Function to call for each statement node found
   * @private
   */
  private static traverseAstForStatements(
    node: unknown,
    callback: (node: Record<string, unknown>) => void,
  ): void {
    this.traverseAST(node, (objNode) => {
      // If this is a statement-type node, invoke callback
      if (this.isStatementTypeNode(objNode)) {
        callback(objNode);
      }
      return null;
    });
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

    // Parse query with fail-closed security (rejects on parse error)
    const statements = this.parseQueryToStatements(query, context, true);
    if (statements === null) {
      return this.createValidationResult(
        ["SQL parsing failed (cannot validate read-only safely)"],
        "ast",
      );
    }

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
          ...dangerousFunctions.map((f: string) => `Dangerous function: ${f}`),
        );
      }
    }

    // Phase 4: UNION validation (keep existing logic)
    for (const statement of statements) {
      if (this.hasUnionWithDangerousStatements(statement)) {
        violations.push("UNION with dangerous statements detected");
      }
    }

    return this.createValidationResult(violations, "ast");
  }

  /**
   * Validate SQL query using regex patterns
   * Uses generic regex validation helper to eliminate duplication
   * @param query - SQL query to validate
   * @param _context - Request context for logging (unused but kept for consistency)
   * @private
   */
  private static validateQueryRegex(
    query: string,
    _context: RequestContext,
  ): SecurityValidationResult {
    const violations: string[] = [];

    // Check for dangerous operations using helper
    violations.push(
      ...this.validateWithRegexList(
        query,
        DANGEROUS_OPERATIONS,
        (op) => new RegExp(`\\b${op}\\b`, "i"),
        (op) => `Write operation '${op}' detected`,
      ),
    );

    // Check for dangerous patterns (already RegExp objects, different pattern)
    const normalizedQuery = this.stripSqlLiteralsAndComments(query);
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(normalizedQuery)) {
        violations.push(`Dangerous pattern detected: ${pattern.source}`);
      }
    }

    // Check for suspicious function calls using helper
    violations.push(
      ...this.validateWithRegexList(
        query,
        DANGEROUS_FUNCTIONS,
        (func) => new RegExp(`\\b${func}\\s*\\(`, "i"),
        (func) => `Suspicious function '${func}' detected`,
      ),
    );

    return this.createValidationResult(violations, "regex");
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

    // Parse query with fail-open (allows regex fallback on parse error)
    const statements = this.parseQueryToStatements(query, context, false);
    if (statements === null) {
      return this.createValidationResult([], "ast");
    }

    for (const statement of statements) {
      const foundKeywords = this.findForbiddenKeywordsInAST(
        statement,
        forbiddenKeywords,
      );
      violations.push(...foundKeywords.map((k) => `Forbidden keyword: ${k}`));
    }

    return this.createValidationResult(violations, "ast");
  }

  /**
   * Validate forbidden keywords using regex patterns
   * Uses generic regex validation helper to eliminate duplication
   * @param query - SQL query to validate
   * @param forbiddenKeywords - List of forbidden keywords
   * @private
   */
  private static validateForbiddenKeywordsRegex(
    query: string,
    forbiddenKeywords: string[],
  ): SecurityValidationResult {
    const violations = this.validateWithRegexList(
      query,
      forbiddenKeywords,
      (kw) =>
        new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"),
      (kw) => `Forbidden keyword: ${kw}`,
    );

    return this.createValidationResult(violations, "regex");
  }

  /**
   * Find dangerous functions anywhere in the AST
   * Uses generic AST traversal with visitor pattern
   * @param node - AST node to analyze
   * @private
   */
  private static findDangerousFunctionsInAST(node: unknown): string[] {
    return this.traverseAST(node, (objNode) => {
      // Check if this node is a function call
      if (objNode.type === "function" && objNode.name) {
        const funcName = String(objNode.name).toUpperCase();
        if ((DANGEROUS_FUNCTIONS as readonly string[]).includes(funcName)) {
          return funcName;
        }
      }
      return null;
    });
  }

  /**
   * Find forbidden keywords anywhere in the AST
   * Uses generic AST traversal with visitor pattern
   * @param node - AST node to analyze
   * @param forbiddenKeywords - List of forbidden keywords
   * @private
   */
  private static findForbiddenKeywordsInAST(
    node: unknown,
    forbiddenKeywords: string[],
  ): string[] {
    const found = new Set<string>();

    this.traverseAST(node, (objNode) => {
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
              found.add(keyword);
            }
          }
        }
      }
      return null;
    });

    return Array.from(found);
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

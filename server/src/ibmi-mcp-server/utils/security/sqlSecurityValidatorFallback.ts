/**
 * @fileoverview Regex-based SQL Security Validator Fallback
 * Simple regex pattern matching for cases where vscode-db2i parser cannot handle a query
 *
 * @module src/ibmi-mcp-server/utils/security/sqlSecurityValidatorFallback
 */

import { logger } from "@/utils/internal/logger.js";
import { RequestContext } from "@/utils/internal/requestContext.js";
import {
  DANGEROUS_OPERATIONS,
  DANGEROUS_FUNCTIONS,
  DANGEROUS_PATTERNS,
  SecurityValidationResult,
} from "./sqlSecurityValidator.js";

/**
 * Regex-based SQL Security Validator Fallback
 * Provides simple pattern-matching validation when primary validators cannot parse the query
 */
export class SqlSecurityValidatorFallback {
  /**
   * Strip string literals from SQL to prevent false positives in regex validation
   * @param sql - Raw SQL query
   * @returns Normalized SQL with strings replaced with empty literals
   * @private
   */
  private static stripSqlLiterals(sql: string): string {
    // Replace single-quoted strings with empty string literals
    // Pattern handles escaped quotes: 'can''t' -> ''
    return sql.replace(/'(?:''|[^'])*'/g, "''");
  }

  /**
   * Validate query against list of keywords using regex patterns
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
    const normalizedQuery = this.stripSqlLiterals(query);

    for (const keyword of keywords) {
      const pattern = patternBuilder(keyword);
      if (pattern.test(normalizedQuery)) {
        violations.push(violationFormatter(keyword));
      }
    }

    return violations;
  }

  /**
   * Create standardized validation result
   * @param violations - List of validation violations
   * @returns Security validation result object
   * @private
   */
  private static createValidationResult(
    violations: string[],
  ): SecurityValidationResult {
    return {
      isValid: violations.length === 0,
      violations,
      validationMethod: "regex",
    };
  }

  /**
   * Validate read-only restrictions using regex patterns
   * @param query - SQL query to validate
   * @param context - Request context for logging
   * @returns Security validation result
   */
  static validateReadOnly(
    query: string,
    context: RequestContext,
  ): SecurityValidationResult {
    const violations: string[] = [];

    logger.debug(
      { ...context },
      "Using regex fallback for read-only validation",
    );

    // Check for dangerous operations
    violations.push(
      ...this.validateWithRegexList(
        query,
        DANGEROUS_OPERATIONS,
        (op) => new RegExp(`\\b${op}\\b`, "i"),
        (op) => `Write operation '${op}' detected`,
      ),
    );

    // Check for dangerous patterns
    const normalizedQuery = this.stripSqlLiterals(query);
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(normalizedQuery)) {
        violations.push(`Dangerous pattern detected: ${pattern.source}`);
      }
    }

    // Check for suspicious function calls
    violations.push(
      ...this.validateWithRegexList(
        query,
        DANGEROUS_FUNCTIONS,
        (func) => new RegExp(`\\b${func}\\s*\\(`, "i"),
        (func) => `Suspicious function '${func}' detected`,
      ),
    );

    return this.createValidationResult(violations);
  }

  /**
   * Validate forbidden keywords using regex patterns
   * @param query - SQL query to validate
   * @param forbiddenKeywords - List of forbidden keywords
   * @param context - Request context for logging
   * @returns Security validation result
   */
  static validateForbiddenKeywords(
    query: string,
    forbiddenKeywords: string[],
    context: RequestContext,
  ): SecurityValidationResult {
    logger.debug(
      { ...context, keywordCount: forbiddenKeywords.length },
      "Using regex fallback for forbidden keywords validation",
    );

    const violations = this.validateWithRegexList(
      query,
      forbiddenKeywords,
      (kw) =>
        new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"),
      (kw) => `Forbidden keyword: ${kw}`,
    );

    return this.createValidationResult(violations);
  }
}

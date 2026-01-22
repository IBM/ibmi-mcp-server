/**
 * @fileoverview SQL Security Validator for validating SQL queries against security policies
 * Uses vscode-db2i tokenizer for precise validation and regex patterns as fallback
 *
 * @module src/utils/security/sqlSecurityValidator
 */

import { logger } from "@/utils/internal/logger.js";
import { RequestContext } from "@/utils/internal/requestContext.js";
import { JsonRpcErrorCode, McpError } from "@/types-global/errors.js";
import { SqlToolSecurityConfig } from "../../schemas/index.js";
import { IbmiSqlParser } from "./ibmiSqlParser.js";
import SQLTokeniser from "@/ibmi-mcp-server/utils/language/tokens.js";
import { SqlSecurityValidatorFallback } from "./sqlSecurityValidatorFallback.js";

/**
 * Security validation result
 */
export interface SecurityValidationResult {
  /** Whether the validation passed */
  isValid: boolean;
  /** List of security violations found */
  violations: string[];
  /** Validation method used */
  validationMethod: "regex" | "combined";
}

/**
 * Dangerous SQL operations that should be blocked in read-only mode
 */
export const DANGEROUS_OPERATIONS = [
  // Data manipulation
  "INSERT",
  "UPDATE",
  "DELETE",
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
 * Dangerous SQL patterns that should be detected
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
 * Uses token-based validation with vscode-db2i tokenizer as primary method
 */
export class SqlSecurityValidator {
  private static tokeniser = new SQLTokeniser();

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
   * Validate forbidden keywords using token-based approach
   * This method uses the vscode-db2i tokenizer to precisely identify SQL keywords
   * @param query - SQL query to validate
   * @param forbiddenKeywords - List of forbidden keywords
   * @returns Security validation result
   * @private
   */
  private static validateForbiddenKeywordsToken(
    query: string,
    forbiddenKeywords: string[],
  ): SecurityValidationResult {
    const tokens = this.tokeniser.tokenise(query);
    const violations: string[] = [];

    // Use Set for O(1) lookup performance
    const forbiddenSet = new Set(
      forbiddenKeywords.map(kw => kw.toUpperCase())
    );

    for (const token of tokens) {
      // Skip string literals - only check actual SQL keywords
      if (token.type === "string") continue;

      const value = token.value?.toUpperCase();
      if (value && forbiddenSet.has(value)) {
        violations.push(`Forbidden keyword: ${value}`);
      }
    }

    return {
      isValid: violations.length === 0,
      violations,
      validationMethod: "combined",
    };
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
   * Validate forbidden keywords using token-based approach with regex fallback
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

    try {
      // Try token-based validation first (more precise)
      const tokenResult = this.validateForbiddenKeywordsToken(
        query,
        securityConfig.forbiddenKeywords,
      );

      if (!tokenResult.isValid) {
        this.throwValidationError(
          `Forbidden keywords detected: ${tokenResult.violations.join(", ")}`,
          tokenResult.violations,
          {
            forbiddenKeywords: securityConfig.forbiddenKeywords,
            validatedBy: "token",
          },
          query,
        );
      }

      logger.debug(
        { ...context, validatedBy: "token" },
        "Forbidden keywords validation passed",
      );
    } catch (tokenError) {
      // If tokenization fails, fall back to regex validation
      logger.debug(
        { ...context, error: String(tokenError) },
        "Token validation failed, falling back to regex",
      );

      const regexResult =
        SqlSecurityValidatorFallback.validateForbiddenKeywords(
          query,
          securityConfig.forbiddenKeywords,
          context,
        );

      if (!regexResult.isValid) {
        this.throwValidationError(
          `Forbidden keywords detected: ${regexResult.violations.join(", ")}`,
          regexResult.violations,
          {
            forbiddenKeywords: securityConfig.forbiddenKeywords,
            validatedBy: "regex-fallback",
          },
          query,
        );
      }
    }
  }

  /**
   * Validate read-only restrictions using IBM i parser with regex fallback
   * @param query - SQL query to validate
   * @param context - Request context for logging
   * @private
   */
  private static validateReadOnlyRestrictions(
    query: string,
    context: RequestContext,
  ): void {
    // Try IBM i parser first (understands IBM i syntax and uses vscode-db2i)
    const ibmiResult = IbmiSqlParser.parseQuery(query, context);

    if (ibmiResult.success) {
      // If IBM i parser successfully validated, use its results
      if (!ibmiResult.isReadOnly) {
        this.throwValidationError(
          `Write operations detected: ${ibmiResult.violations.join(", ")}`,
          ibmiResult.violations,
          {
            readOnly: true,
            validatedBy: "ibmi-vscode",
          },
          query,
        );
      }

      logger.debug(
        {
          ...context,
          validatedBy: "ibmi-vscode",
          statementTypes: ibmiResult.statementTypes,
        },
        "Read-only validation passed using IBM i vscode parser",
      );

      return; // Success - skip regex fallback
    }

    // Fall back to regex validation
    logger.debug(
      { ...context },
      "Falling back to regex validation for read-only check",
    );

    const regexResult = SqlSecurityValidatorFallback.validateReadOnly(
      query,
      context,
    );

    if (!regexResult.isValid) {
      this.throwValidationError(
        `Write operations detected: ${regexResult.violations.join(", ")}`,
        regexResult.violations,
        { readOnly: true, validatedBy: "regex-fallback" },
        query,
      );
    }

    logger.debug(
      { ...context, validatedBy: "regex-fallback" },
      "Read-only validation passed via regex fallback",
    );
  }
}

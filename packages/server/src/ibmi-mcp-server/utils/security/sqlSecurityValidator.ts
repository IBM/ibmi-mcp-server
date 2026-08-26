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
 * Classification metadata from Layer-1 SQL security validation.
 * Used by execute_sql to decide whether a wire PARSE_STATEMENT round trip is needed.
 * Populated in both read-only and write mode so `auto` can skip PARSE whenever
 * vscode-db2i successfully classified the statement (including INSERT/UPDATE when
 * writes are allowed).
 */
export interface SqlValidationClassification {
  /**
   * True when the in-process vscode-db2i parser successfully classified at
   * least one statement. False when the parser failed, produced zero
   * statements (comment-only input), or classification was skipped.
   */
  classified: boolean;
  /** Statement types from the in-process parser when available */
  statementTypes?: string[];
  /**
   * Which Layer-1 path produced the classification. "none" means
   * classification was skipped (write mode, caller did not request it).
   */
  validatedBy: "ibmi-vscode" | "regex-fallback" | "none";
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
      forbiddenKeywords.map((kw) => kw.toUpperCase()),
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
   * @param options - Set `classify: true` to run in-process classification even
   *   in write mode (used by execute_sql to decide whether wire PARSE_STATEMENT
   *   can be skipped). Callers that discard the classification omit it, so
   *   write-mode validation stays off the parse hot path.
   * @returns Classification metadata for callers that may skip wire PARSE_STATEMENT
   * @throws {McpError} If validation fails
   */
  static validateQuery(
    query: string,
    securityConfig: SqlToolSecurityConfig,
    context: RequestContext,
    options?: { classify?: boolean },
  ): SqlValidationClassification {
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

    // 3. Classify in-process when read-only mode is enforced (classification
    //    doubles as write rejection) or when the caller asked for it
    //    (execute_sql uses it to skip wire PARSE under `auto`). Write-mode
    //    callers that discard the result skip the parse entirely.
    const enforceReadOnly = securityConfig.readOnly !== false;
    if (!enforceReadOnly && options?.classify !== true) {
      logger.debug(
        { ...context, readOnly: false },
        "SQL security validation passed (classification skipped in write mode)",
      );
      return { classified: false, validatedBy: "none" };
    }

    const classification = this.classifyStatement(
      query,
      context,
      enforceReadOnly,
    );

    logger.debug(
      {
        ...context,
        ...classification,
      },
      "SQL security validation passed",
    );

    return classification;
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
   * Classify the statement with the in-process vscode-db2i parser.
   * When `enforceReadOnly` is true, reject write operations (regex fallback
   * if the parser cannot classify). When false (write mode), still classify
   * so callers can skip wire PARSE under `auto`.
   *
   * @param query - SQL query to validate
   * @param context - Request context for logging
   * @param enforceReadOnly - Whether to reject write statements
   * @returns Classification metadata (classified=true only when vscode-db2i succeeded)
   * @private
   */
  private static classifyStatement(
    query: string,
    context: RequestContext,
    enforceReadOnly: boolean,
  ): SqlValidationClassification {
    // Try IBM i parser first (understands IBM i syntax and uses vscode-db2i).
    const ibmiResult = IbmiSqlParser.parseQuery(query, context);

    // Zero parsed statements (comment-only / empty input) does NOT count as
    // classified, and there is nothing executable to enforce against — return
    // unclassified directly so the wire PARSE_STATEMENT fallback rejects it
    // with a clear error. Do NOT route it through the regex fallback: regex
    // does not strip comments, so "-- TODO: delete old rows" would be falsely
    // rejected as a write operation.
    if (ibmiResult.success && ibmiResult.statementTypes.length === 0) {
      logger.debug(
        { ...context, validatedBy: "ibmi-vscode" },
        "Parser found no executable statements (comment-only or empty input); leaving unclassified for wire PARSE fallback",
      );
      return { classified: false, validatedBy: "ibmi-vscode" };
    }

    if (ibmiResult.success) {
      if (enforceReadOnly && !ibmiResult.isReadOnly) {
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
          isReadOnly: ibmiResult.isReadOnly,
          enforceReadOnly,
        },
        "Statement classified using IBM i vscode parser",
      );

      return {
        classified: true,
        statementTypes: ibmiResult.statementTypes,
        validatedBy: "ibmi-vscode",
      };
    }

    // Fall back to regex write detection (does not yield classified=true)
    logger.debug(
      { ...context, enforceReadOnly },
      "Falling back to regex validation for statement classification",
    );

    const regexResult = SqlSecurityValidatorFallback.validateReadOnly(
      query,
      context,
    );

    if (enforceReadOnly && !regexResult.isValid) {
      this.throwValidationError(
        `Write operations detected: ${regexResult.violations.join(", ")}`,
        regexResult.violations,
        { readOnly: true, validatedBy: "regex-fallback" },
        query,
      );
    }

    logger.debug(
      {
        ...context,
        validatedBy: "regex-fallback",
        enforceReadOnly,
        regexAllowed: regexResult.isValid,
      },
      "Regex fallback completed (classified=false; wire PARSE may still run)",
    );

    return {
      classified: false,
      validatedBy: "regex-fallback",
    };
  }
}

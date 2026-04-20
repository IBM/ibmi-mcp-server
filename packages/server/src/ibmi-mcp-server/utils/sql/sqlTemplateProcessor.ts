/**
 * @fileoverview Shared SQL template processor for consistent template handling
 * Eliminates duplication between YamlSqlExecutor and SqlLoader
 *
 * @deprecated This module is deprecated and no longer actively used.
 * Template functionality has been consolidated into the unified ParameterProcessor.
 * This file is kept for reference but should not be used in new code.
 *
 * @module src/utils/sql/sqlTemplateProcessor
 */

import { logger } from "../../../utils/internal/logger.js";
import {
  RequestContext,
  requestContextService,
} from "../../../utils/internal/requestContext.js";
import { ErrorHandler } from "../../../utils/internal/errorHandler.js";
import { JsonRpcErrorCode } from "../../../types-global/errors.js";

/**
 * Template processing options
 */
export interface TemplateProcessingOptions {
  /** Whether to include detailed logging */
  detailedLogging?: boolean;
  /** Whether to validate template syntax */
  validateSyntax?: boolean;
  /** Custom context for logging */
  context?: RequestContext;
}

/**
 * Template processing result
 */
export interface TemplateProcessingResult {
  /** Processed SQL string */
  sql: string;
  /** Parameters that were used */
  usedParameters: string[];
  /** Parameters that were missing */
  missingParameters: string[];
  /** Processing statistics */
  stats: {
    originalLength: number;
    processedLength: number;
    ifBlocksProcessed: number;
    parametersSubstituted: number;
  };
}

/**
 * Shared SQL template processor
 * Provides consistent template processing across the application
 *
 * @deprecated This class is deprecated and no longer actively used.
 * Use the unified ParameterProcessor instead for all parameter processing needs.
 */
export class SqlTemplateProcessor {
  /**
   * Process SQL template with parameter substitution
   * @param template - SQL template string
   * @param parameters - Parameters for substitution
   * @param options - Processing options
   * @returns Processed SQL string
   */
  static async process(
    template: string,
    parameters: Record<string, unknown>,
    options: TemplateProcessingOptions = {},
  ): Promise<string> {
    const result = await this.processWithDetails(template, parameters, options);
    return result.sql;
  }

  /**
   * Process SQL template with detailed result information
   * @param template - SQL template string
   * @param parameters - Parameters for substitution
   * @param options - Processing options
   * @returns Detailed processing result
   */
  static async processWithDetails(
    template: string,
    parameters: Record<string, unknown>,
    options: TemplateProcessingOptions = {},
  ): Promise<TemplateProcessingResult> {
    const context =
      options.context ||
      requestContextService.createRequestContext({
        operation: "ProcessSqlTemplate",
      });

    const { detailedLogging = false, validateSyntax = true } = options;

    return ErrorHandler.tryCatch(
      async () => {
        // Validate template syntax if requested
        if (validateSyntax) {
          this.validateTemplateSyntax(template);
        }

        const usedParameters: string[] = [];
        const missingParameters: string[] = [];
        let ifBlocksProcessed = 0;
        let parametersSubstituted = 0;

        // Process {{#if condition}} blocks
        let processedSql = template.replace(
          /\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
          (_match, condition, content) => {
            ifBlocksProcessed++;
            const conditionValue = parameters[condition];

            if (conditionValue !== undefined) {
              usedParameters.push(condition);
            }

            const isTruthy = Boolean(conditionValue);
            return isTruthy ? content : "";
          },
        );

        // Process simple parameter substitution {{parameter}}
        processedSql = processedSql.replace(
          /\{\{(\w+)\}\}/g,
          (_match, paramName) => {
            const paramValue = parameters[paramName];
            if (paramValue !== undefined && paramValue !== null) {
              usedParameters.push(paramName);
              parametersSubstituted++;
              return String(paramValue);
            }

            missingParameters.push(paramName);
            logger.warning(
              {
                ...context,
                availableParams: Object.keys(parameters),
              },
              `Parameter '${paramName}' not found in template substitution`,
            );
            return _match; // Return original if parameter not found
          },
        );

        // Remove extra whitespace and clean up
        processedSql = processedSql
          .replace(/\n\s*\n/g, "\n") // Remove empty lines
          .trim();

        const stats = {
          originalLength: template.length,
          processedLength: processedSql.length,
          ifBlocksProcessed,
          parametersSubstituted,
        };

        // Log processing details
        if (detailedLogging) {
          logger.debug({
            ...context,
            ...stats,
            usedParameters,
            missingParameters:
              missingParameters.length > 0 ? missingParameters : undefined,
            finalSql:
              processedSql.length < 200
                ? processedSql
                : processedSql.substring(0, 200) + "...",
          });
        } else {
          logger.debug({
            ...context,
            originalLength: stats.originalLength,
            processedLength: stats.processedLength,
            paramsUsed: usedParameters,
          });
        }

        return {
          sql: processedSql,
          usedParameters: [...new Set(usedParameters)], // Remove duplicates
          missingParameters: [...new Set(missingParameters)],
          stats,
        };
      },
      {
        operation: "ProcessSqlTemplate",
        context,
        errorCode: JsonRpcErrorCode.ValidationError,
      },
    );
  }

  /**
   * Validate template syntax
   * @param template - Template to validate
   * @private
   */
  private static validateTemplateSyntax(template: string): void {
    // Check for balanced {{#if}} and {{/if}} blocks
    const ifBlocks = template.match(/\{\{#if\s+\w+\}\}/g) || [];
    const endIfBlocks = template.match(/\{\{\/if\}\}/g) || [];

    if (ifBlocks.length !== endIfBlocks.length) {
      throw new Error(
        `Unbalanced {{#if}} blocks: found ${ifBlocks.length} opening and ${endIfBlocks.length} closing blocks`,
      );
    }

    // Check for invalid parameter syntax - look for unclosed braces or malformed patterns
    // Look for {{ without matching }} (unclosed opening)
    const unclosedOpening = template.match(/\{\{[^}]*$/gm) || [];

    // Look for {{ containing { (nested braces)
    const nestedBraces = template.match(/\{\{[^}]*\{[^}]*\}\}/g) || [];

    if (unclosedOpening.length > 0 || nestedBraces.length > 0) {
      const allInvalid = [...unclosedOpening, ...nestedBraces];
      throw new Error(
        `Invalid parameter syntax found: ${allInvalid.join(", ")}`,
      );
    }
  }

  /**
   * Extract parameter names from template
   * @param template - Template to analyze
   * @returns Array of parameter names
   */
  static extractParameterNames(template: string): string[] {
    const parameters: string[] = [];

    // Extract from {{#if}} blocks
    const ifMatches = template.match(/\{\{#if\s+(\w+)\}\}/g) || [];
    ifMatches.forEach((match) => {
      const paramName = match.match(/\{\{#if\s+(\w+)\}\}/)?.[1];
      if (paramName) {
        parameters.push(paramName);
      }
    });

    // Extract from {{parameter}} substitutions
    const paramMatches = template.match(/\{\{(\w+)\}\}/g) || [];
    paramMatches.forEach((match) => {
      const paramName = match.match(/\{\{(\w+)\}\}/)?.[1];
      if (paramName) {
        parameters.push(paramName);
      }
    });

    return [...new Set(parameters)]; // Remove duplicates
  }

  /**
   * Check if template has conditional blocks
   * @param template - Template to check
   * @returns True if template contains {{#if}} blocks
   */
  static hasConditionalBlocks(template: string): boolean {
    return /\{\{#if\s+\w+\}\}/.test(template);
  }

  /**
   * Check if template has parameter substitutions
   * @param template - Template to check
   * @returns True if template contains {{parameter}} substitutions
   */
  static hasParameterSubstitutions(template: string): boolean {
    return /\{\{\w+\}\}/.test(template);
  }
}

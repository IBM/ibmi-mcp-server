/**
 * @fileoverview Unified parameter processor for SQL parameter validation and binding
 * Combines validation, type conversion, and SQL parameter binding in a single streamlined interface
 *
 * @module src/utils/sql/parameterProcessor
 */

import { BindingValue } from "@ibm/mapepire-js";
import { logger } from "@/utils/internal/logger.js";
import {
  RequestContext,
  requestContextService,
} from "@/utils/internal/requestContext.js";
import { ErrorHandler } from "@/utils/internal/errorHandler.js";
import { JsonRpcErrorCode, McpError } from "@/types-global/errors.js";
import { SqlToolParameter } from "../../schemas/index.js";

/**
 * Parameter processing mode
 */
export type ParameterMode = "named" | "positional" | "template" | "hybrid";

/**
 * Parameter processing options
 */
export interface ParameterProcessingOptions {
  /** Whether to include detailed logging */
  detailedLogging?: boolean;
  /** Whether to validate parameter syntax */
  validateSyntax?: boolean;
  /** Custom context for logging */
  context?: RequestContext;
  /** Strict type validation */
  strictTypeValidation?: boolean;
}

/**
 * Parameter processing result
 */
export interface ParameterProcessingResult {
  /** Processed SQL string with ? placeholders */
  sql: string;
  /** Parameters in order for binding */
  parameters: BindingValue[];
  /** Parameter names that were found */
  parameterNames: string[];
  /** Parameters that were missing */
  missingParameters: string[];
  /** Detected parameter mode */
  mode: ParameterMode;
  /** Processing statistics */
  stats: {
    originalLength: number;
    processedLength: number;
    namedParametersFound: number;
    positionalParametersFound: number;
    parametersConverted: number;
  };
}

/**
 * Parameter validation result
 */
export interface ValidationResult {
  /** Whether validation passed */
  valid: boolean;
  /** Converted value (if valid) */
  value?: BindingValue;
  /** Validation errors */
  errors: string[];
  /** Validation warnings */
  warnings: string[];
}

/**
 * Named parameter match
 */
interface NamedParameterMatch {
  fullMatch: string;
  paramName: string;
  position: number;
}

/**
 * Unified parameter processor for SQL parameter validation and binding
 * Handles validation, type conversion, and SQL parameter binding in one streamlined interface
 */
export class ParameterProcessor {
  /**
   * Process SQL statement with parameter validation and binding
   * @param sql - SQL statement with parameter placeholders
   * @param parameterValues - Parameter values by name
   * @param parameterDefinitions - YAML parameter definitions for validation
   * @param options - Processing options
   * @returns Processed SQL and parameter array with validation results
   */
  static async process(
    sql: string,
    parameterValues: Record<string, unknown>,
    parameterDefinitions: SqlToolParameter[] = [],
    options: ParameterProcessingOptions = {},
  ): Promise<ParameterProcessingResult> {
    const context =
      options.context ||
      requestContextService.createRequestContext({
        operation: "ProcessParameters",
      });

    const {
      detailedLogging = false,
      validateSyntax = true,
      strictTypeValidation = true,
    } = options;

    return ErrorHandler.tryCatch(
      async () => {
        // Validate SQL syntax if requested
        if (validateSyntax) {
          this.validateSqlSyntax(sql);
        }

        // Step 1: Apply parameter validation and defaults
        const processedParameters = await this.validateAndProcessParameters(
          parameterValues,
          parameterDefinitions,
          context,
        );

        // Step 2: Detect parameter mode and process SQL
        const mode = this.detectParameterMode(sql);

        if (mode === "template") {
          throw new McpError(
            JsonRpcErrorCode.ValidationError,
            "Template mode ({{param}}) is deprecated. Use named parameters (:param) or positional parameters (?) instead.",
            { sql: sql.substring(0, 100) + "..." },
          );
        }

        let result: ParameterProcessingResult;

        switch (mode) {
          case "named":
            result = await this.processNamedParameters(
              sql,
              processedParameters,
              context,
              strictTypeValidation,
            );
            break;
          case "positional":
            result = await this.processPositionalParameters(
              sql,
              processedParameters,
              context,
              strictTypeValidation,
            );
            break;
          case "hybrid":
            result = await this.processHybridParameters(
              sql,
              processedParameters,
              context,
              strictTypeValidation,
            );
            break;
          default:
            // No parameters found
            result = {
              sql,
              parameters: [],
              parameterNames: [],
              missingParameters: [],
              mode: "positional",
              stats: {
                originalLength: sql.length,
                processedLength: sql.length,
                namedParametersFound: 0,
                positionalParametersFound: 0,
                parametersConverted: 0,
              },
            };
        }

        // Log processing details
        if (detailedLogging) {
          logger.debug(
            {
              ...context,
              ...result.stats,
              mode: result.mode,
              parameterNames: result.parameterNames,
              missingParameters:
                result.missingParameters.length > 0
                  ? result.missingParameters
                  : undefined,
            },
            "SQL parameters processed with detailed stats",
          );
        } else {
          logger.debug(
            {
              ...context,
              mode: result.mode,
              parameterCount: result.parameters.length,
              parameterNames: result.parameterNames,
            },
            "SQL parameters processed",
          );
        }

        return result;
      },
      {
        operation: "ProcessParameters",
        context,
        errorCode: JsonRpcErrorCode.ValidationError,
      },
    );
  }

  /**
   * Validate parameters and apply defaults according to YAML definitions
   * @param parameterValues - Raw parameter values
   * @param parameterDefinitions - YAML parameter definitions
   * @param context - Request context
   * @returns Validated and processed parameters
   */
  private static async validateAndProcessParameters(
    parameterValues: Record<string, unknown>,
    parameterDefinitions: SqlToolParameter[],
    context: RequestContext,
  ): Promise<Record<string, unknown>> {
    if (parameterDefinitions.length === 0) {
      return parameterValues;
    }

    const processedParameters = { ...parameterValues };
    const allErrors: string[] = [];
    const allWarnings: string[] = [];

    // Process each parameter definition
    for (const definition of parameterDefinitions) {
      const value = parameterValues[definition.name];
      const validationResult = this.validateParameter(value, definition);

      if (!validationResult.valid) {
        allErrors.push(...validationResult.errors);
      } else {
        allWarnings.push(...validationResult.warnings);

        // Use the validated and converted value
        if (validationResult.value !== undefined) {
          processedParameters[definition.name] = validationResult.value;
        }
      }
    }

    // Report validation errors
    if (allErrors.length > 0) {
      throw new McpError(
        JsonRpcErrorCode.ValidationError,
        `Parameter validation failed: ${allErrors.join(", ")}`,
        { errors: allErrors },
      );
    }

    // Log warnings
    if (allWarnings.length > 0) {
      logger.warning(
        {
          ...context,
          warnings: allWarnings,
        },
        "Parameter validation warnings",
      );
    }

    return processedParameters;
  }

  /**
   * Validate and convert parameter value according to YAML definition
   * @param value - Input value to validate
   * @param definition - YAML parameter definition
   * @returns Validation result with converted value
   */
  private static validateParameter(
    value: unknown,
    definition: SqlToolParameter,
  ): ValidationResult {
    const result: ValidationResult = {
      valid: true,
      errors: [],
      warnings: [],
    };

    try {
      // Handle null/undefined values
      if (value === null || value === undefined) {
        if (definition.required && definition.default === undefined) {
          result.errors.push(
            `Parameter '${definition.name}' is required but not provided`,
          );
          result.valid = false;
          return result;
        }
        if (definition.default !== undefined) {
          return this.validateParameter(definition.default, {
            ...definition,
            required: false,
          });
        }
        // Allow null/undefined for non-required parameters
        result.value = "";
        return result;
      }

      // Type-specific validation
      switch (definition.type) {
        case "string":
          result.value = this.validateStringParameter(
            value,
            definition,
            result,
          );
          break;
        case "integer":
          result.value = this.validateIntegerParameter(
            value,
            definition,
            result,
          );
          break;
        case "float":
          result.value = this.validateFloatParameter(value, definition, result);
          break;
        case "boolean":
          result.value = this.validateBooleanParameter(
            value,
            definition,
            result,
          );
          break;
        case "array":
          result.value = this.validateArrayParameter(value, definition, result);
          break;
        default:
          result.errors.push(`Unsupported parameter type: ${definition.type}`);
          result.valid = false;
      }

      // Enum validation
      if (result.valid && definition.enum && definition.enum.length > 0) {
        this.validateEnumConstraint(result.value!, definition, result);
      }

      result.valid = result.errors.length === 0;
      return result;
    } catch (error) {
      result.errors.push(
        error instanceof Error ? error.message : String(error),
      );
      result.valid = false;
      return result;
    }
  }

  /**
   * Validate string parameter
   */
  private static validateStringParameter(
    value: unknown,
    definition: SqlToolParameter,
    result: ValidationResult,
  ): string {
    let stringValue: string;

    if (typeof value === "string") {
      stringValue = value;
    } else if (typeof value === "number" || typeof value === "boolean") {
      stringValue = String(value);
      result.warnings.push(
        `Parameter '${definition.name}' converted from ${typeof value} to string`,
      );
    } else {
      result.errors.push(
        `Parameter '${definition.name}' must be a string, got ${typeof value}`,
      );
      return "";
    }

    // Length validation
    if (
      definition.minLength !== undefined &&
      stringValue.length < definition.minLength
    ) {
      result.errors.push(
        `Parameter '${definition.name}' must be at least ${definition.minLength} characters long`,
      );
    }
    if (
      definition.maxLength !== undefined &&
      stringValue.length > definition.maxLength
    ) {
      result.errors.push(
        `Parameter '${definition.name}' must be at most ${definition.maxLength} characters long`,
      );
    }

    // Pattern validation
    if (definition.pattern) {
      try {
        const regex = new RegExp(definition.pattern);
        if (!regex.test(stringValue)) {
          result.errors.push(
            `Parameter '${definition.name}' does not match required pattern: ${definition.pattern}`,
          );
        }
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
      } catch (error) {
        result.warnings.push(
          `Invalid pattern for parameter '${definition.name}': ${definition.pattern}`,
        );
      }
    }

    return stringValue;
  }

  /**
   * Validate integer parameter
   */
  private static validateIntegerParameter(
    value: unknown,
    definition: SqlToolParameter,
    result: ValidationResult,
  ): number {
    let numericValue: number;

    if (typeof value === "number") {
      if (!Number.isInteger(value)) {
        result.warnings.push(
          `Parameter '${definition.name}' is a float, converting to integer`,
        );
        numericValue = Math.floor(value);
      } else {
        numericValue = value;
      }
    } else if (typeof value === "string") {
      const parsed = parseInt(value, 10);
      if (isNaN(parsed)) {
        result.errors.push(
          `Parameter '${definition.name}' must be a valid integer, got '${value}'`,
        );
        return 0;
      }
      numericValue = parsed;
      result.warnings.push(
        `Parameter '${definition.name}' converted from string '${value}' to integer ${parsed}`,
      );
    } else if (typeof value === "boolean") {
      numericValue = value ? 1 : 0;
      result.warnings.push(
        `Parameter '${definition.name}' converted from boolean to integer`,
      );
    } else {
      result.errors.push(
        `Parameter '${definition.name}' must be an integer, got ${typeof value}`,
      );
      return 0;
    }

    // Range validation
    if (definition.min !== undefined && numericValue < definition.min) {
      result.errors.push(
        `Parameter '${definition.name}' must be at least ${definition.min}`,
      );
    }
    if (definition.max !== undefined && numericValue > definition.max) {
      result.errors.push(
        `Parameter '${definition.name}' must be at most ${definition.max}`,
      );
    }

    return numericValue;
  }

  /**
   * Validate float parameter
   */
  private static validateFloatParameter(
    value: unknown,
    definition: SqlToolParameter,
    result: ValidationResult,
  ): number {
    let numericValue: number;

    if (typeof value === "number") {
      numericValue = value;
    } else if (typeof value === "string") {
      const parsed = parseFloat(value);
      if (isNaN(parsed)) {
        result.errors.push(
          `Parameter '${definition.name}' must be a valid number, got '${value}'`,
        );
        return 0;
      }
      numericValue = parsed;
      result.warnings.push(
        `Parameter '${definition.name}' converted from string '${value}' to float ${parsed}`,
      );
    } else if (typeof value === "boolean") {
      numericValue = value ? 1.0 : 0.0;
      result.warnings.push(
        `Parameter '${definition.name}' converted from boolean to float`,
      );
    } else {
      result.errors.push(
        `Parameter '${definition.name}' must be a number, got ${typeof value}`,
      );
      return 0;
    }

    // Range validation
    if (definition.min !== undefined && numericValue < definition.min) {
      result.errors.push(
        `Parameter '${definition.name}' must be at least ${definition.min}`,
      );
    }
    if (definition.max !== undefined && numericValue > definition.max) {
      result.errors.push(
        `Parameter '${definition.name}' must be at most ${definition.max}`,
      );
    }

    return numericValue;
  }

  /**
   * Validate boolean parameter
   */
  private static validateBooleanParameter(
    value: unknown,
    definition: SqlToolParameter,
    result: ValidationResult,
  ): number {
    let booleanValue: boolean;

    if (typeof value === "boolean") {
      booleanValue = value;
    } else if (typeof value === "string") {
      const lowerValue = value.toLowerCase();
      if (
        lowerValue === "true" ||
        lowerValue === "1" ||
        lowerValue === "yes" ||
        lowerValue === "on"
      ) {
        booleanValue = true;
      } else if (
        lowerValue === "false" ||
        lowerValue === "0" ||
        lowerValue === "no" ||
        lowerValue === "off"
      ) {
        booleanValue = false;
      } else {
        result.errors.push(
          `Parameter '${definition.name}' must be a valid boolean, got '${value}'`,
        );
        return 0;
      }
      result.warnings.push(
        `Parameter '${definition.name}' converted from string '${value}' to boolean`,
      );
    } else if (typeof value === "number") {
      booleanValue = value !== 0;
      result.warnings.push(
        `Parameter '${definition.name}' converted from number ${value} to boolean`,
      );
    } else {
      result.errors.push(
        `Parameter '${definition.name}' must be a boolean, got ${typeof value}`,
      );
      return 0;
    }

    // Convert boolean to number for DB2 compatibility
    return booleanValue ? 1 : 0;
  }

  /**
   * Validate array parameter
   */
  private static validateArrayParameter(
    value: unknown,
    definition: SqlToolParameter,
    result: ValidationResult,
  ): (string | number)[] {
    if (!Array.isArray(value)) {
      result.errors.push(
        `Parameter '${definition.name}' must be an array, got ${typeof value}`,
      );
      return [];
    }

    // Length validation
    if (
      definition.minLength !== undefined &&
      value.length < definition.minLength
    ) {
      result.errors.push(
        `Parameter '${definition.name}' must have at least ${definition.minLength} items`,
      );
    }
    if (
      definition.maxLength !== undefined &&
      value.length > definition.maxLength
    ) {
      result.errors.push(
        `Parameter '${definition.name}' must have at most ${definition.maxLength} items`,
      );
    }

    // Validate each array item
    const itemType = definition.itemType || "string";
    const convertedArray: (string | number)[] = [];

    for (let i = 0; i < value.length; i++) {
      const item = value[i];
      const itemDefinition: SqlToolParameter = {
        name: `${definition.name}[${i}]`,
        type: itemType,
        required: true,
      };

      const itemResult = this.validateParameter(item, itemDefinition);
      if (!itemResult.valid) {
        result.errors.push(...itemResult.errors);
      } else {
        result.warnings.push(...itemResult.warnings);
        convertedArray.push(itemResult.value as string | number);
      }
    }

    return convertedArray;
  }

  /**
   * Validate enum constraint
   */
  private static validateEnumConstraint(
    value: BindingValue,
    definition: SqlToolParameter,
    result: ValidationResult,
  ): void {
    if (!definition.enum || definition.enum.length === 0) {
      return;
    }

    // Handle array values
    if (Array.isArray(value)) {
      for (const item of value) {
        if (!definition.enum.includes(item as string | number | boolean)) {
          result.errors.push(
            `Parameter '${definition.name}' array item '${item}' is not one of allowed values: ${definition.enum.join(", ")}`,
          );
        }
      }
    } else {
      if (!definition.enum.includes(value as string | number | boolean)) {
        result.errors.push(
          `Parameter '${definition.name}' value '${value}' is not one of allowed values: ${definition.enum.join(", ")}`,
        );
      }
    }
  }

  /**
   * Detect the parameter mode used in the SQL statement
   * @param sql - SQL statement to analyze
   * @returns Detected parameter mode
   */
  private static detectParameterMode(sql: string): ParameterMode {
    const hasNamedParams = /:(\w+)/g.test(sql);
    const hasPositionalParams = /\?/g.test(sql);
    const hasTemplateParams = /\{\{(\w+)\}\}/g.test(sql);

    if (hasTemplateParams) {
      return "template";
    }
    if (hasNamedParams && hasPositionalParams) {
      return "hybrid";
    }
    if (hasNamedParams) {
      return "named";
    }
    if (hasPositionalParams) {
      return "positional";
    }
    return "positional"; // Default mode
  }

  /**
   * Process named parameters (:param)
   * @param sql - SQL statement with named parameters
   * @param parameterValues - Parameter values by name
   * @param context - Request context
   * @param strictTypeValidation - Whether to enforce strict type validation
   * @returns Processing result
   */
  private static async processNamedParameters(
    sql: string,
    parameterValues: Record<string, unknown>,
    context: RequestContext,
    strictTypeValidation: boolean,
  ): Promise<ParameterProcessingResult> {
    const namedParamRegex = /:(\w+)/g;
    const matches: NamedParameterMatch[] = [];
    const parameterNames: string[] = [];
    const missingParameters: string[] = [];
    let match;

    // Find all named parameter matches
    while ((match = namedParamRegex.exec(sql)) !== null) {
      matches.push({
        fullMatch: match[0],
        paramName: match[1]!,
        position: match.index!,
      });
      if (!parameterNames.includes(match[1]!)) {
        parameterNames.push(match[1]!);
      }
    }

    // Convert parameters to BindingValue array in order of appearance
    const parameters: BindingValue[] = [];
    let processedSql = sql;
    let offset = 0;

    for (const paramMatch of matches) {
      const paramName = paramMatch.paramName;

      // Check if parameter exists in the parameter values
      if (!(paramName in parameterValues)) {
        missingParameters.push(paramName);
        logger.warning(
          {
            ...context,
            availableParams: Object.keys(parameterValues),
            missingParam: paramName,
          },
          `Named parameter ':${paramName}' not found in parameter values`,
        );
        continue;
      }

      const paramValue = parameterValues[paramName];

      // Convert and validate parameter value
      const bindingValue = this.convertToBindingValue(
        paramValue,
        paramName,
        strictTypeValidation,
      );

      // Handle array parameters - expand to multiple placeholders
      if (Array.isArray(bindingValue)) {
        // Add each array element as individual parameters
        for (const item of bindingValue) {
          parameters.push(item);
        }

        // Generate multiple ? placeholders for array (?, ?, ?)
        const placeholders = bindingValue.map(() => "?").join(", ");

        // Replace :param with (?, ?, ?)
        const replacePosition = paramMatch.position + offset;
        const beforeReplacement = processedSql.substring(0, replacePosition);
        const afterReplacement = processedSql.substring(
          replacePosition + paramMatch.fullMatch.length,
        );
        processedSql = beforeReplacement + placeholders + afterReplacement;

        // Update offset for subsequent replacements
        offset += placeholders.length - paramMatch.fullMatch.length;

        logger.debug(
          {
            ...context,
            paramName,
            arrayLength: bindingValue.length,
            placeholders,
          },
          `Expanded array parameter to ${bindingValue.length} placeholders`,
        );
      } else {
        // Non-array parameter - standard single placeholder
        parameters.push(bindingValue);

        // Replace :param with ? placeholder
        const replacePosition = paramMatch.position + offset;
        const beforeReplacement = processedSql.substring(0, replacePosition);
        const afterReplacement = processedSql.substring(
          replacePosition + paramMatch.fullMatch.length,
        );
        processedSql = beforeReplacement + "?" + afterReplacement;

        // Update offset for subsequent replacements
        offset += 1 - paramMatch.fullMatch.length;
      }
    }

    return {
      sql: processedSql,
      parameters,
      parameterNames,
      missingParameters,
      mode: "named",
      stats: {
        originalLength: sql.length,
        processedLength: processedSql.length,
        namedParametersFound: matches.length,
        positionalParametersFound: 0,
        parametersConverted: parameters.length,
      },
    };
  }

  /**
   * Process positional parameters (?)
   * @param sql - SQL statement with positional parameters
   * @param parameterValues - Parameter values by name or index
   * @param context - Request context
   * @param strictTypeValidation - Whether to enforce strict type validation
   * @returns Processing result
   */
  private static async processPositionalParameters(
    sql: string,
    parameterValues: Record<string, unknown>,
    context: RequestContext,
    strictTypeValidation: boolean,
  ): Promise<ParameterProcessingResult> {
    const positionalParamRegex = /\?/g;
    const parameterCount = (sql.match(positionalParamRegex) || []).length;

    // Convert parameters to array in order
    const parameters: BindingValue[] = [];
    const parameterNames: string[] = [];
    const missingParameters: string[] = [];

    // Extract parameters using zero-based indexing
    for (let i = 0; i < parameterCount; i++) {
      let paramValue: unknown;
      let paramName: string;

      // Try zero-based index parameter (0, 1, 2, ...)
      if (parameterValues[i.toString()] !== undefined) {
        paramValue = parameterValues[i.toString()];
        paramName = i.toString();
      }
      // Take parameters in order of Object.keys
      else {
        const keys = Object.keys(parameterValues);
        if (i < keys.length) {
          paramName = keys[i]!;
          paramValue = parameterValues[paramName];
        } else {
          paramName = `param_${i}`;
          paramValue = undefined;
        }
      }

      parameterNames.push(paramName);

      if (paramValue === undefined || paramValue === null) {
        missingParameters.push(paramName);
        logger.warning(
          {
            ...context,
            availableParams: Object.keys(parameterValues),
            missingIndex: i,
          },
          `Positional parameter at index ${i} not found`,
        );
        continue;
      }

      // Convert and validate parameter value
      const bindingValue = this.convertToBindingValue(
        paramValue,
        paramName,
        strictTypeValidation,
      );
      parameters.push(bindingValue);
    }

    return {
      sql,
      parameters,
      parameterNames,
      missingParameters,
      mode: "positional",
      stats: {
        originalLength: sql.length,
        processedLength: sql.length,
        namedParametersFound: 0,
        positionalParametersFound: parameterCount,
        parametersConverted: parameters.length,
      },
    };
  }

  /**
   * Process hybrid parameters (mix of named and positional)
   * @param sql - SQL statement with mixed parameters
   * @param parameterValues - Parameter values by name
   * @param context - Request context
   * @param strictTypeValidation - Whether to enforce strict type validation
   * @returns Processing result
   */
  private static async processHybridParameters(
    sql: string,
    parameterValues: Record<string, unknown>,
    context: RequestContext,
    strictTypeValidation: boolean,
  ): Promise<ParameterProcessingResult> {
    logger.warning(
      {
        ...context,
        sql: sql.substring(0, 100) + "...",
      },
      "Hybrid parameter mode detected - processing named parameters first",
    );

    // Process named parameters first, then handle any remaining positional ones
    const namedResult = await this.processNamedParameters(
      sql,
      parameterValues,
      context,
      strictTypeValidation,
    );

    // If there are still ? placeholders, process them as positional
    const positionalParamCount = (namedResult.sql.match(/\?/g) || []).length;
    if (positionalParamCount > namedResult.parameters.length) {
      logger.debug(
        {
          ...context,
          remainingPositional:
            positionalParamCount - namedResult.parameters.length,
        },
        "Processing remaining positional parameters in hybrid mode",
      );
    }

    return {
      ...namedResult,
      mode: "hybrid",
      stats: {
        ...namedResult.stats,
        positionalParametersFound: positionalParamCount,
      },
    };
  }

  /**
   * Convert a parameter value to BindingValue
   * @param value - Parameter value to convert
   * @param paramName - Parameter name for error messages
   * @param strictTypeValidation - Whether to enforce strict type validation
   * @returns Converted BindingValue
   */
  private static convertToBindingValue(
    value: unknown,
    paramName: string,
    strictTypeValidation: boolean,
  ): BindingValue {
    // BindingValue = string | number | (string | number)[]

    if (value === null || value === undefined) {
      if (strictTypeValidation) {
        throw new McpError(
          JsonRpcErrorCode.ValidationError,
          `Parameter '${paramName}' cannot be null or undefined`,
          { paramName, value },
        );
      }
      return "";
    }

    // Handle arrays
    if (Array.isArray(value)) {
      const convertedArray = value.map((item, index) => {
        if (typeof item === "string" || typeof item === "number") {
          return item;
        }
        if (strictTypeValidation) {
          throw new McpError(
            JsonRpcErrorCode.ValidationError,
            `Array parameter '${paramName}[${index}]' must contain only strings or numbers`,
            { paramName, index, itemType: typeof item, itemValue: item },
          );
        }
        return String(item);
      });
      return convertedArray;
    }

    // Handle primitives
    if (typeof value === "string" || typeof value === "number") {
      return value;
    }

    // Handle booleans
    if (typeof value === "boolean") {
      return value ? 1 : 0; // Convert boolean to number for DB2
    }

    // Handle other types
    if (strictTypeValidation) {
      throw new McpError(
        JsonRpcErrorCode.ValidationError,
        `Parameter '${paramName}' must be string, number, boolean, or array of strings/numbers`,
        { paramName, type: typeof value, value },
      );
    }

    // Convert to string as fallback
    return String(value);
  }

  /**
   * Validate SQL statement syntax for parameter processing
   * @param sql - SQL statement to validate
   * @throws McpError if syntax is invalid
   */
  private static validateSqlSyntax(sql: string): void {
    // Check for malformed named parameters
    const malformedNamedParams = sql.match(/:(\d)/g);
    if (malformedNamedParams) {
      throw new McpError(
        JsonRpcErrorCode.ValidationError,
        `Invalid named parameter syntax found: ${malformedNamedParams.join(", ")}. Named parameters must start with a letter.`,
        { malformedParams: malformedNamedParams },
      );
    }

    // Check for unmatched quotes that could affect parameter parsing
    const singleQuotes = (sql.match(/'/g) || []).length;
    const doubleQuotes = (sql.match(/"/g) || []).length;

    if (singleQuotes % 2 !== 0) {
      throw new McpError(
        JsonRpcErrorCode.ValidationError,
        "Unmatched single quotes in SQL statement",
        { singleQuoteCount: singleQuotes },
      );
    }

    if (doubleQuotes % 2 !== 0) {
      throw new McpError(
        JsonRpcErrorCode.ValidationError,
        "Unmatched double quotes in SQL statement",
        { doubleQuoteCount: doubleQuotes },
      );
    }
  }

  /**
   * Extract parameter names from SQL statement
   * @param sql - SQL statement to analyze
   * @returns Array of unique parameter names
   */
  static extractParameterNames(sql: string): string[] {
    const namedParamRegex = /:(\w+)/g;
    const parameterNames: string[] = [];
    let match;

    while ((match = namedParamRegex.exec(sql)) !== null) {
      if (!parameterNames.includes(match[1]!)) {
        parameterNames.push(match[1]!);
      }
    }

    return parameterNames;
  }

  /**
   * Count positional parameters in SQL statement
   * @param sql - SQL statement to analyze
   * @returns Number of ? placeholders
   */
  static countPositionalParameters(sql: string): number {
    return (sql.match(/\?/g) || []).length;
  }

  /**
   * Check if SQL statement has any parameters
   * @param sql - SQL statement to check
   * @returns True if statement contains parameters
   */
  static hasParameters(sql: string): boolean {
    return (
      this.detectParameterMode(sql) !== "positional" ||
      this.countPositionalParameters(sql) > 0
    );
  }
}

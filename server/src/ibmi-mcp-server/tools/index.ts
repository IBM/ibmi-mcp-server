/**
 * IBM i MCP Tools
 * Barrel file exporting all tool definitions
 *
 * @feature 001-tool-factory
 */

export { default as generateSql } from "./generateSql.tool.js";
export { default as executeSql } from "./executeSql.tool.js";
export { default as echo } from "./echo.tool.js";

/**
 * Tool Definitions Barrel Export
 *
 * Centralized export of all factory pattern tool definitions.
 * Pattern inspired by mcp-ts-template.
 *
 * @module tools/definitions
 */

import echoTool from "./echo.tool.js";
import executeSqlTool from "./executeSql.tool.js";
import generateSqlTool from "./generateSql.tool.js";

/**
 * Array of all tool definitions for automated registration.
 *
 * To add a new tool:
 * 1. Create the tool definition file (e.g., myTool.tool.ts)
 * 2. Import it above
 * 3. Add it to this array
 *
 * The ToolRegistry will automatically register all tools in this array.
 */
export const allToolDefinitions = [echoTool, executeSqlTool, generateSqlTool];

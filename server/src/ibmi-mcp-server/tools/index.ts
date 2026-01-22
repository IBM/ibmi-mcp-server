/**
 * Tool Definitions Barrel Export
 *
 * Centralized export of all factory pattern tool definitions.
 *
 * @module tools/definitions
 */

import { executeSqlTool } from "./executeSql.tool.js";
import { generateSqlTool } from "./generateSql.tool.js";

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
export const allToolDefinitions = [executeSqlTool, generateSqlTool];

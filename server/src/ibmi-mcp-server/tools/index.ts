/**
 * Tool Definitions Barrel Export
 *
 * Centralized export of all factory pattern tool definitions.
 * Includes the default text-to-SQL toolset (controlled by IBMI_ENABLE_DEFAULT_TOOLS)
 * alongside always-available tools.
 *
 * @module tools/definitions
 */

import { config } from "../../config/index.js";
import { executeSqlTool } from "./executeSql.tool.js";
import { generateSqlTool } from "./generateSql.tool.js";
import { listSchemasTool } from "./listSchemas.tool.js";
import { listTablesInSchemaTool } from "./listTablesInSchema.tool.js";
import { getTableColumnsTool } from "./getTableColumns.tool.js";
import { validateQueryTool } from "./validateQuery.tool.js";

/**
 * Default text-to-SQL toolset, enabled via IBMI_ENABLE_DEFAULT_TOOLS (default: true).
 * These tools provide schema discovery and query validation for LLM workflows:
 *   list_schemas → list_tables_in_schema → get_table_columns → validate_query → execute_sql
 */
const defaultTools = config.ibmi_enableDefaultTools
  ? [listSchemasTool, listTablesInSchemaTool, getTableColumnsTool, validateQueryTool]
  : [];

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
export const allToolDefinitions = [
  executeSqlTool, // Controlled by IBMI_ENABLE_EXECUTE_SQL or IBMI_ENABLE_DEFAULT_TOOLS
  generateSqlTool, // Always available (describe_sql_object)
  ...defaultTools, // Conditionally included default toolset
];

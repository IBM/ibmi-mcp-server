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
import { getRelatedObjectsTool } from "./getRelatedObjects.tool.js";

/**
 * Returns all tool definitions for automated registration.
 *
 * This is a function (not a constant) because the config values it depends on
 * (e.g., ibmi_enableDefaultTools) may be set by CLI argument overrides that
 * run after ES module evaluation. A top-level constant would capture the
 * pre-override defaults and miss CLI flags like --builtin-tools.
 *
 * The default text-to-SQL toolset is enabled via IBMI_ENABLE_DEFAULT_TOOLS
 * or --builtin-tools CLI flag (default: false). These tools provide schema
 * discovery and query validation for LLM workflows:
 *   list_schemas → list_tables_in_schema → get_table_columns → get_related_objects → validate_query → execute_sql
 *
 * To add a new tool:
 * 1. Create the tool definition file (e.g., myTool.tool.ts)
 * 2. Import it above
 * 3. Add it to the returned array
 */
export function getAllToolDefinitions() {
  const defaultTools = config.ibmi_enableDefaultTools
    ? [
        listSchemasTool,
        listTablesInSchemaTool,
        getTableColumnsTool,
        getRelatedObjectsTool,
        validateQueryTool,
      ]
    : [];

  return [
    executeSqlTool, // Controlled by IBMI_ENABLE_EXECUTE_SQL or IBMI_ENABLE_DEFAULT_TOOLS
    generateSqlTool, // Always available (describe_sql_object)
    ...defaultTools, // Conditionally included default toolset
  ];
}

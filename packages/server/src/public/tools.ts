/**
 * Public tool surface consumed by `@ibm/ibmi-cli`.
 *
 * Stable re-exports of tool definitions and their standalone `*Logic`
 * functions. Treat additions as part of the package's public API — the
 * CLI pins this package at an exact version on every release.
 */

export {
  executeSqlTool,
  configureExecuteSqlTool,
} from "../ibmi-mcp-server/tools/executeSql.tool.js";
export {
  generateSqlTool,
  OBJECT_TYPES,
} from "../ibmi-mcp-server/tools/generateSql.tool.js";
export {
  listSchemasTool,
  listSchemasLogic,
} from "../ibmi-mcp-server/tools/listSchemas.tool.js";
export {
  listTablesInSchemaTool,
  listTablesLogic,
} from "../ibmi-mcp-server/tools/listTablesInSchema.tool.js";
export {
  getTableColumnsTool,
  getTableColumnsLogic,
} from "../ibmi-mcp-server/tools/getTableColumns.tool.js";
export {
  getRelatedObjectsTool,
  getRelatedObjectsLogic,
} from "../ibmi-mcp-server/tools/getRelatedObjects.tool.js";
export {
  validateQueryTool,
  validateQueryLogic,
} from "../ibmi-mcp-server/tools/validateQuery.tool.js";

export type { SdkContext } from "../mcp-server/tools/utils/types.js";

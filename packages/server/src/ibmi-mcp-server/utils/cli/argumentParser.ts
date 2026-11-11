/**
 * @fileoverview Command-line argument parser for MCP server
 * Handles --tools argument and sets environment variables accordingly
 * @module src/utils/cli/argumentParser
 */

import { parseArgs } from "util";

type mcpTransportType = "stdio" | "http";

export interface CliArguments {
  tools?: string;
  transport?: mcpTransportType;
  toolsets?: string[];
  listToolsets?: boolean;
  builtinTools?: boolean;
  executeSql?: boolean;
  /** A command for the admin socket of a running server. */
  admin?: string;
  help?: boolean;
}

/**
 * Parses process.argv into CliArguments.
 *
 * Both `--flag value` and `--flag=value` are accepted. When a flag is
 * repeated, the last occurrence wins.
 *
 * @throws {Error} For an unknown flag, a flag without its value, a positional
 *   argument or an invalid transport type. The message is meant for the user.
 */
export function parseCliArguments(): CliArguments {
  const { values } = parseArgs({
    // parseArgs only knows one-letter short options; -ts is spelled out.
    args: process.argv
      .slice(2)
      .map((arg) => (arg === "-ts" ? "--toolsets" : arg)),
    options: {
      tools: { type: "string" },
      transport: { type: "string", short: "t" },
      toolsets: { type: "string" },
      "list-toolsets": { type: "boolean" },
      "builtin-tools": { type: "boolean" },
      "execute-sql": { type: "boolean" },
      admin: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });

  const { transport } = values;
  if (
    transport !== undefined &&
    transport !== "stdio" &&
    transport !== "http"
  ) {
    throw new Error(
      `Invalid transport type: ${transport}. Use "stdio" or "http".`,
    );
  }

  return {
    tools: values.tools,
    transport,
    // Split by comma and trim whitespace
    toolsets: values.toolsets
      ?.split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0),
    listToolsets: values["list-toolsets"],
    builtinTools: values["builtin-tools"],
    executeSql: values["execute-sql"],
    admin: values.admin,
    help: values.help,
  };
}

/**
 * Shows help information for CLI usage
 */
export function showHelp(): void {
  console.log(`
IBM i MCP Server

Usage: npx @ibm/ibmi-mcp-server [options]

Options:
  --tools <path>    Path to YAML tools configuration
                    Supports:
                      - Files: performance.yaml, config.yml
                      - Directories: tools/, custom-tools/
                      - Globs: "**/*.yaml" (quote for shell safety)
  --toolsets, -ts <list>   Comma-separated list of toolsets (e.g., "performance,system")
  --list-toolsets   List all available toolsets and exit
  --transport, -t <type>   Transport type: "stdio" or "http"
  --builtin-tools   Enable built-in schema discovery tools (list_schemas,
                    list_tables_in_schema, get_table_columns, get_related_objects,
                    validate_query)
  --execute-sql     Enable the execute_sql tool (combine with --builtin-tools
                    for the full text-to-SQL workflow)
  --admin <command> Send one command to the admin socket (OAUTH_ADMIN_SOCKET)
                    of a running server, print its reply and exit:
                      - status
                      - unblock <profile>
                      - revoke <profile|grantId>

  -h, --help       Show this help message

Examples:
  npx @ibm/ibmi-mcp-server --builtin-tools --execute-sql
  npx @ibm/ibmi-mcp-server --builtin-tools --transport http
  npx @ibm/ibmi-mcp-server --builtin-tools --execute-sql --tools tools/performance/performance.yaml
  npx @ibm/ibmi-mcp-server --tools tools
  npx @ibm/ibmi-mcp-server --toolsets performance,system
  npx @ibm/ibmi-mcp-server --list-toolsets --tools tools
  npx @ibm/ibmi-mcp-server --admin "unblock MYUSER"

Environment Variables:
  TOOLS_YAML_PATH              Path to YAML tools (CLI --tools takes precedence)
  MCP_TRANSPORT_TYPE           Transport mode: 'stdio' (default) or 'http'
  MCP_LOG_LEVEL                Log level: debug, info, warning, error
  IBMI_ENABLE_DEFAULT_TOOLS    Enable built-in tools (default: false)
  IBMI_ENABLE_EXECUTE_SQL      Enable execute_sql tool (default: false)
  IBMI_EXECUTE_SQL_READONLY    Restrict execute_sql to SELECT only (default: true)

  See .env.example for complete environment variable reference.

Note: The server runs in stdio mode by default for MCP client integration.
Use MCP_TRANSPORT_TYPE=http for HTTP mode testing.
`);
}

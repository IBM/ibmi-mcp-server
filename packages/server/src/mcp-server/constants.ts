/**
 * Global constants for MCP-related configuration and specification metadata.
 */

/**
 * The MCP specification snapshot version used by this server.
 * Keep in sync with documentation references and transport implementations.
 */
export const MCP_SPEC_VERSION = "2025-06-18" as const;

/** Base URL to the MCP specification directory for the selected version. */
export const MCP_SPEC_URL_BASE =
  "https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification" as const;

/** Convenience link to the stdio transport spec for the selected version. */
export const MCP_STDIO_SPEC_URL =
  `${MCP_SPEC_URL_BASE}/${MCP_SPEC_VERSION}/basic/transports.mdx#stdio` as const;

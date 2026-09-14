/**
 * @fileoverview Rewrites tool schema dialect on tools/list for strict 2020-12 clients.
 *
 * The MCP TypeScript SDK stamps draft-07 on tools/list schemas
 * (modelcontextprotocol/typescript-sdk#2084); 2020-12-only clients reject
 * them. The schemas are valid under both dialects, so only the declared
 * dialect needs rewriting. Remove once typescript-sdk#2085 ships.
 *
 * @module mcp-server/schema/advertiseJsonSchema202012
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** SEP-1613 default dialect URI (no trailing hash; matches upstream v2 emission). */
export const JSON_SCHEMA_2020_12 =
  "https://json-schema.org/draft/2020-12/schema";

/** Draft-07 `$schema` URIs emitted by zod-to-json-schema / MCP SDK v1. */
const DRAFT_07_URIS = new Set([
  "http://json-schema.org/draft-07/schema#",
  "https://json-schema.org/draft-07/schema#",
  "http://json-schema.org/draft-07/schema",
  "https://json-schema.org/draft-07/schema",
]);

type JsonSchemaDocument = { $schema?: string };

type ListedTool = {
  inputSchema?: JsonSchemaDocument;
  outputSchema?: JsonSchemaDocument;
};

type ListToolsResult = {
  tools: ListedTool[];
};

type ListToolsHandler = (
  request: unknown,
  extra: unknown,
) => Promise<ListToolsResult>;

/**
 * Rewrites draft-07 `$schema` on a single JSON Schema document.
 * Other dialects and schemas without `$schema` are left unchanged.
 */
export function rewriteSchemaDialect(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") {
    return schema;
  }

  const doc = schema as JsonSchemaDocument;
  if (!doc.$schema || !DRAFT_07_URIS.has(doc.$schema)) {
    return schema;
  }

  return { ...doc, $schema: JSON_SCHEMA_2020_12 };
}

/**
 * Rewrites draft-07 `$schema` on every tool's input and output schemas.
 */
export function rewriteToolsListDialect(result: ListToolsResult): ListToolsResult {
  for (const tool of result.tools ?? []) {
    if (tool.inputSchema?.$schema) {
      tool.inputSchema = rewriteSchemaDialect(
        tool.inputSchema,
      ) as JsonSchemaDocument;
    }
    if (tool.outputSchema?.$schema) {
      tool.outputSchema = rewriteSchemaDialect(
        tool.outputSchema,
      ) as JsonSchemaDocument;
    }
  }
  return result;
}

/**
 * Wraps the SDK's tools/list handler so advertised schemas declare 2020-12.
 * Call after all tools are registered.
 */
export function advertiseJsonSchema202012(server: McpServer["server"]): void {
  const handlers = (
    server as unknown as {
      _requestHandlers: Map<string, ListToolsHandler>;
    }
  )._requestHandlers;

  const listTools = handlers.get("tools/list");
  if (!listTools) {
    return;
  }

  handlers.set("tools/list", async (request, extra) => {
    const result = await listTools(request, extra);
    return rewriteToolsListDialect(result);
  });
}

/**
 * @fileoverview Tests for tools/list JSON Schema dialect rewrite shim.
 * @module tests/unit/schema/advertiseJsonSchema202012.test
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import {
  JSON_SCHEMA_2020_12,
  advertiseJsonSchema202012,
  rewriteSchemaDialect,
} from "../../../src/mcp-server/schema/advertiseJsonSchema202012.js";

const DRAFT_07_URI = "http://json-schema.org/draft-07/schema#";

describe("advertiseJsonSchema202012", () => {
  it("rewrites draft-07 $schema and leaves other schemas unchanged", () => {
    const unchanged = { $schema: JSON_SCHEMA_2020_12, type: "object" };
    const noSchema = { type: "object" };

    expect(
      rewriteSchemaDialect({
        $schema: DRAFT_07_URI,
        type: "object",
      }),
    ).toMatchObject({ $schema: JSON_SCHEMA_2020_12 });

    expect(
      rewriteSchemaDialect({
        $schema: "https://json-schema.org/draft-07/schema#",
        type: "object",
      }),
    ).toMatchObject({ $schema: JSON_SCHEMA_2020_12 });

    expect(rewriteSchemaDialect(unchanged)).toBe(unchanged);
    expect(rewriteSchemaDialect(noSchema)).toBe(noSchema);
  });

  it("wraps tools/list and rewrites schemas in the response", async () => {
    const original = vi.fn().mockResolvedValue({
      tools: [
        {
          name: "example",
          inputSchema: { $schema: DRAFT_07_URI, type: "object" },
          outputSchema: { $schema: DRAFT_07_URI, type: "object" },
        },
      ],
    });
    const handlers = new Map([["tools/list", original]]);
    const server = { _requestHandlers: handlers } as unknown as McpServer["server"];

    advertiseJsonSchema202012(server);

    const wrapped = handlers.get("tools/list");
    expect(wrapped).toBeDefined();
    expect(wrapped).not.toBe(original);

    const result = await wrapped!({}, {});
    expect(original).toHaveBeenCalledOnce();
    expect(result.tools[0]?.inputSchema?.$schema).toBe(JSON_SCHEMA_2020_12);
    expect(result.tools[0]?.outputSchema?.$schema).toBe(JSON_SCHEMA_2020_12);
  });
});

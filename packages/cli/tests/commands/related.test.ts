import { describe, it, expect, vi } from "vitest";
import { createProgram } from "../../src/program.js";

vi.mock("../../src/utils/command-helpers.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/utils/command-helpers.js")>();
  return {
    ...actual,
    // Run the action directly — no system resolution, connection, or rendering
    withConnection: vi.fn(
      async (
        _cmd: unknown,
        _toolName: string,
        action: (resolved: unknown, ctx: unknown) => Promise<unknown>,
      ) => {
        await action({}, {});
      },
    ),
  };
});

vi.mock("@ibm/ibmi-mcp-server/tools", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@ibm/ibmi-mcp-server/tools")>();
  return {
    ...actual,
    getRelatedObjectsLogic: vi.fn().mockResolvedValue({
      success: true,
      data: [],
      rowCount: 0,
    }),
  };
});

describe("ibmi related command", () => {
  it("should register the related command with correct description", () => {
    const program = createProgram();
    const related = program.commands.find((c) => c.name() === "related");
    expect(related).toBeDefined();
    expect(related?.description()).toBe(
      "Find objects that depend on a database file",
    );
  });

  it("should have 2 required arguments: library and object", () => {
    const program = createProgram();
    const related = program.commands.find((c) => c.name() === "related");
    const args = related?.registeredArguments;
    expect(args).toHaveLength(2);
    expect(args?.[0]?.name()).toBe("library");
    expect(args?.[0]?.required).toBe(true);
    expect(args?.[1]?.name()).toBe("object");
    expect(args?.[1]?.required).toBe(true);
  });

  it("should have --type option for filtering by object type", () => {
    const program = createProgram();
    const related = program.commands.find((c) => c.name() === "related");
    const typeOpt = related?.options.find((o) => o.long === "--type");
    expect(typeOpt).toBeDefined();
  });

  it("should upper-case --type before filtering", async () => {
    const { getRelatedObjectsLogic } = await import("@ibm/ibmi-mcp-server/tools");

    const program = createProgram();
    program.exitOverride();
    await program.parseAsync([
      "node", "ibmi", "related", "APPLIB", "ORDERS", "--type", "index",
    ]);

    expect(vi.mocked(getRelatedObjectsLogic).mock.calls[0]?.[0]).toEqual({
      library_name: "APPLIB",
      file_name: "ORDERS",
      object_type_filter: "INDEX",
    });
  });
});

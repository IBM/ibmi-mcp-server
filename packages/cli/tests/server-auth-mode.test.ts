/**
 * @fileoverview The CLI runs the server's tool logic on the connection of the
 * system it was asked for. How an MCP server authenticates its HTTP clients
 * (`MCP_AUTH_MODE`, typically in the `.env` file of the directory the CLI is
 * started in) must not reach it.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { SdkContext } from "@ibm/ibmi-mcp-server/tools";

const NAMES = ["MCP_AUTH_MODE", "MCP_RESOURCE_URL", "OAUTH_ISSUER_URL"];
const saved = Object.fromEntries(
  NAMES.map((name) => [name, process.env[name]]),
);

afterEach(() => {
  vi.restoreAllMocks();
  for (const name of NAMES) {
    if (saved[name] === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = saved[name];
    }
  }
});

describe("an environment that selects the server's built-in IBM i sign-on", () => {
  it.each([
    [
      "complete",
      {
        MCP_AUTH_MODE: "oauth",
        MCP_RESOURCE_URL: "https://mcp.example.com/mcp",
      },
    ],
    // Without MCP_RESOURCE_URL the server would reject the whole environment.
    ["incomplete", { MCP_AUTH_MODE: "oauth" }],
  ])(
    "%s: a command's SQL still runs on the system's own connection, and the environment is not rejected",
    async (_case, environment) => {
      for (const name of NAMES) {
        delete process.env[name];
      }
      Object.assign(process.env, environment);
      const complaints = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      vi.resetModules();

      // The CLI, then the server modules its commands load.
      await import("../src/program.js");
      const { listSchemasLogic } = await import("@ibm/ibmi-mcp-server/tools");
      const { IBMiConnectionPool } =
        await import("@ibm/ibmi-mcp-server/services");
      const executeQuery = vi
        .spyOn(IBMiConnectionPool, "executeQuery")
        .mockResolvedValue({
          success: true,
          data: [{ SCHEMA_NAME: "MYLIB" }],
        } as never);

      const result = await listSchemasLogic(
        { include_system: false, limit: 10, offset: 0 },
        { requestId: "server-auth-mode-test", timestamp: "" },
        {} as SdkContext,
      );

      expect(result).toMatchObject({ success: true });
      expect(executeQuery).toHaveBeenCalledOnce();
      expect(
        complaints.mock.calls.filter(([message]) =>
          String(message).includes("Invalid environment variables"),
        ),
      ).toEqual([]);
    },
  );
});

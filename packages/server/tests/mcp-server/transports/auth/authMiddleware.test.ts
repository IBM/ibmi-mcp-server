import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthMiddleware } from "../../../../src/mcp-server/transports/auth/authMiddleware.js";
import { logger } from "../../../../src/utils/index.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("authMiddleware", () => {
  it("logs why a request was refused, from the challenge, without the token", async () => {
    const lines: string[] = [];
    vi.spyOn(logger, "info").mockImplementation((...args: unknown[]) => {
      lines.push(JSON.stringify(args));
    });
    const app = new Hono();
    app.use(
      "*",
      createAuthMiddleware({
        authenticate: async () =>
          new Response(null, {
            status: 401,
            headers: {
              "WWW-Authenticate":
                'Bearer error="invalid_token", error_description="connection closed, refresh"',
            },
          }),
      }),
    );
    app.post("/mcp", (c) => c.text("not reached"));

    const response = await app.request("/mcp", {
      method: "POST",
      headers: { Authorization: "Bearer secret-token-value" },
    });

    expect(response.status).toBe(401);
    const refusal = lines.find((line) =>
      line.includes("Request refused by authentication."),
    );
    expect(refusal).toContain('"error":"invalid_token"');
    expect(refusal).toContain(
      '"errorDescription":"connection closed, refresh"',
    );
    expect(lines.join("\n")).not.toContain("secret-token-value");
  });
});

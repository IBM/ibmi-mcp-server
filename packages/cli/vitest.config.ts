import { tmpdir } from "os";
import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    testTimeout: 15000,
    dir: "tests",
    // Importing server modules creates log files; keep them out of the
    // developer's real ~/.ibmi-mcp-server/logs.
    env: { LOGS_DIR: path.join(tmpdir(), "ibmi-cli-test-logs") },
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
      exclude: ["**/*.d.ts", "src/index.ts"],
    },
  },
});

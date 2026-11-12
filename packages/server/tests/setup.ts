import { vi } from "vitest";

// Suppress all logging in tests - creates silent no-op functions
vi.mock("../src/utils/internal/logger.js", () => ({
  logger: {
    info: () => {},
    debug: () => {},
    warn: () => {},
    warning: () => {}, // MCP-specific log level
    error: () => {},
    trace: () => {},
    fatal: () => {},
  },
}));

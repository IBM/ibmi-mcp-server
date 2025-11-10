import { beforeAll, afterEach, afterAll, vi } from "vitest";

// Suppress all logging in tests - creates silent no-op functions
vi.mock("../src/utils/internal/logger.js", () => ({
  logger: {
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: () => {},
    trace: () => {},
    fatal: () => {},
  },
}));

// Global test setup without MSW - tests use real APIs or isolated MSW servers
beforeAll(() => {
  // Any global setup can go here
});

afterEach(() => {
  // Clean up between tests
});

afterAll(() => {
  // Global cleanup
});

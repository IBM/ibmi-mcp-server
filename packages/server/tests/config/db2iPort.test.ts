/**
 * @fileoverview Unit tests for DB2i_PORT via config.db2i.
 */

import { afterEach, describe, it, expect } from "vitest";
import { config } from "../../src/config/index.js";

describe("config.db2i port", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  function setRequiredCreds() {
    process.env.DB2i_HOST = "testhost";
    process.env.DB2i_USER = "testuser";
    process.env.DB2i_PASS = "testpass";
  }

  it("defaults port to 8076 when DB2i_PORT is unset", () => {
    setRequiredCreds();
    delete process.env.DB2i_PORT;

    expect(config.db2i?.port).toBe(8076);
  });

  it("reads DB2i_PORT from the environment", () => {
    setRequiredCreds();
    process.env.DB2i_PORT = "8077";

    expect(config.db2i?.port).toBe(8077);
  });

  it("rejects invalid DB2i_PORT values", () => {
    setRequiredCreds();
    process.env.DB2i_PORT = "abc";

    expect(() => config.db2i?.port).toThrow();
  });
});

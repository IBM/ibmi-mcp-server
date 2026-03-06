import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "path";
import os from "os";

// Mock fs before imports
vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockMkdirSync = vi.mocked(mkdirSync);

// Import after mocking
import {
  loadConfig,
  getUserConfigPath,
  getProjectConfigPath,
  saveUserConfig,
  upsertSystem,
  removeSystem,
  setDefaultSystem,
} from "../../../src/cli/config/loader.js";

describe("config/loader", () => {
  const originalCwd = process.cwd;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no config files exist
    mockExistsSync.mockReturnValue(false);
  });

  afterEach(() => {
    process.cwd = originalCwd;
    process.env = { ...originalEnv };
  });

  describe("getUserConfigPath", () => {
    it("should return ~/.ibmi/config.yaml", () => {
      const result = getUserConfigPath();
      expect(result).toBe(path.join(os.homedir(), ".ibmi", "config.yaml"));
    });
  });

  describe("getProjectConfigPath", () => {
    it("should walk up directories to find .ibmi/config.yaml", () => {
      const projectRoot = "/home/user/project";
      const deepDir = "/home/user/project/server/src/cli";
      process.cwd = () => deepDir;

      // Only the project root has the config
      mockExistsSync.mockImplementation((p) => {
        return p === path.join(projectRoot, ".ibmi", "config.yaml");
      });

      const result = getProjectConfigPath();
      expect(result).toBe(path.join(projectRoot, ".ibmi", "config.yaml"));
    });

    it("should fall back to cwd/.ibmi/config.yaml when not found", () => {
      process.cwd = () => "/tmp/no-config";
      mockExistsSync.mockReturnValue(false);

      const result = getProjectConfigPath();
      expect(result).toBe(path.join("/tmp/no-config", ".ibmi", "config.yaml"));
    });
  });

  describe("loadConfig", () => {
    it("should return empty config when no files exist", () => {
      process.cwd = () => "/tmp/empty";
      mockExistsSync.mockReturnValue(false);

      const config = loadConfig();
      expect(config).toEqual({ systems: {} });
    });

    it("should load and parse a user-level config", () => {
      const userConfigPath = path.join(os.homedir(), ".ibmi", "config.yaml");
      process.cwd = () => "/tmp/empty";

      mockExistsSync.mockImplementation((p) => p === userConfigPath);
      mockReadFileSync.mockReturnValue(`
default: dev
systems:
  dev:
    host: myhost.com
    port: 8076
    user: MYUSER
    password: secret123
`);

      const config = loadConfig();
      expect(config.default).toBe("dev");
      expect(config.systems["dev"]).toBeDefined();
      expect(config.systems["dev"]!.host).toBe("myhost.com");
      expect(config.systems["dev"]!.user).toBe("MYUSER");
      expect(config.systems["dev"]!.password).toBe("secret123");
    });

    it("should merge project config over user config", () => {
      const userConfigPath = path.join(os.homedir(), ".ibmi", "config.yaml");
      const projectConfigPath = "/home/user/project/.ibmi/config.yaml";
      process.cwd = () => "/home/user/project";

      mockExistsSync.mockImplementation(
        (p) => p === userConfigPath || p === projectConfigPath,
      );

      let callCount = 0;
      mockReadFileSync.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // User config (loaded first)
          return `
default: prod
systems:
  prod:
    host: prod.example.com
    port: 8076
    user: PRODUSER
`;
        }
        // Project config (loaded second)
        return `
default: dev
systems:
  dev:
    host: dev.example.com
    port: 8076
    user: DEVUSER
`;
      });

      const config = loadConfig();
      // Project default overrides user default
      expect(config.default).toBe("dev");
      // Both systems should be present (merged)
      expect(config.systems["prod"]).toBeDefined();
      expect(config.systems["dev"]).toBeDefined();
    });

    it("should expand environment variables in system configs", () => {
      const userConfigPath = path.join(os.homedir(), ".ibmi", "config.yaml");
      process.cwd = () => "/tmp/empty";
      process.env["TEST_HOST"] = "expanded-host.com";
      process.env["TEST_USER"] = "EXPANDEDUSER";

      mockExistsSync.mockImplementation((p) => p === userConfigPath);
      mockReadFileSync.mockReturnValue(`
systems:
  dev:
    host: \${TEST_HOST}
    port: 8076
    user: \${TEST_USER}
`);

      const config = loadConfig();
      expect(config.systems["dev"]!.host).toBe("expanded-host.com");
      expect(config.systems["dev"]!.user).toBe("EXPANDEDUSER");
    });

    it("should throw on invalid config", () => {
      const userConfigPath = path.join(os.homedir(), ".ibmi", "config.yaml");
      process.cwd = () => "/tmp/empty";

      mockExistsSync.mockImplementation((p) => p === userConfigPath);
      mockReadFileSync.mockReturnValue(`
systems:
  dev:
    port: 8076
`);
      // Missing required host and user fields
      expect(() => loadConfig()).toThrow("Invalid config");
    });

    it("should throw when default references non-existent system", () => {
      const userConfigPath = path.join(os.homedir(), ".ibmi", "config.yaml");
      process.cwd = () => "/tmp/empty";

      mockExistsSync.mockImplementation((p) => p === userConfigPath);
      mockReadFileSync.mockReturnValue(`
default: nonexistent
systems:
  dev:
    host: myhost.com
    port: 8076
    user: MYUSER
`);

      expect(() => loadConfig()).toThrow("Configuration errors");
    });
  });

  describe("saveUserConfig", () => {
    it("should create directory if it does not exist", () => {
      mockExistsSync.mockReturnValue(false);

      saveUserConfig({ systems: {} });

      expect(mockMkdirSync).toHaveBeenCalledWith(
        path.join(os.homedir(), ".ibmi"),
        { recursive: true },
      );
      expect(mockWriteFileSync).toHaveBeenCalled();
    });
  });

  describe("upsertSystem", () => {
    it("should set first system as default automatically", () => {
      process.cwd = () => "/tmp/empty";
      // No existing config
      mockExistsSync.mockReturnValue(false);

      upsertSystem("dev", {
        host: "myhost.com",
        port: 8076,
        user: "MYUSER",
        readOnly: false,
        confirm: false,
        timeout: 60,
        maxRows: 5000,
        ignoreUnauthorized: true,
      });

      // Check that writeFileSync was called with YAML that includes 'default: dev'
      const writtenContent = mockWriteFileSync.mock.calls[0]?.[1] as string;
      expect(writtenContent).toContain("default: dev");
    });

    it("should not change default when adding a second system", () => {
      process.cwd = () => "/tmp/empty";
      const userConfigPath = path.join(os.homedir(), ".ibmi", "config.yaml");

      mockExistsSync.mockImplementation((p) => p === userConfigPath);
      mockReadFileSync.mockReturnValue(`
default: dev
systems:
  dev:
    host: dev.example.com
    port: 8076
    user: DEVUSER
`);

      upsertSystem("prod", {
        host: "prod.example.com",
        port: 8076,
        user: "PRODUSER",
        readOnly: true,
        confirm: false,
        timeout: 60,
        maxRows: 5000,
        ignoreUnauthorized: true,
      });

      const writtenContent = mockWriteFileSync.mock.calls[0]?.[1] as string;
      expect(writtenContent).toContain("default: dev");
      expect(writtenContent).toContain("prod");
    });
  });

  describe("removeSystem", () => {
    it("should return false when system does not exist", () => {
      process.cwd = () => "/tmp/empty";
      mockExistsSync.mockReturnValue(false);

      expect(removeSystem("nonexistent")).toBe(false);
    });

    it("should remove system and clear default if it was the default", () => {
      process.cwd = () => "/tmp/empty";
      const userConfigPath = path.join(os.homedir(), ".ibmi", "config.yaml");

      mockExistsSync.mockImplementation((p) => p === userConfigPath);
      mockReadFileSync.mockReturnValue(`
default: dev
systems:
  dev:
    host: dev.example.com
    port: 8076
    user: DEVUSER
  prod:
    host: prod.example.com
    port: 8076
    user: PRODUSER
`);

      const removed = removeSystem("dev");
      expect(removed).toBe(true);

      const writtenContent = mockWriteFileSync.mock.calls[0]?.[1] as string;
      // Default should be promoted to 'prod' (first remaining)
      expect(writtenContent).toContain("default: prod");
      expect(writtenContent).not.toContain("dev.example.com");
    });
  });

  describe("setDefaultSystem", () => {
    it("should throw when system does not exist in any config", () => {
      process.cwd = () => "/tmp/empty";
      mockExistsSync.mockReturnValue(false);

      expect(() => setDefaultSystem("nonexistent")).toThrow(
        'System "nonexistent" not found',
      );
    });
  });
});

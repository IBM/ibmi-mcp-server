/**
 * @fileoverview Tests for YAML tool configuration parsing.
 * Runs the fixtures and inline YAML through the product parser
 * (ConfigParser.parseYamlFile) and the product parameter schema.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
  vi,
} from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

import { ConfigParser } from "../../../src/ibmi-mcp-server/utils/config/configParser.js";
import { ToolsetManager } from "../../../src/ibmi-mcp-server/utils/config/toolsetManager.js";
import { SqlToolParameterSchema } from "../../../src/ibmi-mcp-server/schemas/config.js";
import { logger } from "../../../src/utils/internal/logger.js";

let tmpRoot: string;
let inlineCount = 0;

// The fixtures take their credentials from the environment.
const FIXTURE_ENV = [
  "DB2i_HOST",
  "DB2i_USER",
  "DB2i_PASS",
  "DB2i_BACKUP_HOST",
  "DB2i_BACKUP_USER",
  "DB2i_BACKUP_PASS",
];
const originalEnv = Object.fromEntries(
  FIXTURE_ENV.map((name) => [name, process.env[name]]),
);

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "ibmi-mcp-yaml-parser-"));
  for (const name of FIXTURE_ENV) {
    process.env[name] = `fixture-${name}`;
  }
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  for (const name of FIXTURE_ENV) {
    if (originalEnv[name] === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = originalEnv[name];
    }
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Parse a fixture file with the product parser
function parseFixture(relativePath: string) {
  return ConfigParser.parseYamlFile(
    resolve(process.cwd(), "tests/fixtures", relativePath),
  );
}

// Parse inline YAML with the product parser
function parseYaml(yamlContent: string) {
  const filePath = join(tmpRoot, `inline-${inlineCount++}.yaml`);
  writeFileSync(filePath, yamlContent);
  return ConfigParser.parseYamlFile(filePath);
}

// The message a rejected file fails the load with
function loadError(parsing: Promise<unknown>): Promise<string> {
  return parsing.then(
    () => "",
    (error: Error) => error.message,
  );
}

describe("YAML Parser Unit Tests", () => {
  describe("Optional Sections", () => {
    it("should parse sources-only file successfully", async () => {
      const result = await parseFixture("sources-only.yaml");

      expect(result.config.sources).toBeDefined();
      expect(result.config.tools).toBeUndefined();
      expect(result.config.toolsets).toBeUndefined();
    });

    it("should parse tools-only file successfully", async () => {
      const result = await parseFixture("tools-only.yaml");

      expect(result.config.sources).toBeUndefined();
      expect(result.config.tools).toBeDefined();
      expect(result.config.toolsets).toBeUndefined();
    });

    it("should parse toolsets-only file successfully", async () => {
      const result = await parseFixture("toolsets-only.yaml");

      expect(result.config.sources).toBeUndefined();
      expect(result.config.tools).toBeUndefined();
      expect(result.config.toolsets).toBeDefined();
    });

    it("should parse complete file successfully", async () => {
      const result = await parseFixture("complete.yaml");

      expect(result.config.sources).toBeDefined();
      expect(result.config.tools).toBeDefined();
      expect(result.config.toolsets).toBeDefined();
    });

    it("should reject empty file", async () => {
      expect(await loadError(parseFixture("invalid/empty.yaml"))).toContain(
        "expected object",
      );
    });
  });

  describe("Schema Validation", () => {
    it("should validate required fields in sources, naming the file", async () => {
      const message = await loadError(
        parseFixture("invalid/missing-required-fields.yaml"),
      );

      expect(message).toContain(
        resolve(
          process.cwd(),
          "tests/fixtures/invalid/missing-required-fields.yaml",
        ),
      );
      expect(message).toContain("sources.invalid-source.user");
      expect(message).toContain("sources.invalid-source.password");
    });

    it("should validate parameter types", async () => {
      const invalidParamConfig = `
tools:
  invalid-param-tool:
    source: test-source
    description: "Tool with invalid parameter"
    statement: "SELECT 1 FROM SYSIBM.SYSDUMMY1"
    parameters:
      - name: invalid-param
        type: invalid-type
        description: "Invalid parameter type"
`;

      expect(await loadError(parseYaml(invalidParamConfig))).toContain(
        "parameters.0.type",
      );
    });

    it("should validate required tool fields", async () => {
      const invalidToolConfig = `
tools:
  incomplete-tool:
    source: test-source
    # Missing description and statement
`;

      expect(await loadError(parseYaml(invalidToolConfig))).toContain(
        "tools.incomplete-tool.description",
      );
    });

    it.each([
      ["missing", ""],
      ["blank", '    statement: "   "\n'],
    ])("should reject a tool whose statement is %s", async (_case, line) => {
      const message = await loadError(
        parseYaml(`
tools:
  no-statement-tool:
    source: test-source
    description: "Tool without a statement"
${line}`),
      );

      expect(message).toContain("tools.no-statement-tool.statement");
    });

    it("should reject unknown keys instead of dropping them", async () => {
      const message = await loadError(
        parseYaml(`
sources:
  test-source:
    host: localhost
    user: tester
    password: not-a-real-password
    prot: 9999

tools:
  typo_tool:
    source: test-source
    description: "Misspelled keys"
    statement: "SELECT 1 FROM SYSIBM.SYSDUMMY1"
    paramters: []
    securty:
      readOnly: false

toolsets:
  typo_set:
    tools: [typo_tool]
    titel: "Typo"

typescript_tools: {}
`),
      );

      expect(message).toContain(
        'sources.test-source: Unrecognized key: "prot"',
      );
      expect(message).toContain('"paramters"');
      expect(message).toContain('"securty"');
      expect(message).toContain('toolsets.typo_set: Unrecognized key: "titel"');
      expect(message).toContain('Unrecognized key: "typescript_tools"');
    });

    it("should leave jdbc-options and annotations open", async () => {
      const result = await parseYaml(`
sources:
  test-source:
    host: localhost
    user: tester
    password: not-a-real-password
    jdbc-options:
      naming: system

tools:
  open_tool:
    source: test-source
    description: "Open-ended sections"
    statement: "SELECT 1 FROM SYSIBM.SYSDUMMY1"
    annotations:
      audience: operators
`);

      expect(
        result.config.sources?.["test-source"]?.["jdbc-options"],
      ).toMatchObject({ naming: "system" });
      expect(result.config.tools?.open_tool?.annotations).toMatchObject({
        audience: "operators",
      });
    });

    it("should reject a statement that mixes ? and :name markers", async () => {
      const message = await loadError(
        parseYaml(`
tools:
  mixed_markers:
    source: test-source
    description: "Both marker styles"
    statement: "SELECT * FROM T WHERE A = :a AND B = ?"
    parameters:
      - name: a
        type: string
`),
      );

      expect(message).toContain(
        "Tool 'mixed_markers': SQL statement mixes named (:name) and positional (?) parameter markers",
      );
    });
  });

  describe("Cross-Reference Validation", () => {
    it("should reject a tool that references an unknown source", async () => {
      expect(
        await loadError(
          parseFixture("cross-reference-errors/tool-missing-source.yaml"),
        ),
      ).toContain(
        "Tool 'invalid-tool' references unknown source 'non-existent-source'",
      );
    });

    it("should reject a toolset that references an unknown tool", async () => {
      // Toolset references are checked after files are merged, by the
      // ToolsetManager, so the per-file parse succeeds.
      const result = await parseFixture(
        "cross-reference-errors/toolset-missing-tool.yaml",
      );

      await expect(
        ToolsetManager.getInstance().initialize(result.config),
      ).rejects.toThrow(
        /Toolset 'invalid-toolset' references unknown tool 'non-existent-tool'/,
      );
    });
  });

  describe("Environment Variable Interpolation", () => {
    afterEach(() => {
      delete process.env.TEST_HOST;
      delete process.env.TEST_USER;
      delete process.env.TEST_PASS;
    });

    const yamlContent = `
sources:
  test-source:
    host: \${TEST_HOST}
    user: \${TEST_USER}
    password: \${TEST_PASS}
    port: 8076
`;

    it("should handle environment variables in YAML", async () => {
      process.env.TEST_HOST = "test-host.example.com";
      process.env.TEST_USER = "test-user";
      process.env.TEST_PASS = "test-password";

      const result = await parseYaml(yamlContent);
      expect(result.config.sources?.["test-source"]?.host).toBe(
        "test-host.example.com",
      );
      expect(result.config.sources?.["test-source"]?.user).toBe("test-user");
      expect(result.config.sources?.["test-source"]?.password).toBe(
        "test-password",
      );
    });

    it("should not write substituted values to the log", async () => {
      process.env.TEST_HOST = "test-host.example.com";
      process.env.TEST_USER = "test-user";
      process.env.TEST_PASS = "S3cretPw";

      const logged: unknown[][] = [];
      for (const level of ["debug", "info", "warning", "error"] as const) {
        vi.spyOn(logger, level).mockImplementation((...args: unknown[]) => {
          logged.push(args);
        });
      }

      await parseYaml(yamlContent);

      const output = JSON.stringify(logged);
      expect(output).toContain("TEST_PASS");
      expect(output).not.toContain("S3cr");
    });

    it("should keep a value a string whatever it contains", async () => {
      process.env.TEST_HOST = "test-host.example.com";
      process.env.TEST_USER = "*USER: &x";
      // Substituted into the YAML text, the first would be a number and the
      // second would end at the comment sign.
      for (const password of ["12345678", "abc #def: x"]) {
        process.env.TEST_PASS = password;

        const result = await parseYaml(yamlContent);

        expect(result.config.sources?.["test-source"]).toMatchObject({
          user: "*USER: &x",
          password,
        });
      }
    });

    it("should substitute inside longer strings anywhere in the document, but not in comments", async () => {
      process.env.TEST_HOST = "QSYS2";

      const result = await parseYaml(`
# \${NOT_SET_IN_A_COMMENT}
tools:
  schema_tool:
    source: test-source
    description: "Tables of \${TEST_HOST}"
    statement: "SELECT * FROM QSYS2.SYSTABLES WHERE TABLE_SCHEMA = '\${TEST_HOST}'"
`);

      expect(result.config.tools?.schema_tool).toMatchObject({
        description: "Tables of QSYS2",
        statement: "SELECT * FROM QSYS2.SYSTABLES WHERE TABLE_SCHEMA = 'QSYS2'",
      });
    });

    it("should fail the load when a referenced variable is not set, naming it and the file", async () => {
      process.env.TEST_HOST = "test-host.example.com";
      const filePath = join(tmpRoot, `inline-${inlineCount}.yaml`);

      const message = await loadError(parseYaml(yamlContent));

      expect(message).toContain(filePath);
      expect(message).toContain(
        "environment variable(s) not set: TEST_USER, TEST_PASS",
      );
    });
  });

  describe("Parameter Validation", () => {
    it("should validate valid parameter types", () => {
      const validTypes = ["string", "boolean", "integer", "float", "array"];

      validTypes.forEach((type) => {
        const param = {
          name: "test-param",
          type: type as unknown,
          description: "Test parameter",
        };

        const result = SqlToolParameterSchema.safeParse(param);

        expect(result.success).toBe(true);
      });
    });

    it("should reject invalid parameter types", () => {
      ["invalid-type", "number"].forEach((type) => {
        const invalidParam = {
          name: "test-param",
          type,
          description: "Test parameter",
        };

        const result = SqlToolParameterSchema.safeParse(invalidParam);
        expect(result.success).toBe(false);
      });
    });

    it("should require parameter name", () => {
      const paramWithoutName = {
        type: "string",
        description: "Test parameter",
      };

      const result = SqlToolParameterSchema.safeParse(paramWithoutName);
      expect(result.success).toBe(false);
    });

    it("should validate array parameters with itemType", () => {
      const arrayParam = {
        name: "ids",
        type: "array",
        itemType: "integer",
        description: "Array of user IDs",
        minLength: 1,
        maxLength: 100,
      };

      const result = SqlToolParameterSchema.safeParse(arrayParam);

      expect(result.success).toBe(true);
    });

    it("should validate parameters with validation constraints", () => {
      const constrainedParam = {
        name: "age",
        type: "integer",
        description: "User age",
        min: 0,
        max: 120,
        required: true,
      };

      const result = SqlToolParameterSchema.safeParse(constrainedParam);

      expect(result.success).toBe(true);
    });

    it("should validate parameters with enum values", () => {
      const enumParam = {
        name: "status",
        type: "string",
        description: "User status",
        enum: ["active", "inactive", "pending"],
        required: true,
      };

      const result = SqlToolParameterSchema.safeParse(enumParam);

      expect(result.success).toBe(true);
    });

    it("should validate parameters with pattern", () => {
      const patternParam = {
        name: "username",
        type: "string",
        description: "IBM i username",
        pattern: "^[A-Z0-9_]{1,10}$",
        required: true,
      };

      const result = SqlToolParameterSchema.safeParse(patternParam);

      expect(result.success).toBe(true);
    });
  });

  describe("Tool Configuration Validation", () => {
    it("should parse tools with regular parameters", async () => {
      const toolWithParams = `
tools:
  user-query:
    source: test-source
    description: "Query user information"
    statement: "SELECT * FROM users WHERE name = :username AND age > :minAge"
    parameters:
      - name: username
        type: string
        description: "User name to search for"
        required: true
      - name: minAge
        type: integer
        description: "Minimum age filter"
        min: 0
        max: 120
        default: 18
`;

      const result = await parseYaml(toolWithParams);
      expect(result.config.tools?.["user-query"]?.parameters).toHaveLength(2);
      expect(result.config.tools?.["user-query"]?.parameters?.[0]?.name).toBe(
        "username",
      );
      expect(result.config.tools?.["user-query"]?.parameters?.[0]?.type).toBe(
        "string",
      );
      expect(result.config.tools?.["user-query"]?.parameters?.[1]?.name).toBe(
        "minAge",
      );
      expect(result.config.tools?.["user-query"]?.parameters?.[1]?.type).toBe(
        "integer",
      );
    });

    it("should validate tools without any parameters", async () => {
      const toolWithoutParams = `
tools:
  simple-query:
    source: test-source
    description: "Simple static query"
    statement: "SELECT COUNT(*) as total_users FROM users"
`;

      const result = await parseYaml(toolWithoutParams);
      expect(result.config.tools?.["simple-query"]?.parameters).toBeUndefined();
    });
  });

  describe("Configuration Counts", () => {
    it("should count sources correctly", async () => {
      const result = await parseFixture("sources-only.yaml");

      expect(result.stats.sourceCount).toBe(3);
    });

    it("should count tools correctly", async () => {
      const result = await parseFixture("tools-only.yaml");

      expect(result.stats.toolCount).toBe(3);
    });

    it("should count toolsets correctly", async () => {
      const result = await parseFixture("toolsets-only.yaml");

      expect(result.stats.toolsetCount).toBe(3);
    });
  });
});

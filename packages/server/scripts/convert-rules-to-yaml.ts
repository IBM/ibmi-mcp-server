/**
 * Script: convert-rules-to-yaml.ts
 * Purpose: Convert legacy .rule files (title, description, sql, parameters?, post) into
 *          a consolidated YAML tools file compatible with YamlToolsConfig schema.
 *
 * Usage:  npx tsx scripts/convert-rules-to-yaml.ts [--out rules/security-tools.yaml] [--source ibmi-system]
 */
import fs from "fs";
import path from "path";
import yaml from "js-yaml";

interface LegacyRuleFile {
  title: string;
  description: string;
  sql: string;
  parameters?: { name: string; description?: string }[];
  post?: string;
}

interface YamlToolParameterOut {
  name: string;
  type: "string";
  description?: string;
  required?: boolean;
}

interface YamlToolOut {
  source: string;
  description: string;
  statement: string;
  parameters?: YamlToolParameterOut[];
  domain?: string;
  category?: string;
  metadata?: Record<string, unknown>;
}

const RULES_DIR = path.resolve("rules");

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/database file/g, "dbfile")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/__+/g, "_");
}

function categorize(title: string): string {
  const t = title.toLowerCase();
  if (t.includes("ifs home")) return "ifs";
  if (t.includes("password failure")) return "password_failures";
  if (t.includes("system value")) return "system_values";
  if (t.includes("authority failure")) return "authority_failures";
  if (t.includes("trigger")) return "triggers";
  if (t.includes("rename")) return "rename";
  if (t.includes("insert") || t.includes("update") || t.includes("delete"))
    return "data_privileges";
  if (t.includes("user profile") || t.includes("user profiles"))
    return "user_profiles";
  if (t.includes("library list")) return "library_list";
  return "security_misc";
}

function readRuleFile(filePath: string): LegacyRuleFile | undefined {
  const raw = fs.readFileSync(filePath, "utf8");
  try {
    // Treat the .rule file as YAML directly
    const data = yaml.load(raw) as unknown;
    if (!data || typeof data !== "object") return undefined;
    const record = data as Record<string, unknown>;
    if (!record.sql) {
      console.warn(`Skipping ${path.basename(filePath)} - missing sql`);
      return undefined;
    }
    return {
      title: record.title?.toString() ?? path.basename(filePath, ".rule"),
      description: record.description?.toString() ?? "",
      sql: record.sql?.toString() ?? "",
      parameters: Array.isArray(record.parameters)
        ? (record.parameters as unknown[])
            .map((p): { name: string; description?: string } | undefined => {
              if (p && typeof p === "object") {
                const param = p as Record<string, unknown>;
                const nameVal = param.name;
                if (typeof nameVal === "string" && nameVal.trim()) {
                  const descVal = param.description;
                  return {
                    name: nameVal.trim(),
                    description:
                      typeof descVal === "string" ? descVal : undefined,
                  };
                }
              }
              return undefined;
            })
            .filter((p): p is { name: string; description?: string } => !!p)
        : undefined,
      post: record.post?.toString(),
    };
  } catch (err) {
    console.error(`Failed to parse ${filePath}:`, err);
    return undefined;
  }
}

function buildTool(
  rule: LegacyRuleFile,
  source: string,
  originalFile: string,
): [string, YamlToolOut] {
  const name = slugify(rule.title);
  const category = categorize(rule.title);
  const parameters: YamlToolParameterOut[] | undefined = rule.parameters?.map(
    (p) => ({
      name: p.name,
      type: "string",
      description: p.description,
    }),
  );

  // Merge post content into description metadata but keep original description succinct
  const metadata: Record<string, unknown> = {
    title: rule.title,
    original_file: path.basename(originalFile),
  };
  if (rule.post) metadata.post = rule.post.trim();

  // Keep main description just the original description (trim)
  const description = rule.description.trim();

  return [
    name,
    {
      source,
      description,
      statement: rule.sql.trim(),
      ...(parameters && parameters.length ? { parameters } : {}),
      domain: "security",
      category,
      metadata,
    },
  ];
}

function main() {
  const args = process.argv.slice(2);
  const outFlagIndex = args.indexOf("--out");
  const sourceFlagIndex = args.indexOf("--source");
  const outPath =
    outFlagIndex >= 0 ? args[outFlagIndex + 1] : "rules/security-tools.yaml";
  const sourceName =
    sourceFlagIndex >= 0 ? args[sourceFlagIndex + 1] : "ibmi-system";

  if (!fs.existsSync(RULES_DIR)) {
    console.error(`Rules directory not found: ${RULES_DIR}`);
    process.exit(1);
  }

  const files = fs.readdirSync(RULES_DIR).filter((f) => f.endsWith(".rule"));
  const tools: Record<string, YamlToolOut> = {};

  for (const file of files) {
    const full = path.join(RULES_DIR, file);
    const rule = readRuleFile(full);
    if (!rule) continue;
    const [toolName, toolDef] = buildTool(rule, sourceName, full);
    if (tools[toolName]) {
      console.warn(`Duplicate tool name ${toolName}; appending hash suffix`);
      const altName = `${toolName}_${Math.random().toString(36).slice(2, 6)}`;
      tools[altName] = toolDef;
    } else {
      tools[toolName] = toolDef;
    }
  }

  const outAbs = path.resolve(outPath);
  const outDir = path.dirname(outAbs);
  fs.mkdirSync(outDir, { recursive: true });

  const doc = { tools };
  const yamlStr = yaml.dump(doc, { lineWidth: 100 });
  fs.writeFileSync(outAbs, yamlStr, "utf8");

  console.log(
    `Generated YAML with ${Object.keys(tools).length} tools at ${outAbs}`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

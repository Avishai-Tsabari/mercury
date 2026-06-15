import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

// ─── Profile Schema ───────────────────────────────────────────────────────

const profileEnvVarSchema = z.object({
  key: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  description: z.string().optional(),
  required: z.boolean().default(false),
  default: z.string().optional(),
});

const profileExtensionSchema = z.object({
  name: z
    .string()
    .regex(
      /^[a-z0-9][a-z0-9-]*$/,
      "Extension names must be lowercase alphanumeric with hyphens",
    ),
  source: z.string(),
});

const profileDefaultsSchema = z.object({
  model_provider: z.string().optional(),
  model: z.string().optional(),
  trigger_patterns: z.string().optional(),
  bot_username: z.string().optional(),
});

export const profileSchema = z.object({
  name: z
    .string()
    .regex(
      /^[a-z0-9][a-z0-9-]*$/,
      "Profile name must be lowercase alphanumeric with hyphens",
    ),
  description: z.string().optional(),
  version: z.string().default("0.1.0"),
  agents_md: z.string().optional(),
  extensions: z.array(profileExtensionSchema).default([]),
  env: z.array(profileEnvVarSchema).default([]),
  defaults: profileDefaultsSchema.optional(),
});

export type MercuryProfile = z.infer<typeof profileSchema>;
export type ProfileEnvVar = z.infer<typeof profileEnvVarSchema>;

// ─── YAML Parsing (lightweight, no dependency) ────────────────────────────

function parseSimpleYaml(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = content.split("\n");
  let currentKey = "";
  let currentArray: unknown[] | null = null;
  let currentObject: Record<string, unknown> | null = null;

  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;

    // Top-level key: value
    const topMatch = line.match(/^([a-z_]+):\s*(.*)$/);
    if (topMatch) {
      if (currentArray && currentKey) {
        result[currentKey] = currentArray;
        currentArray = null;
      }
      const [, key, value] = topMatch;
      currentKey = key;
      if (value) {
        result[key] = value.replace(/^["']|["']$/g, "");
      }
      continue;
    }

    // Array item: "  - key: value" or "  - value"
    const arrayItemMatch = line.match(/^\s+-\s+(.+)$/);
    if (arrayItemMatch) {
      if (!currentArray) currentArray = [];
      const item = arrayItemMatch[1];

      // Check if it's a "key: value" object entry
      const kvMatch = item.match(/^([a-z_]+):\s*(.*)$/);
      if (kvMatch) {
        currentObject = { [kvMatch[1]]: parseYamlValue(kvMatch[2]) };
        currentArray.push(currentObject);
      } else {
        currentObject = null;
        currentArray.push(parseYamlValue(item));
      }
      continue;
    }

    // Nested key inside array object: "    key: value"
    const nestedMatch = line.match(/^\s{4,}([a-z_]+):\s*(.*)$/);
    if (nestedMatch && currentObject) {
      currentObject[nestedMatch[1]] = parseYamlValue(nestedMatch[2]);
      continue;
    }

    // Nested key for non-array objects (e.g., defaults section)
    const subMatch = line.match(/^\s{2}([a-z_]+):\s*(.*)$/);
    if (subMatch && currentKey && !currentArray) {
      if (
        typeof result[currentKey] !== "object" ||
        result[currentKey] === null
      ) {
        result[currentKey] = {};
      }
      (result[currentKey] as Record<string, unknown>)[subMatch[1]] =
        parseYamlValue(subMatch[2]);
    }
  }

  if (currentArray && currentKey) {
    result[currentKey] = currentArray;
  }

  return result;
}

function parseYamlValue(raw: string): string | number | boolean {
  const trimmed = raw.replace(/^["']|["']$/g, "").trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  const num = Number(trimmed);
  if (!Number.isNaN(num) && trimmed !== "") return num;
  return trimmed;
}

// ─── Profile Loading ──────────────────────────────────────────────────────

export function loadProfileFromDir(dir: string): MercuryProfile {
  const yamlPath = join(dir, "mercury-profile.yaml");
  if (!existsSync(yamlPath)) {
    throw new Error(`Profile manifest not found: ${yamlPath}`);
  }

  const content = readFileSync(yamlPath, "utf-8");
  const parsed = parseSimpleYaml(content);
  return profileSchema.parse(parsed);
}

export function resolveProfileSource(
  source: string,
  profilesDir: string,
): {
  dir: string;
  cleanup: () => void;
} {
  // 1. Built-in profile
  const builtinPath = join(profilesDir, source);
  if (existsSync(join(builtinPath, "mercury-profile.yaml"))) {
    return { dir: builtinPath, cleanup: () => {} };
  }

  // 2. Local path
  const localPath = resolve(source);
  if (existsSync(join(localPath, "mercury-profile.yaml"))) {
    return { dir: localPath, cleanup: () => {} };
  }

  // 3. Git URL
  if (
    source.startsWith("http://") ||
    source.startsWith("https://") ||
    source.startsWith("git@")
  ) {
    const tmp = join(tmpdir(), `mercury-profile-${Date.now()}`);
    const cloneResult = spawnSync(
      "git",
      ["clone", "--depth", "1", source, tmp],
      {
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    if (cloneResult.status !== 0) {
      throw new Error(`Failed to clone profile from ${source}`);
    }
    return {
      dir: tmp,
      cleanup: () => rmSync(tmp, { recursive: true, force: true }),
    };
  }

  throw new Error(`Profile not found: ${source}`);
}

export function applyProfile(
  profile: MercuryProfile,
  profileDir: string,
  projectDir: string,
): void {
  const dataDir = join(projectDir, ".mercury");
  mkdirSync(dataDir, { recursive: true });

  // Copy AGENTS.md
  if (profile.agents_md) {
    const agentsMdSrc = join(profileDir, profile.agents_md);
    if (existsSync(agentsMdSrc)) {
      const globalDir = join(dataDir, "global");
      mkdirSync(globalDir, { recursive: true });
      cpSync(agentsMdSrc, join(globalDir, "AGENTS.md"));
    }
  }

  // Copy extensions
  for (const ext of profile.extensions) {
    if (ext.source.startsWith("./") || ext.source.startsWith("../")) {
      const extSrc = join(profileDir, ext.source);
      if (existsSync(extSrc)) {
        const extDst = join(dataDir, "extensions", ext.name);
        mkdirSync(dirname(extDst), { recursive: true });
        cpSync(extSrc, extDst, { recursive: true });
      }
    }
  }
}

export function listBuiltinProfiles(profilesDir: string): MercuryProfile[] {
  if (!existsSync(profilesDir)) return [];

  const profiles: MercuryProfile[] = [];
  for (const entry of readdirSync(profilesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const yamlPath = join(profilesDir, entry.name, "mercury-profile.yaml");
    if (!existsSync(yamlPath)) continue;
    try {
      profiles.push(loadProfileFromDir(join(profilesDir, entry.name)));
    } catch {
      // Skip invalid profiles
    }
  }
  return profiles;
}

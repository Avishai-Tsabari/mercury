import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
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

  // ─── Applicative runtime fields ─────────────────────────────────────────
  /**
   * Raw capability extensions this profile requires to be installed (e.g.
   * ["gws"]). Validated at apply time — activation fails loudly if any are
   * missing. The profile wraps these host-side; they are NOT exposed to
   * members unless also listed in `member_permissions`.
   */
  capabilities: z.array(z.string()).default([]),
  /**
   * Exhaustive member permission set while this profile is active. When set,
   * this REPLACES the default member permissions (no extension defaults are
   * merged), so raw capabilities stay admin-only unless explicitly listed.
   */
  member_permissions: z.array(z.string()).optional(),
  /** Profile-specific agent persona, injected into the container. */
  system_prompt: z.string().optional(),
});

export type MercuryProfile = z.infer<typeof profileSchema>;
export type ProfileEnvVar = z.infer<typeof profileEnvVarSchema>;

// ─── Profile Loading ──────────────────────────────────────────────────────

export function loadProfileFromDir(dir: string): MercuryProfile {
  const yamlPath = join(dir, "mercury-profile.yaml");
  if (!existsSync(yamlPath)) {
    throw new Error(`Profile manifest not found: ${yamlPath}`);
  }

  const content = readFileSync(yamlPath, "utf-8");
  const parsed = parseYaml(content) ?? {};
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

  // Validate required capabilities are installed. A profile wraps raw
  // capability extensions (e.g. "gws") host-side; if one is missing the profile
  // cannot function, so fail loudly rather than degrade silently.
  validateProfileCapabilities(profile, dataDir);

  // Persist the runtime activation so the server can pick it up at startup
  // (the manifest itself is not copied into .mercury).
  persistActiveProfile(profile, dataDir);
}

/** Runtime activation record persisted by `applyProfile`, read at startup. */
export interface ActiveProfile {
  name: string;
  /** Exhaustive member permission set, or null when the profile doesn't scope members. */
  memberPermissions: string[] | null;
  /** Profile agent persona, or null. */
  systemPrompt: string | null;
}

const ACTIVE_PROFILE_FILE = "active-profile.json";

/** Write the active profile activation record to `<dataDir>/active-profile.json`. */
export function persistActiveProfile(
  profile: MercuryProfile,
  dataDir: string,
): void {
  const activation: ActiveProfile = {
    name: profile.name,
    memberPermissions: profile.member_permissions ?? null,
    systemPrompt: profile.system_prompt ?? null,
  };
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    join(dataDir, ACTIVE_PROFILE_FILE),
    JSON.stringify(activation, null, 2),
  );
}

/** Read the persisted active profile, or null when none is applied / unreadable. */
export function loadActiveProfile(dataDir: string): ActiveProfile | null {
  const file = join(dataDir, ACTIVE_PROFILE_FILE);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as ActiveProfile;
  } catch {
    return null;
  }
}

/**
 * Throw if any of the profile's declared `capabilities` is not present as an
 * installed extension directory under `<dataDir>/extensions`. Capabilities may
 * be satisfied either by a bundled/pre-installed extension or by one the
 * profile itself ships in `extensions`.
 */
export function validateProfileCapabilities(
  profile: MercuryProfile,
  dataDir: string,
): void {
  if (profile.capabilities.length === 0) return;

  const extensionsDir = join(dataDir, "extensions");
  const missing = profile.capabilities.filter(
    (cap) => !existsSync(join(extensionsDir, cap)),
  );

  if (missing.length > 0) {
    throw new Error(
      `Profile "${profile.name}" requires capabilities that are not installed: ` +
        `${missing.join(", ")}. Install them (e.g. \`mercury add ${missing[0]}\`) before applying this profile.`,
    );
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

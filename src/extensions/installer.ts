/**
 * Install/remove Mercury extensions from the host (CLI + dashboard).
 * Uses the same layout as `mercury add` / `mercury remove`.
 */
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Logger } from "../logger.js";
import type { ExtensionCatalogEntry } from "./catalog.js";
import { RESERVED_EXTENSION_NAMES } from "./reserved.js";

const VALID_EXT_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

function loadEnvFile(envPath: string): Record<string, string> {
  const content = readFileSync(envPath, "utf-8");
  const vars: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([^=]+)=(.*)$/);
    if (match) {
      vars[match[1]] = match[2];
    }
  }
  return vars;
}

/** Resolve MERCURY_DATA_DIR from project `.env` (default `.mercury`). */
export function getProjectDataDir(cwd: string): string {
  const envPath = join(cwd, ".env");
  if (existsSync(envPath)) {
    const envVars = loadEnvFile(envPath);
    if (envVars.MERCURY_DATA_DIR) return envVars.MERCURY_DATA_DIR;
  }
  return ".mercury";
}

export function getUserExtensionsDir(cwd: string): string {
  return join(cwd, getProjectDataDir(cwd), "extensions");
}

export function getGlobalDir(cwd: string): string {
  const envPath = join(cwd, ".env");
  if (existsSync(envPath)) {
    const envVars = loadEnvFile(envPath);
    if (envVars.MERCURY_GLOBAL_DIR) return envVars.MERCURY_GLOBAL_DIR;
  }
  return join(cwd, getProjectDataDir(cwd), "global");
}

/** Path to `examples/extensions/<sourceDir>` inside the mercury-agent package. */
export function resolveExamplesExtensionDir(
  packageRoot: string,
  sourceDir: string,
): string {
  return join(packageRoot, "examples", "extensions", sourceDir);
}

export type ExtensionInstallResult =
  | { ok: true }
  | { ok: false; error: string };

function validateForInstall(
  destName: string,
  sourceDir: string,
  extensionsDir: string,
): string | null {
  if (!VALID_EXT_NAME_RE.test(destName)) {
    return `Invalid extension name "${destName}" (lowercase letters, digits, hyphens only).`;
  }
  if (RESERVED_EXTENSION_NAMES.has(destName)) {
    return `"${destName}" is a reserved built-in name.`;
  }
  if (!existsSync(join(sourceDir, "index.ts"))) {
    return "Extension source has no index.ts.";
  }
  if (existsSync(join(extensionsDir, destName))) {
    return `Extension "${destName}" is already installed. Remove it first.`;
  }
  return null;
}

/** Validate that `index.ts` exists and default-exports a function (for CLI doctor). */
export async function checkExtensionIndexLoads(
  extDir: string,
  logicalName: string,
): Promise<string | null> {
  const indexPath = join(extDir, "index.ts");
  try {
    const mod = await import(indexPath);
    if (typeof mod.default !== "function") {
      return `${logicalName}/index.ts must export a default function`;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Failed to load ${logicalName}/index.ts: ${msg}`;
  }
  return null;
}

function installSkillIfPresent(
  extDir: string,
  name: string,
  cwd: string,
): void {
  const skillDir = join(extDir, "skill");
  if (!existsSync(join(skillDir, "SKILL.md"))) return;

  const globalDir = getGlobalDir(cwd);
  const dst = join(globalDir, "skills", name);
  mkdirSync(dirname(dst), { recursive: true });
  rmSync(dst, { recursive: true, force: true });
  cpSync(skillDir, dst, { recursive: true });
}

/**
 * Copy an extension from a local directory into `.mercury/extensions/<destName>/`.
 */
export async function installExtensionFromDirectory(options: {
  cwd: string;
  sourceDir: string;
  destName: string;
}): Promise<ExtensionInstallResult> {
  const { cwd, sourceDir, destName } = options;
  const extensionsDir = getUserExtensionsDir(cwd);
  mkdirSync(extensionsDir, { recursive: true });

  const err = validateForInstall(destName, sourceDir, extensionsDir);
  if (err) return { ok: false, error: err };

  const loadErr = await checkExtensionIndexLoads(sourceDir, destName);
  if (loadErr) return { ok: false, error: loadErr };

  const destDir = join(extensionsDir, destName);
  try {
    cpSync(sourceDir, destDir, { recursive: true });

    if (existsSync(join(destDir, "package.json"))) {
      const installResult = spawnSync("bun", ["install"], {
        stdio: "pipe",
        encoding: "utf-8",
        cwd: destDir,
      });
      if (installResult.status !== 0) {
        const stderr = installResult.stderr?.toString?.() ?? "";
        rmSync(destDir, { recursive: true, force: true });
        return {
          ok: false,
          error: `bun install failed in extension: ${stderr || "unknown error"}`,
        };
      }
    }

    installSkillIfPresent(destDir, destName, cwd);
    return { ok: true };
  } catch (e) {
    if (existsSync(destDir)) {
      rmSync(destDir, { recursive: true, force: true });
    }
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}

export function removeInstalledExtension(options: {
  cwd: string;
  name: string;
}): ExtensionInstallResult {
  const { cwd, name } = options;
  if (!VALID_EXT_NAME_RE.test(name)) {
    return { ok: false, error: `Invalid extension name "${name}".` };
  }

  const extensionsDir = getUserExtensionsDir(cwd);
  const extDir = join(extensionsDir, name);

  if (!existsSync(extDir)) {
    return { ok: false, error: `Extension "${name}" is not installed.` };
  }

  const globalDir = getGlobalDir(cwd);
  const skillDst = join(globalDir, "skills", name);
  if (existsSync(skillDst)) {
    rmSync(skillDst, { recursive: true, force: true });
  }

  rmSync(extDir, { recursive: true, force: true });
  return { ok: true };
}

/**
 * On startup, re-copy any installed catalog extension whose bundled source
 * differs from the installed copy. Triggered when a new image ships a patched
 * extension (e.g. MERCURY_BROWSER_SESSIONS fix) but running agents still have
 * the old installed copy on their data volume.
 *
 * Uses an atomic temp-dir swap so a failed copy never leaves an extension
 * partially installed or fully deleted.
 */
export async function syncBundledCatalogExtensions(options: {
  packageRoot: string;
  extensionsDir: string;
  globalDir: string;
  catalog: ExtensionCatalogEntry[];
  logger: Logger;
}): Promise<void> {
  const { packageRoot, extensionsDir, globalDir, catalog, logger } = options;
  if (!existsSync(extensionsDir)) return;

  for (const entry of catalog) {
    const installedDir = join(extensionsDir, entry.name);
    if (!existsSync(installedDir)) continue;

    const bundledDir = resolveExamplesExtensionDir(
      packageRoot,
      entry.sourceDir,
    );
    if (!existsSync(bundledDir)) continue;

    const bundledIndex = join(bundledDir, "index.ts");
    if (!existsSync(bundledIndex)) continue;

    let needsUpdate = false;
    try {
      for (const file of ["index.ts", "package.json"]) {
        const bundledFile = join(bundledDir, file);
        const installedFile = join(installedDir, file);
        if (!existsSync(bundledFile)) continue;
        const bundledContent = readFileSync(bundledFile, "utf-8");
        const installedContent = existsSync(installedFile)
          ? readFileSync(installedFile, "utf-8")
          : null;
        if (bundledContent !== installedContent) {
          needsUpdate = true;
          break;
        }
      }
    } catch {
      needsUpdate = true;
    }

    if (!needsUpdate) continue;

    logger.info("Bundled extension source updated — reinstalling", {
      name: entry.name,
    });

    // Atomic swap: copy to a temp sibling dir first, then replace.
    // This ensures a copy failure never leaves the extension deleted.
    const tmpDir = `${installedDir}.tmp`;
    rmSync(tmpDir, { recursive: true, force: true });
    try {
      cpSync(bundledDir, tmpDir, { recursive: true });

      if (existsSync(join(tmpDir, "package.json"))) {
        const installResult = spawnSync("bun", ["install"], {
          stdio: "pipe",
          encoding: "utf-8",
          cwd: tmpDir,
        });
        if (installResult.status !== 0) {
          // bun install failed — discard the temp dir; keep the old install.
          rmSync(tmpDir, { recursive: true, force: true });
          logger.warn(
            "Extension sync skipped: bun install failed in bundled source",
            {
              name: entry.name,
              stderr: installResult.stderr?.toString?.() ?? "",
            },
          );
          continue;
        }
      }

      // Swap: remove old, rename temp into place.
      rmSync(installedDir, { recursive: true, force: true });
      renameSync(tmpDir, installedDir);

      // Sync skill dir to global skills.
      const skillDir = join(installedDir, "skill");
      if (existsSync(join(skillDir, "SKILL.md"))) {
        const dst = join(globalDir, "skills", entry.name);
        mkdirSync(dirname(dst), { recursive: true });
        rmSync(dst, { recursive: true, force: true });
        cpSync(skillDir, dst, { recursive: true });
      }

      logger.info("Extension reinstalled from bundled source", {
        name: entry.name,
      });
    } catch (e) {
      rmSync(tmpDir, { recursive: true, force: true });
      logger.warn("Failed to reinstall extension from bundled source", {
        name: entry.name,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
}

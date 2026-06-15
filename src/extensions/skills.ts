/**
 * Extension skill installation.
 *
 * Copies extension skill directories into the global pi agent dir
 * so pi discovers them inside containers. Also installs built-in
 * skills shipped with Mercury.
 */

import fs from "node:fs";
import path from "node:path";
import type { ModelCapabilities } from "../agent/model-capabilities.js";
import { chainSupportsRequirements } from "../agent/model-capabilities.js";
import type { Logger } from "../logger.js";
import type { ExtensionMeta } from "./types.js";

/**
 * Install extension skills into the global pi agent dir.
 *
 * - Copies each extension's skill directory to `<globalDir>/skills/<name>/`
 * - Removes stale skill directories for extensions that no longer exist
 * - Preserves all files (scripts, references, assets) — not just SKILL.md
 */
export function installExtensionSkills(
  extensions: ExtensionMeta[],
  globalDir: string,
  log: Logger,
  /** When set, skip skills for extensions whose `requires` are not met by any chain leg. */
  modelChainCapabilities?: ModelCapabilities[],
): void {
  const skillsDir = path.join(globalDir, "skills");
  fs.mkdirSync(skillsDir, { recursive: true });

  const chainCaps = modelChainCapabilities ?? [];

  // Track which extension names have skills (after capability filter)
  const activeSkillNames = new Set(
    extensions
      .filter((e) => {
        if (!e.skillDir) return false;
        if (!e.requires?.length) return true;
        if (chainCaps.length === 0) return true;
        return chainSupportsRequirements(e.requires, chainCaps);
      })
      .map((e) => e.name),
  );

  // Clean up stale skill directories
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!activeSkillNames.has(entry.name)) {
      const stale = path.join(skillsDir, entry.name);
      fs.rmSync(stale, { recursive: true, force: true });
      log.info(`Removed stale skill: ${entry.name}`);
    }
  }

  // Copy skill directories
  for (const ext of extensions) {
    if (!ext.skillDir) continue;
    if (ext.requires?.length && chainCaps.length > 0) {
      if (!chainSupportsRequirements(ext.requires, chainCaps)) {
        log.debug(`Skipping skill install (capabilities): ${ext.name}`, {
          requires: ext.requires,
        });
        continue;
      }
    }
    const dst = path.join(skillsDir, ext.name);
    fs.rmSync(dst, { recursive: true, force: true });
    fs.cpSync(ext.skillDir, dst, { recursive: true });
    log.info(`Installed skill: ${ext.name}`);
  }
}

/**
 * Install built-in skills shipped with Mercury.
 *
 * Copies from `resources/skills/` into `<globalDir>/skills/`.
 * Built-in skills are for mrctl built-in commands (tasks, roles, etc.).
 */
export function installBuiltinSkills(
  builtinSkillsDir: string,
  globalDir: string,
  log: Logger,
  /** Built-in skills assume tool use (mrctl). Skip when no leg has tools. */
  modelChainCapabilities?: ModelCapabilities[],
): void {
  if (!fs.existsSync(builtinSkillsDir)) {
    log.debug(`No built-in skills directory: ${builtinSkillsDir}`);
    return;
  }

  const chainCaps = modelChainCapabilities ?? [];
  if (chainCaps.length > 0 && !chainCaps.some((c) => c.tools)) {
    const skillsDir = path.join(globalDir, "skills");
    for (const name of fs.readdirSync(builtinSkillsDir, {
      withFileTypes: true,
    })) {
      if (!name.isDirectory()) continue;
      const stale = path.join(skillsDir, name.name);
      if (fs.existsSync(stale)) {
        fs.rmSync(stale, { recursive: true, force: true });
        log.info(
          `Removed built-in skill (no tools on model chain): ${name.name}`,
        );
      }
    }
    return;
  }

  const skillsDir = path.join(globalDir, "skills");
  fs.mkdirSync(skillsDir, { recursive: true });

  for (const entry of fs.readdirSync(builtinSkillsDir, {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory()) continue;
    const src = path.join(builtinSkillsDir, entry.name);
    const dst = path.join(skillsDir, entry.name);
    fs.cpSync(src, dst, { recursive: true });
    log.debug(`Installed built-in skill: ${entry.name}`);
  }
}

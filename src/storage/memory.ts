import fs from "node:fs";
import path from "node:path";

const PI_SUBDIRS = [".pi", ".pi/extensions", ".pi/skills", ".pi/prompts"];

/**
 * Ensure a pi resource directory exists with standard structure.
 * Used for global, main, and shared groups root.
 */
export function ensurePiResourceDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  for (const sub of PI_SUBDIRS) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }

  // Create empty AGENTS.md so pi discovers and loads from this directory
  const agentsPath = path.join(dir, "AGENTS.md");
  if (!fs.existsSync(agentsPath)) {
    fs.writeFileSync(agentsPath, "", "utf8");
  }
}

/**
 * Ensure a per-space workspace exists with the pi resource structure.
 * Vault structure is handled by extensions via workspace_init hooks.
 */
export function ensureSpaceWorkspace(
  spacesDir: string,
  spaceId: string,
): string {
  const dir = path.join(spacesDir, spaceId);

  ensurePiResourceDir(dir);

  return dir;
}

/**
 * Remove a space's workspace directory from disk.
 * Safe to call if the directory doesn't exist (no-op).
 */
export function removeSpaceWorkspace(spacesDir: string, spaceId: string): void {
  const dir = path.join(spacesDir, spaceId);
  fs.rmSync(dir, { recursive: true, force: true });
}

import type { Db } from "../storage/db.js";

// ---------------------------------------------------------------------------
// Built-in permissions (static, cannot be overridden)
// ---------------------------------------------------------------------------

const BUILT_IN_PERMISSIONS = new Set([
  "prompt",
  "stop",
  "compact",
  "clear",
  "tasks.list",
  "tasks.create",
  "tasks.pause",
  "tasks.resume",
  "tasks.delete",
  "config.get",
  "config.set",
  "prefs.get",
  "prefs.set",
  "roles.list",
  "roles.grant",
  "roles.revoke",
  "permissions.get",
  "permissions.set",
  "spaces.list",
  "spaces.rename",
  "spaces.delete",
  /** Purge inbox/outbox media files. */
  "media.purge",
  /** Host Text-to-Speech (/api/tts); admin-only by default. */
  "tts.synthesize",
  /** Mute/unmute users and list mutes; admin-only by default. */
  "mutes.list",
  "mutes.mute",
  "mutes.unmute",
]);

// ---------------------------------------------------------------------------
// Extension-registered permissions (dynamic, added at runtime)
// ---------------------------------------------------------------------------

const registeredPermissions = new Map<string, { defaultRoles: string[] }>();

/**
 * Register a new permission from an extension.
 * Throws if the name collides with a built-in permission.
 */
export function registerPermission(
  name: string,
  opts: { defaultRoles: string[] },
): void {
  if (BUILT_IN_PERMISSIONS.has(name)) {
    throw new Error(
      `Permission "${name}" is a built-in and cannot be overridden`,
    );
  }
  registeredPermissions.set(name, opts);
}

/**
 * Get all valid permission names (built-in + extension-registered).
 */
export function getAllPermissions(): string[] {
  return [...BUILT_IN_PERMISSIONS, ...registeredPermissions.keys()];
}

/**
 * Check if a permission name is valid (built-in or registered).
 */
export function isValidPermission(name: string): boolean {
  return BUILT_IN_PERMISSIONS.has(name) || registeredPermissions.has(name);
}

/**
 * Clear all registered extension permissions. For test isolation only.
 */
export function resetPermissions(): void {
  registeredPermissions.clear();
}

// ---------------------------------------------------------------------------
// Seeded groups tracking
// ---------------------------------------------------------------------------

/**
 * Tracks which groups have had admins seeded to avoid redundant DB calls.
 * Exported for test isolation (tests should clear this in beforeEach).
 */
export const seededSpaces = new Set<string>();

// ---------------------------------------------------------------------------
// System callers
// ---------------------------------------------------------------------------

/**
 * System callers — these identities get full permissions without DB lookup.
 * Used for scheduled tasks, internal system calls, etc.
 */
const SYSTEM_CALLERS = new Set(["system"]);

export function isSystemCaller(callerId: string): boolean {
  return SYSTEM_CALLERS.has(callerId);
}

// ---------------------------------------------------------------------------
// Default role permissions
// ---------------------------------------------------------------------------

/** Built-in defaults for the member role */
const DEFAULT_MEMBER_PERMISSIONS = new Set(["prompt", "prefs.get"]);

/**
 * Compute the default permission set for a role, merging built-in defaults
 * with extension-registered defaults.
 *
 * - `admin` and `system` get all permissions (built-in + extension)
 * - `member` gets `prompt`, `prefs.get`, plus any extension permissions that list "member" in defaultRoles
 * - Other roles get extension permissions that list them in defaultRoles
 */
function getDefaultPermissions(role: string): Set<string> {
  if (role === "admin" || role === "system") {
    return new Set(getAllPermissions());
  }

  const perms = new Set<string>(
    role === "member" ? DEFAULT_MEMBER_PERMISSIONS : [],
  );

  for (const [name, opts] of registeredPermissions) {
    if (opts.defaultRoles.includes(role)) {
      perms.add(name);
    }
  }

  return perms;
}

// ---------------------------------------------------------------------------
// Permission resolution
// ---------------------------------------------------------------------------

/**
 * Load the permission set for a role in a group.
 * Checks group_config for "role.<name>.permissions" override,
 * falls back to defaults (built-in + extension).
 */
export function getRolePermissions(
  db: Db,
  spaceId: string,
  role: string,
): Set<string> {
  if (role === "system") return getDefaultPermissions("system");

  const key = `role.${role}.permissions`;
  const stored = db.getSpaceConfig(spaceId, key);

  if (stored !== null) {
    const perms = stored
      .split(",")
      .map((s) => s.trim())
      .filter((s) => isValidPermission(s));
    return new Set(perms);
  }

  return getDefaultPermissions(role);
}

export function hasPermission(
  db: Db,
  spaceId: string,
  role: string,
  permission: string,
): boolean {
  return getRolePermissions(db, spaceId, role).has(permission);
}

export function resolveRole(
  db: Db,
  spaceId: string,
  platformUserId: string,
  seededAdmins: string[],
  displayName?: string | null,
): string {
  // System callers bypass DB entirely
  if (isSystemCaller(platformUserId)) return "system";

  if (seededAdmins.length > 0 && !seededSpaces.has(spaceId)) {
    db.seedAdmins(spaceId, seededAdmins);
    seededSpaces.add(spaceId);
  }

  db.upsertMember(spaceId, platformUserId, displayName);

  return db.getRole(spaceId, platformUserId) ?? "member";
}

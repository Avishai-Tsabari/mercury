import { Hono } from "hono";
import { checkPerm, type Env, getApiCtx, getAuth } from "../api-types.js";
import {
  getAllPermissions,
  getRolePermissions,
  isValidPermission,
} from "../permissions.js";

export const roles = new Hono<Env>();

// ─── Roles ────────────────────────────────────────────────────────────────

roles.get("/", (c) => {
  const { spaceId } = getAuth(c);
  const denied = checkPerm(c, "roles.list");
  if (denied) return denied;

  const { db } = getApiCtx(c);
  const roleList = db.listRoles(spaceId);
  return c.json({ roles: roleList });
});

roles.post("/", async (c) => {
  const { spaceId, callerId } = getAuth(c);
  const denied = checkPerm(c, "roles.grant");
  if (denied) return denied;

  const { db } = getApiCtx(c);
  const body = await c.req.json<{ platformUserId?: string; role?: string }>();

  if (!body.platformUserId) {
    return c.json({ error: "Missing platformUserId" }, 400);
  }

  const targetRole = body.role ?? "admin";
  db.setRole(spaceId, body.platformUserId, targetRole, callerId);

  return c.json({
    spaceId,
    platformUserId: body.platformUserId,
    role: targetRole,
  });
});

roles.delete("/:userId", (c) => {
  const { spaceId, callerId } = getAuth(c);
  const denied = checkPerm(c, "roles.revoke");
  if (denied) return denied;

  const { db } = getApiCtx(c);
  const targetUserId = decodeURIComponent(c.req.param("userId"));
  db.setRole(spaceId, targetUserId, "member", callerId);
  return c.json({ spaceId, platformUserId: targetUserId, role: "member" });
});

// ─── Permissions ──────────────────────────────────────────────────────────

export const permissions = new Hono<Env>();

permissions.get("/", (c) => {
  const { spaceId } = getAuth(c);
  const denied = checkPerm(c, "permissions.get");
  if (denied) return denied;

  const { db } = getApiCtx(c);
  const url = new URL(c.req.url);
  const targetRole = url.searchParams.get("role");

  if (targetRole) {
    const perms = [...getRolePermissions(db, spaceId, targetRole)];
    return c.json({ spaceId, role: targetRole, permissions: perms });
  }

  // Return all known roles' permissions
  const allRoles: Record<string, string[]> = {};
  for (const r of ["admin", "member"]) {
    allRoles[r] = [...getRolePermissions(db, spaceId, r)];
  }

  // Also include any custom roles from group_roles table
  const groupRoles = db.listRoles(spaceId);
  const roleNames = new Set(groupRoles.map((r) => r.role));
  for (const r of roleNames) {
    if (!allRoles[r]) {
      allRoles[r] = [...getRolePermissions(db, spaceId, r)];
    }
  }

  return c.json({
    spaceId,
    permissions: allRoles,
    available: getAllPermissions(),
  });
});

permissions.put("/", async (c) => {
  const { spaceId, callerId } = getAuth(c);
  const denied = checkPerm(c, "permissions.set");
  if (denied) return denied;

  const { db } = getApiCtx(c);
  const body = await c.req.json<{
    role?: string;
    permissions?: string[];
  }>();

  if (!body.role || !Array.isArray(body.permissions)) {
    return c.json({ error: "Missing role or permissions array" }, 400);
  }

  const invalid = body.permissions.filter((p) => !isValidPermission(p));
  if (invalid.length > 0) {
    return c.json(
      {
        error: `Invalid permissions: ${invalid.join(", ")}. Valid: ${getAllPermissions().join(", ")}`,
      },
      400,
    );
  }

  const key = `role.${body.role}.permissions`;
  db.setSpaceConfig(spaceId, key, body.permissions.join(","), callerId);

  return c.json({ spaceId, role: body.role, permissions: body.permissions });
});

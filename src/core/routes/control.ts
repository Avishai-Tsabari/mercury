import { Hono } from "hono";
import { checkPerm, type Env, getApiCtx, getAuth } from "../api-types.js";
import { getRolePermissions } from "../permissions.js";

export const control = new Hono<Env>();

control.get("/whoami", (c) => {
  const { callerId, spaceId, role } = getAuth(c);
  const { db } = getApiCtx(c);
  const permissions = [...getRolePermissions(db, spaceId, role)];
  return c.json({ callerId, spaceId, role, permissions });
});

control.post("/stop", (c) => {
  const { spaceId } = getAuth(c);
  const denied = checkPerm(c, "stop");
  if (denied) return denied;

  const { containerRunner, queue } = getApiCtx(c);
  const stopped = containerRunner.abort(spaceId);
  const dropped = queue.cancelPending(spaceId);

  return c.json({ stopped, dropped });
});

control.post("/compact", (c) => {
  const { spaceId } = getAuth(c);
  const denied = checkPerm(c, "compact");
  if (denied) return denied;

  const { db } = getApiCtx(c);
  const boundary = db.setSessionBoundaryToLatest(spaceId);

  return c.json({ spaceId, boundary });
});

control.post("/clear", (c) => {
  const { spaceId } = getAuth(c);
  const denied = checkPerm(c, "clear");
  if (denied) return denied;

  const { db } = getApiCtx(c);
  const boundary = db.setClearBoundary(spaceId);

  return c.json({ spaceId, boundary });
});

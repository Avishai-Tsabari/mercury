import { Hono } from "hono";
import { removeSpaceWorkspace } from "../../storage/memory.js";
import { checkPerm, type Env, getApiCtx, getAuth } from "../api-types.js";

export const spaces = new Hono<Env>();

spaces.get("/", (c) => {
  const denied = checkPerm(c, "spaces.list");
  if (denied) return denied;

  const { db } = getApiCtx(c);
  return c.json({ spaces: db.listSpaces() });
});

spaces.get("/current", (c) => {
  const { spaceId } = getAuth(c);
  const { db } = getApiCtx(c);

  const space = db.getSpace(spaceId);
  if (!space) {
    return c.json({ error: "Space not found" }, 404);
  }
  return c.json({ space });
});

spaces.put("/current/name", async (c) => {
  const { spaceId } = getAuth(c);
  const denied = checkPerm(c, "spaces.rename");
  if (denied) return denied;

  const { db } = getApiCtx(c);
  const body = await c.req.json<{ name?: string }>();

  if (!body.name) {
    return c.json({ error: "Missing name" }, 400);
  }

  const updated = db.updateSpaceName(spaceId, body.name);
  if (!updated) {
    return c.json({ error: "Space not found" }, 404);
  }

  return c.json({ spaceId, name: body.name });
});

spaces.delete("/current", (c) => {
  const { spaceId } = getAuth(c);
  const denied = checkPerm(c, "spaces.delete");
  if (denied) return denied;

  const { db, config } = getApiCtx(c);
  const result = db.deleteSpace(spaceId);
  if (!result.deleted) {
    return c.json({ error: "Space not found" }, 404);
  }

  removeSpaceWorkspace(config.spacesDir, spaceId);

  return c.json({ spaceId, deleted: true, removed: result.removed });
});

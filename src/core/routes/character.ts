import { Hono } from "hono";
import { logger } from "../../logger.js";
import { type Env, getApiCtx, getAuth } from "../api-types.js";
import { isGlobalAdmin } from "../global-admin.js";

const MAX_CHARACTER_LENGTH = 4000;

export const character = new Hono<Env>();

character.get("/", (c) => {
  const { callerId } = getAuth(c);
  const { config, db } = getApiCtx(c);

  if (!isGlobalAdmin(callerId, config, db)) {
    logger.warn("Character get denied — caller is not a global admin", {
      callerId,
    });
    return c.json({ error: "Forbidden: requires global admin" }, 403);
  }

  const value = db.getProjectConfig("character");
  const updatedBy = db.getProjectConfigUpdatedBy("character");

  return c.json({ character: value, updatedBy });
});

character.put("/", async (c) => {
  const { callerId } = getAuth(c);
  const { config, db } = getApiCtx(c);

  if (!isGlobalAdmin(callerId, config, db)) {
    logger.warn("Character set denied — caller is not a global admin", {
      callerId,
    });
    return c.json({ error: "Forbidden: requires global admin" }, 403);
  }

  const body = (await c.req.json().catch(() => ({}))) as { text?: string };
  const text = typeof body.text === "string" ? body.text.trim() : "";

  if (!text) {
    return c.json({ error: "Missing or empty 'text' field" }, 400);
  }

  if (text.length > MAX_CHARACTER_LENGTH) {
    return c.json(
      { error: `Text exceeds ${MAX_CHARACTER_LENGTH} character limit` },
      400,
    );
  }

  db.setProjectConfig("character", text, callerId);
  return c.json({ ok: true });
});

character.delete("/", (c) => {
  const { callerId } = getAuth(c);
  const { config, db } = getApiCtx(c);

  if (!isGlobalAdmin(callerId, config, db)) {
    logger.warn("Character clear denied — caller is not a global admin", {
      callerId,
    });
    return c.json({ error: "Forbidden: requires global admin" }, 403);
  }

  db.deleteProjectConfig("character");
  return c.json({ ok: true });
});

import { Hono } from "hono";
import { checkPerm, type Env, getApiCtx, getAuth } from "../api-types.js";

export const PREF_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const MAX_PREF_VALUE_LENGTH = 500;
export const MAX_PREFS_PER_SPACE = 50;

export function validatePrefKey(key: string): string | null {
  if (!PREF_KEY_PATTERN.test(key)) {
    return "Invalid key. Use a slug: start with a-z or 0-9, then up to 63 chars of a-z, 0-9, ., _, -";
  }
  return null;
}

export function validatePrefValue(value: string): string | null {
  if (value.length > MAX_PREF_VALUE_LENGTH) {
    return `Value too long (max ${MAX_PREF_VALUE_LENGTH} characters)`;
  }
  return null;
}

export const prefs = new Hono<Env>();

prefs.get("/", (c) => {
  const { spaceId } = getAuth(c);
  const denied = checkPerm(c, "prefs.get");
  if (denied) return denied;

  const { db } = getApiCtx(c);
  const entries = db.listSpacePreferences(spaceId);
  return c.json({ spaceId, preferences: entries });
});

prefs.get("/:key", (c) => {
  const { spaceId } = getAuth(c);
  const denied = checkPerm(c, "prefs.get");
  if (denied) return denied;

  const key = decodeURIComponent(c.req.param("key"));
  const keyErr = validatePrefKey(key);
  if (keyErr) return c.json({ error: keyErr }, 400);

  const { db } = getApiCtx(c);
  const value = db.getSpacePreference(spaceId, key);
  if (value === null) {
    return c.json({ error: `Preference not found: ${key}` }, 404);
  }
  return c.json({ spaceId, key, value });
});

prefs.put("/", async (c) => {
  const { spaceId, callerId } = getAuth(c);
  const denied = checkPerm(c, "prefs.set");
  if (denied) return denied;

  const body = await c.req.json<{ key?: string; value?: string }>();
  if (!body.key || body.value === undefined) {
    return c.json({ error: "Missing key or value" }, 400);
  }

  const keyErr = validatePrefKey(body.key);
  if (keyErr) return c.json({ error: keyErr }, 400);

  const valErr = validatePrefValue(body.value);
  if (valErr) return c.json({ error: valErr }, 400);

  const { db } = getApiCtx(c);
  try {
    db.setSpacePreference(spaceId, body.key, body.value, callerId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("Maximum 50")) {
      return c.json({ error: msg }, 400);
    }
    throw e;
  }
  return c.json({ spaceId, key: body.key, value: body.value });
});

prefs.delete("/:key", (c) => {
  const { spaceId } = getAuth(c);
  const denied = checkPerm(c, "prefs.set");
  if (denied) return denied;

  const key = decodeURIComponent(c.req.param("key"));
  const keyErr = validatePrefKey(key);
  if (keyErr) return c.json({ error: keyErr }, 400);

  const { db } = getApiCtx(c);
  const removed = db.deleteSpacePreference(spaceId, key);
  if (!removed) {
    return c.json({ error: `Preference not found: ${key}` }, 404);
  }
  return c.json({ spaceId, key, deleted: true });
});

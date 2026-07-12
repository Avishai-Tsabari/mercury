import { Hono } from "hono";
import { logger } from "../../logger.js";
import { type Env, getApiCtx, getAuth } from "../api-types.js";

export const broadcast = new Hono<Env>();

broadcast.post("/", async (c) => {
  const { callerId } = getAuth(c);
  const { config, runtime } = getApiCtx(c);

  if (!config.dmAutoSpaceEnabled) {
    return c.json({ error: "dm_auto_space is not enabled" }, 503);
  }

  const globalAdmins = [
    ...(config.admins
      ? config.admins
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : []),
    ...(config.dmAutoSpaceAdminIds
      ? config.dmAutoSpaceAdminIds
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : []),
  ];

  const normalize = (s: string) =>
    s
      .replace(/^[^:]+:/, "")
      .replace(/^[+]+/, "")
      .replace(/@.*$/, "");

  const callerNormalized = normalize(callerId);

  const isAdmin = globalAdmins.some(
    (id) => id === callerId || normalize(id) === callerNormalized,
  );

  if (!isAdmin) {
    logger.warn("Broadcast denied — caller is not a global admin", {
      callerId,
    });
    return c.json({ error: "Forbidden: requires global admin" }, 403);
  }

  if (!runtime) {
    return c.json({ error: "Runtime not available" }, 503);
  }

  const body = (await c.req.json().catch(() => ({}))) as { text?: string };
  const text = typeof body.text === "string" ? body.text.trim() : "";

  if (!text) {
    return c.json({ error: "Missing or empty 'text' field" }, 400);
  }

  if (text.length > 4096) {
    return c.json({ error: "Text exceeds 4096 character limit" }, 400);
  }

  try {
    const result = await runtime.broadcastToAutoSpaces(text);
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === "Broadcast already in progress") {
      return c.json({ error: message }, 409);
    }
    if (message === "MessageSender not initialized") {
      return c.json({ error: "Message sender not ready" }, 503);
    }
    logger.error("Broadcast failed", { error: message });
    return c.json({ error: "Broadcast failed" }, 500);
  }
});

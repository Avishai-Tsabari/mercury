import { Hono } from "hono";
import { checkPerm, type Env, getApiCtx, getAuth } from "../api-types.js";

export const messages = new Hono<Env>();

messages.get("/search", (c) => {
  const denied = checkPerm(c, "compact");
  if (denied) return denied;

  const { spaceId } = getAuth(c);
  const { db } = getApiCtx(c);

  const q = c.req.query("q")?.trim() ?? "";
  if (!q) {
    return c.json({ error: "Missing q query parameter" }, 400);
  }

  const limitRaw = c.req.query("limit");
  let limit = 20;
  if (limitRaw != null && limitRaw !== "") {
    const n = Number.parseInt(limitRaw, 10);
    if (!Number.isFinite(n) || n < 1) {
      return c.json({ error: "Invalid limit" }, 400);
    }
    limit = n;
  }

  const found = db.searchMessages(spaceId, q, limit);
  return c.json({
    messages: found.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      createdAt: m.createdAt,
    })),
  });
});

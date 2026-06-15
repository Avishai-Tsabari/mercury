import { Hono } from "hono";
import { checkPerm, type Env, getApiCtx } from "../api-types.js";

export const conversations = new Hono<Env>();

conversations.get("/", (c) => {
  const denied = checkPerm(c, "spaces.list");
  if (denied) return denied;

  const { db } = getApiCtx(c);
  const linked = c.req.query("linked");
  const platform = c.req.query("platform");
  const filter: { linked?: boolean; platform?: string } = {};

  if (linked === "true") filter.linked = true;
  if (linked === "false") filter.linked = false;
  if (platform) filter.platform = platform;

  return c.json({ conversations: db.listConversations(filter) });
});

conversations.post("/:id/link", async (c) => {
  const denied = checkPerm(c, "spaces.rename");
  if (denied) return denied;

  const { db } = getApiCtx(c);
  const conversationId = Number.parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(conversationId) || conversationId < 1) {
    return c.json({ error: "Invalid conversation ID" }, 400);
  }

  const body = await c.req.json<{ spaceId?: string }>();
  if (!body.spaceId) {
    return c.json({ error: "Missing spaceId" }, 400);
  }

  const space = db.getSpace(body.spaceId);
  if (!space) {
    return c.json({ error: "Space not found" }, 404);
  }

  const linked = db.linkConversation(conversationId, body.spaceId);
  if (!linked) {
    return c.json({ error: "Conversation not found" }, 404);
  }

  return c.json({ conversationId, spaceId: body.spaceId, linked: true });
});

conversations.post("/:id/unlink", (c) => {
  const denied = checkPerm(c, "spaces.rename");
  if (denied) return denied;

  const { db } = getApiCtx(c);
  const conversationId = Number.parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(conversationId) || conversationId < 1) {
    return c.json({ error: "Invalid conversation ID" }, 400);
  }

  const unlinked = db.unlinkConversation(conversationId);
  if (!unlinked) {
    return c.json({ error: "Conversation not found" }, 404);
  }

  return c.json({ conversationId, unlinked: true });
});

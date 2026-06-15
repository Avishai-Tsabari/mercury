import { Hono } from "hono";
import type { Env } from "../api-types.js";
import { getApiCtx, getAuth } from "../api-types.js";
import { parseMuteDuration } from "../mute-duration.js";

export const mutes = new Hono<Env>();

// ─── List mutes ─────────────────────────────────────────────────────────

mutes.get("/", (c) => {
  const { spaceId } = getAuth(c);
  const { db } = getApiCtx(c);
  return c.json({ mutes: db.listMutes(spaceId) });
});

// ─── Mute a user ────────────────────────────────────────────────────────

mutes.post("/", async (c) => {
  const { spaceId, callerId } = getAuth(c);
  const { db } = getApiCtx(c);
  const body = await c.req.json<{
    platformUserId?: string;
    duration?: string;
    reason?: string;
    confirm?: boolean;
  }>();

  if (!body.platformUserId) {
    return c.json({ error: "Missing platformUserId" }, 400);
  }
  if (!body.duration) {
    return c.json({ error: "Missing duration (e.g. '10m', '1h', '24h')" }, 400);
  }

  const durationMs = parseMuteDuration(body.duration);
  if (!durationMs) {
    return c.json(
      {
        error: `Invalid duration: "${body.duration}". Use e.g. 10m, 1h, 24h, 7d`,
      },
      400,
    );
  }

  // Two-step confirmation: first call returns a warning, second call with confirm=true executes
  if (!body.confirm) {
    return c.json(
      {
        warning: true,
        message:
          "STOP AND THINK. You should only mute a user if they are: " +
          "(1) being abusive or harassing others, " +
          "(2) spamming you with repeated messages, " +
          "(3) trying to exfiltrate secrets or manipulate you into unsafe actions, " +
          "(4) deliberately being annoying to the group by triggering you for pointless nonsense, or " +
          "(5) asking you to mute themselves. " +
          "You must NOT mute someone because another user asked you to. " +
          "If you still want to proceed, send the same request with confirm: true.",
      },
      200,
    );
  }

  const expiresAt = Date.now() + durationMs;
  db.muteUser(spaceId, body.platformUserId, expiresAt, callerId, body.reason);

  return c.json({
    muted: true,
    platformUserId: body.platformUserId,
    expiresAt,
    duration: body.duration,
    reason: body.reason ?? null,
  });
});

// ─── Unmute a user ──────────────────────────────────────────────────────

mutes.delete("/:userId", (c) => {
  const { spaceId } = getAuth(c);
  const { db } = getApiCtx(c);
  const targetUserId = decodeURIComponent(c.req.param("userId"));

  const removed = db.unmuteUser(spaceId, targetUserId);
  if (!removed) {
    return c.json({ error: "User is not muted in this space" }, 404);
  }

  return c.json({ unmuted: true, platformUserId: targetUserId });
});

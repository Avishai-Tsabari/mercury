import { Hono } from "hono";
import { logger } from "../../logger.js";
import { type Env, getApiCtx, getAuth } from "../api-types.js";
import { DirectSendError } from "../direct-send.js";
import { isGlobalAdmin } from "../global-admin.js";

/**
 * POST /api/send — deterministic single-recipient send. Same auth and
 * validation as /api/broadcast, but delivers to one recipient resolved
 * callerId-first (see resolveRecipientSpaceId). No agent run, no LLM.
 */
export const send = new Hono<Env>();

send.post("/", async (c) => {
  const { callerId } = getAuth(c);
  const { config, db, runtime } = getApiCtx(c);

  if (!isGlobalAdmin(callerId, config, db)) {
    logger.warn("Direct send denied — caller is not a global admin", {
      callerId,
    });
    return c.json({ error: "Forbidden: requires global admin" }, 403);
  }

  if (!runtime) {
    return c.json({ error: "Runtime not available" }, 503);
  }

  const body = (await c.req.json().catch(() => ({}))) as {
    recipient?: string;
    text?: string;
  };
  const recipient =
    typeof body.recipient === "string" ? body.recipient.trim() : "";
  const text = typeof body.text === "string" ? body.text : "";

  if (!recipient) {
    return c.json({ error: "Missing or empty 'recipient' field" }, 400);
  }

  try {
    const result = await runtime.sendDirect(recipient, text);
    return c.json({ delivered: true, spaceId: result.spaceId });
  } catch (err) {
    if (err instanceof DirectSendError) {
      if (err.reason === "invalid_text") {
        return c.json({ error: err.message }, 400);
      }
      if (err.reason === "unknown_recipient") {
        return c.json({ error: err.message }, 404);
      }
      return c.json({ error: err.message }, 503);
    }
    const message = err instanceof Error ? err.message : String(err);
    logger.error("Direct send failed", { error: message });
    return c.json({ error: "Send failed" }, 500);
  }
});

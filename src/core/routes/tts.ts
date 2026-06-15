import { Hono } from "hono";
import { z } from "zod";
import { logger } from "../../logger.js";
import { synthesizeSpeech, TtsConfigError } from "../../tts/index.js";
import { checkPerm, type Env, getApiCtx } from "../api-types.js";

export const tts = new Hono<Env>();

const bodySchema = z.object({
  text: z.string().min(1).max(10_000),
  language: z.enum(["auto", "he-IL", "en-US"]).optional(),
  provider: z.enum(["google", "azure", "auto"]).optional(),
});

tts.post("/synthesize", async (c) => {
  const denied = checkPerm(c, "tts.synthesize");
  if (denied) return denied;

  const { config } = getApiCtx(c);

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await c.req.json());
  } catch {
    return c.json({ error: "Invalid JSON body or validation failed" }, 400);
  }

  try {
    const { buffer, mimeType, filename } = await synthesizeSpeech(config, {
      text: body.text,
      language: body.language,
      providerOverride: body.provider,
    });
    return c.json({
      mimeType,
      filename,
      dataBase64: buffer.toString("base64"),
      sizeBytes: buffer.length,
    });
  } catch (e) {
    if (e instanceof TtsConfigError) {
      return c.json({ error: e.message }, 503);
    }
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("empty") || msg.includes("max length")) {
      return c.json({ error: msg }, 400);
    }
    logger.warn("TTS synthesize failed", { error: msg });
    return c.json({ error: msg }, 502);
  }
});

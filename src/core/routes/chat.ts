import { timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { logger } from "../../logger.js";
import { ensureSpaceWorkspace } from "../../storage/memory.js";
import type { IngressMessage, MessageAttachment } from "../../types.js";
import { extToMime, mimeToMediaType } from "../media.js";
import type { MercuryCoreRuntime } from "../runtime.js";
import { isOverQuota } from "../storage-guard.js";

interface ChatFileInput {
  name: string;
  data: string; // base64
}

interface ChatFileOutput {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  data: string; // base64
}

export function createChatRoute(core: MercuryCoreRuntime): Hono {
  const app = new Hono();

  app.post("/", async (c) => {
    // Validate chat API key when configured
    const chatApiKey = core.config.chatApiKey;
    let authenticated = false;
    if (chatApiKey) {
      const authHeader = c.req.header("authorization");
      const token = authHeader?.startsWith("Bearer ")
        ? authHeader.slice(7)
        : undefined;

      if (
        !token ||
        token.length !== chatApiKey.length ||
        !timingSafeEqual(Buffer.from(token), Buffer.from(chatApiKey))
      ) {
        return c.json({ error: "Unauthorized" }, 401);
      }
      authenticated = true;
    }

    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.text !== "string" || !body.text.trim()) {
      return c.json({ error: "Missing or empty 'text' field" }, 400);
    }

    const callerId =
      typeof body.callerId === "string" && body.callerId.trim()
        ? body.callerId.trim()
        : "api:anonymous";

    const spaceId =
      typeof body.spaceId === "string" && body.spaceId.trim()
        ? body.spaceId.trim()
        : "main";

    const authorName =
      typeof body.authorName === "string" ? body.authorName.trim() : undefined;

    // Save incoming files to inbox/
    const attachments: MessageAttachment[] = [];
    if (Array.isArray(body.files)) {
      if (await isOverQuota(core.config)) {
        return c.json({ error: "Storage quota exceeded" }, 413);
      }
      const workspace = ensureSpaceWorkspace(core.config.spacesDir, spaceId);
      const inboxDir = path.join(workspace, "inbox");
      fs.mkdirSync(inboxDir, { recursive: true });

      for (const file of body.files as ChatFileInput[]) {
        if (!file.name || !file.data) continue;
        try {
          const buffer = Buffer.from(file.data, "base64");
          const safeName = path
            .basename(file.name)
            .replace(/[^a-zA-Z0-9._-]/g, "_");
          const filename = `${Date.now()}-${safeName || "file"}`;
          const filePath = path.join(inboxDir, filename);
          fs.writeFileSync(filePath, buffer);

          const mimeType = extToMime(file.name);
          attachments.push({
            path: filePath,
            type: mimeToMediaType(mimeType),
            mimeType,
            filename: file.name,
            sizeBytes: buffer.length,
          });
        } catch (err) {
          logger.warn("Failed to save chat file", {
            name: file.name,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    if (!core.db.getSpace(spaceId)) {
      return c.json({ error: "Space not found" }, 404);
    }

    if (authenticated) {
      core.db.seedAdmins(spaceId, [callerId]);
    }

    const ingress: IngressMessage = {
      platform: "api",
      spaceId,
      conversationExternalId: `api:${callerId}`,
      callerId,
      authorName,
      text: body.text.trim(),
      isDM: true,
      isReplyToBot: false,
      attachments,
    };

    logger.info("API chat inbound", {
      callerId,
      spaceId,
      preview: ingress.text.slice(0, 80),
      fileCount: attachments.length,
    });

    const result = await core.handleRawInput(ingress, "cli");

    if (result.type === "ignore") {
      return c.json({ reply: "", files: [] });
    }

    if (result.type === "denied") {
      return c.json({ error: result.reason }, 403);
    }

    const reply = result.result?.reply ?? "";
    const egressFiles = result.result?.files ?? [];

    // Encode outbox files as base64
    const outputFiles: ChatFileOutput[] = [];
    for (const f of egressFiles) {
      try {
        const buffer = fs.readFileSync(f.path);
        outputFiles.push({
          filename: f.filename,
          mimeType: f.mimeType,
          sizeBytes: f.sizeBytes,
          data: buffer.toString("base64"),
        });
      } catch (err) {
        logger.warn("Failed to read outbox file for chat response", {
          path: f.path,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.info("API chat outbound", {
      spaceId,
      preview: reply.slice(0, 80),
      fileCount: outputFiles.length,
    });

    return c.json({ reply, files: outputFiles });
  });

  return app;
}

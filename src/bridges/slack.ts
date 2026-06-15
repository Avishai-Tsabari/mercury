import fs from "node:fs";
import path from "node:path";
import type { Adapter, Message } from "chat";
import { downloadMediaFromUrl, mimeToMediaType } from "../core/media.js";
import { logger } from "../logger.js";
import type {
  EgressFile,
  IngressMessage,
  MessageAttachment,
  NormalizeContext,
  PlatformBridge,
} from "../types.js";

export class SlackBridge implements PlatformBridge {
  readonly platform = "slack";

  constructor(
    private readonly adapter: Adapter,
    private readonly botToken: string,
  ) {}

  parseThread(threadId: string): { externalId: string; isDM: boolean } {
    const parts = threadId.split(":");
    const externalId = parts.slice(1).join(":");
    const ch = parts[1] || "";
    const isDM = ch.startsWith("D") || ch.startsWith("G");
    return { externalId, isDM };
  }

  async normalize(
    threadId: string,
    message: unknown,
    ctx: NormalizeContext,
    spaceId: string,
  ): Promise<IngressMessage | null> {
    const msg = message as Message;
    if (msg.author.isMe) return null;

    const text = msg.text.trim();
    const rawAttachments = msg.attachments ?? [];
    if (!text && rawAttachments.length === 0) return null;

    const attachments: MessageAttachment[] = [];
    if (ctx.media.enabled && rawAttachments.length > 0) {
      if (await ctx.isOverQuota()) {
        logger.warn("Skipping media download — storage quota exceeded", {
          spaceId,
        });
      } else {
        const workspace = ctx.getWorkspace(spaceId);
        const inboxDir = path.join(workspace, "inbox");
        for (const att of rawAttachments) {
          const url = att.url || (att as { url_private?: string }).url_private;
          if (!url) continue;
          const type = mimeToMediaType(
            att.mimeType || "application/octet-stream",
          );
          const result = await downloadMediaFromUrl(url, {
            type,
            mimeType: att.mimeType || "application/octet-stream",
            filename: att.name,
            expectedSizeBytes: att.size,
            maxSizeBytes: ctx.media.maxSizeBytes,
            outputDir: inboxDir,
            headers: { Authorization: `Bearer ${this.botToken}` },
          });
          if (result) attachments.push(result);
        }
      }
    }

    const { externalId, isDM } = this.parseThread(threadId);

    // Extract Slack-specific fields from raw event for reply chain tracking
    const raw = msg.raw as
      | {
          ts?: string;
          thread_ts?: string;
        }
      | undefined;
    const slackTs = raw?.ts;
    const slackThreadTs = raw?.thread_ts;
    // In Slack, a threaded reply has thread_ts pointing to the parent message.
    // isReplyToBot: we can't determine this without knowing the parent author;
    // will be resolved via platform ID lookup in the runtime.
    const isReplyToBot =
      (msg.metadata as { isReplyToBot?: boolean })?.isReplyToBot ?? false;

    return {
      platform: "slack",
      spaceId,
      conversationExternalId: externalId,
      callerId: `slack:${msg.author.userId || "unknown"}`,
      authorName: msg.author.userName,
      text,
      isDM,
      isReplyToBot,
      attachments,
      replyToPlatformMessageId:
        slackThreadTs && slackThreadTs !== slackTs ? slackThreadTs : undefined,
      platformMessageId: slackTs,
    };
  }

  async sendReply(
    threadId: string,
    text: string,
    files?: EgressFile[],
  ): Promise<string | undefined> {
    let sentPlatformId: string | undefined;
    if (text) {
      const sent = await this.adapter.postMessage(threadId, text);
      sentPlatformId = sent.id;
    }

    if (files && files.length > 0) {
      await this.uploadFiles(threadId, files);
    }

    return sentPlatformId;
  }

  async deleteMessages(
    _threadId: string,
    _messageIds: string[],
  ): Promise<void> {
    // Slack delete not implemented — silent no-op for v1
  }

  private async uploadFiles(
    threadId: string,
    files: EgressFile[],
  ): Promise<void> {
    const parts = threadId.split(":");
    const channelId = parts.length >= 2 ? parts[1] : threadId;

    for (const file of files) {
      try {
        const buffer = fs.readFileSync(file.path);
        const form = new FormData();
        form.append("channel_id", channelId);
        form.append("filename", file.filename);
        form.append(
          "file",
          new Blob([buffer], { type: file.mimeType }),
          file.filename,
        );

        const resp = await fetch("https://slack.com/api/files.uploadV2", {
          method: "POST",
          headers: { Authorization: `Bearer ${this.botToken}` },
          body: form,
        });

        if (!resp.ok) {
          logger.error("Slack file upload HTTP error", {
            filename: file.filename,
            status: resp.status,
          });
        } else {
          const body = (await resp.json()) as { ok?: boolean; error?: string };
          if (!body.ok) {
            logger.error("Slack file upload API error", {
              filename: file.filename,
              error: body.error,
            });
          }
        }
      } catch (err) {
        logger.error("Slack file upload failed", {
          filename: file.filename,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

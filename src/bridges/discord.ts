import path from "node:path";
import type { Message } from "chat";
import type { DiscordNativeAdapter } from "../adapters/discord-native.js";
import { downloadMediaFromUrl, mimeToMediaType } from "../core/media.js";
import { logger } from "../logger.js";
import type {
  EgressFile,
  IngressMessage,
  MessageAttachment,
  NormalizeContext,
  PlatformBridge,
} from "../types.js";

export class DiscordBridge implements PlatformBridge {
  readonly platform = "discord";

  constructor(private readonly adapter: DiscordNativeAdapter) {}

  parseThread(threadId: string): { externalId: string; isDM: boolean } {
    const parts = threadId.split(":");
    const externalId = parts.slice(1).join(":");
    const isDM = parts.length >= 2 && parts[1] === "@me";
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

    let text = msg.text.trim();
    const rawAttachments = msg.attachments ?? [];
    if (!text && rawAttachments.length === 0) return null;

    const botUserId = this.adapter.botUserId;
    if (botUserId) {
      text = text.replace(
        new RegExp(`<@!?${botUserId}>`, "g"),
        `@${ctx.botUserName}`,
      );
    }

    const metadata = msg.metadata as {
      isReplyToBot?: boolean;
      replyToMessageId?: string;
      platformMessageId?: string;
    };
    const isReplyToBot = metadata?.isReplyToBot ?? false;

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
          if (!att.url) continue;
          const type = mimeToMediaType(
            att.mimeType || "application/octet-stream",
          );
          const result = await downloadMediaFromUrl(att.url, {
            type,
            mimeType: att.mimeType || "application/octet-stream",
            filename: att.name,
            expectedSizeBytes: att.size,
            maxSizeBytes: ctx.media.maxSizeBytes,
            outputDir: inboxDir,
          });
          if (result) attachments.push(result);
        }
      }
    }

    const { externalId, isDM } = this.parseThread(threadId);

    return {
      platform: "discord",
      spaceId,
      conversationExternalId: externalId,
      callerId: `discord:${msg.author.userId || "unknown"}`,
      authorName: msg.author.userName,
      text,
      isDM,
      isReplyToBot,
      attachments,
      replyToPlatformMessageId: metadata?.replyToMessageId ?? undefined,
      platformMessageId: metadata?.platformMessageId ?? undefined,
    };
  }

  async sendReply(
    threadId: string,
    text: string,
    files?: EgressFile[],
  ): Promise<string | undefined> {
    if (files && files.length > 0) {
      return this.sendWithFiles(threadId, text, files);
    } else if (text) {
      const sent = await this.adapter.postMessage(threadId, text);
      return sent.id;
    }
    return undefined;
  }

  async deleteMessages(threadId: string, messageIds: string[]): Promise<void> {
    for (const id of messageIds) {
      try {
        await this.adapter.deleteMessage(threadId, id);
      } catch (err) {
        logger.debug("Discord deleteMessage failed (best-effort)", {
          messageId: id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private async sendWithFiles(
    threadId: string,
    text: string,
    files: EgressFile[],
  ): Promise<string | undefined> {
    const client = this.adapter.discordClient;
    const { channelId, threadId: discordThreadId } =
      this.adapter.decodeThreadId(threadId);
    const targetId = discordThreadId || channelId;

    try {
      const channel = await client.channels.fetch(targetId);
      if (!channel || !("send" in channel)) {
        logger.warn("Discord channel not sendable, falling back to text-only", {
          targetId,
        });
        if (text) {
          const sent = await this.adapter.postMessage(threadId, text);
          return sent.id;
        }
        return undefined;
      }

      const discordFiles = files.map((f) => ({
        attachment: f.path,
        name: f.filename,
      }));

      const sent = await (
        channel as { send: (opts: unknown) => Promise<{ id: string }> }
      ).send({
        content: text || undefined,
        files: discordFiles,
      });
      return sent?.id;
    } catch (err) {
      logger.error("Failed to send files via Discord", {
        error: err instanceof Error ? err.message : String(err),
      });
      if (text) {
        const sent = await this.adapter.postMessage(threadId, text);
        return sent.id;
      }
      return undefined;
    }
  }
}

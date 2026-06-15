import fs from "node:fs";
import path from "node:path";
import type { proto, WAMessage } from "@whiskeysockets/baileys";
import type { Message } from "chat";
import type { WhatsAppBaileysAdapter } from "../adapters/whatsapp.js";
import {
  detectWhatsAppMedia,
  downloadQuotedMedia,
  downloadWhatsAppMedia,
} from "../adapters/whatsapp-media.js";
import { logger } from "../logger.js";
import { normalizeChatMarkdown } from "../text/markdown.js";
import { applyRtlDirection } from "../text/rtl.js";
import type {
  EgressFile,
  IngressMessage,
  MessageAttachment,
  NormalizeContext,
  PlatformBridge,
} from "../types.js";

export class WhatsAppBridge implements PlatformBridge {
  readonly platform = "whatsapp";

  constructor(private readonly adapter: WhatsAppBaileysAdapter) {}

  parseThread(threadId: string): { externalId: string; isDM: boolean } {
    const parts = threadId.split(":");
    const externalId = parts.slice(1).join(":");
    const isDM = !threadId.includes("@g.us");
    return { externalId, isDM };
  }

  async normalize(
    threadId: string,
    message: unknown,
    ctx: NormalizeContext,
    spaceId: string,
  ): Promise<IngressMessage | null> {
    const msg = message as Message<proto.IWebMessageInfo>;
    if (msg.author.isMe) return null;

    const text = msg.text.trim();
    const metadata = msg.metadata as {
      isReplyToBot?: boolean;
      replyToMessageId?: string;
    };
    const isReplyToBot = metadata?.isReplyToBot ?? false;

    // Download media in the bridge layer (like Discord/Slack) so it lands
    // in the resolved space workspace, not the raw conversation directory.
    const attachments: MessageAttachment[] = [];
    const rawMsg = msg.raw as WAMessage | undefined;
    const sock = this.adapter.socket;

    if (rawMsg && sock && ctx.media.enabled) {
      const mediaInfo = detectWhatsAppMedia(rawMsg.message);
      if (mediaInfo) {
        if (await ctx.isOverQuota()) {
          logger.warn("Skipping media download — storage quota exceeded", {
            spaceId,
          });
        } else {
          const workspace = ctx.getWorkspace(spaceId);
          try {
            const attachment = await downloadWhatsAppMedia(rawMsg, sock, {
              maxSizeBytes: ctx.media.maxSizeBytes,
              outputDir: workspace,
            });
            if (attachment) {
              attachments.push(attachment);
            }
          } catch (error) {
            logger.error("Failed to download media in bridge", {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }

      if (attachments.length === 0) {
        const contextInfo =
          rawMsg.message?.extendedTextMessage?.contextInfo ||
          rawMsg.message?.audioMessage?.contextInfo ||
          rawMsg.message?.imageMessage?.contextInfo ||
          rawMsg.message?.videoMessage?.contextInfo ||
          rawMsg.message?.documentMessage?.contextInfo ||
          rawMsg.message?.stickerMessage?.contextInfo;
        if (contextInfo?.quotedMessage) {
          if (await ctx.isOverQuota()) {
            logger.warn(
              "Skipping quoted media download — storage quota exceeded",
              { spaceId },
            );
          } else {
            const workspace = ctx.getWorkspace(spaceId);
            try {
              const attachment = await downloadQuotedMedia(contextInfo, sock, {
                maxSizeBytes: ctx.media.maxSizeBytes,
                outputDir: workspace,
              });
              if (attachment) {
                attachments.push(attachment);
              }
            } catch (error) {
              logger.warn("Failed to download quoted media in bridge", {
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
        }
      }
    }

    if (!text && attachments.length === 0) return null;

    const { externalId, isDM } = this.parseThread(threadId);

    return {
      platform: "whatsapp",
      spaceId,
      conversationExternalId: externalId,
      callerId: `whatsapp:${msg.author.userId || "unknown"}`,
      authorName: msg.author.userName,
      text,
      isDM,
      isReplyToBot,
      attachments,
      replyToPlatformMessageId: metadata?.replyToMessageId ?? undefined,
      platformMessageId:
        (metadata as { platformMessageId?: string })?.platformMessageId ??
        undefined,
    };
  }

  async sendReply(
    threadId: string,
    text: string,
    files?: EgressFile[],
  ): Promise<string | undefined> {
    if (files && files.length > 0) {
      return this.sendFiles(threadId, text, files);
    } else if (text) {
      const sent = await this.adapter.postMessage(threadId, text);
      return sent.id;
    }
    return undefined;
  }

  async editMessage(
    threadId: string,
    messageId: string,
    text: string,
  ): Promise<boolean> {
    const sock = this.adapter.socket;
    if (!sock) return false;
    const { chatJid } = this.adapter.decodeThreadId(threadId);
    try {
      const isGroup = chatJid.endsWith("@g.us");
      const participant = isGroup ? sock.user?.id : undefined;
      await sock.sendMessage(chatJid, {
        text: applyRtlDirection(normalizeChatMarkdown(text)),
        edit: {
          remoteJid: chatJid,
          id: messageId,
          fromMe: true,
          ...(participant ? { participant } : {}),
        },
      });
      return true;
    } catch (err) {
      logger.warn("WhatsApp editMessage failed", {
        threadId,
        messageId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  async deleteMessages(threadId: string, messageIds: string[]): Promise<void> {
    const sock = this.adapter.socket;
    if (!sock) return;
    const { chatJid } = this.adapter.decodeThreadId(threadId);
    for (const id of messageIds) {
      try {
        await sock.sendMessage(chatJid, {
          delete: { remoteJid: chatJid, id, fromMe: true },
        });
      } catch {
        // best-effort
      }
    }
  }

  private async sendFiles(
    threadId: string,
    text: string,
    files: EgressFile[],
  ): Promise<string | undefined> {
    const { chatJid } = this.adapter.decodeThreadId(threadId);
    const sock = this.adapter.socket;

    if (!sock) {
      logger.warn("WhatsApp socket unavailable, falling back to text-only");
      if (text) {
        const sent = await this.adapter.postMessage(threadId, text);
        return sent.id;
      }
      return undefined;
    }

    let textSent = !text;
    let lastSentId: string | undefined;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const isLast = i === files.length - 1;
      const caption =
        isLast && !textSent
          ? applyRtlDirection(normalizeChatMarkdown(text))
          : undefined;

      let buffer: Buffer;
      try {
        buffer = fs.readFileSync(file.path);
      } catch (err) {
        logger.error("Failed to read egress file", {
          path: file.path,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      try {
        const mime = file.mimeType;
        let sent: WAMessage | undefined;

        if (mime.startsWith("image/")) {
          sent = await sock.sendMessage(chatJid, {
            image: buffer,
            caption,
            mimetype: mime,
          });
        } else if (mime.startsWith("video/")) {
          sent = await sock.sendMessage(chatJid, {
            video: buffer,
            caption,
            mimetype: mime,
          });
        } else if (mime.startsWith("audio/")) {
          const base = path.basename(file.filename);
          const ptt =
            base.toLowerCase().endsWith(".ogg") && /^voice-/i.test(base);
          sent = await sock.sendMessage(chatJid, {
            audio: buffer,
            mimetype: mime,
            ptt,
          });
          if (caption) {
            sent = await sock.sendMessage(chatJid, { text: caption });
          }
        } else {
          sent = await sock.sendMessage(chatJid, {
            document: buffer,
            fileName: file.filename,
            mimetype: mime,
            caption,
          });
        }
        if (sent?.key?.id) lastSentId = sent.key.id;
        if (caption) textSent = true;
      } catch (err) {
        logger.error("Failed to send file via WhatsApp", {
          filename: file.filename,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (!textSent) {
      const sent = await sock.sendMessage(chatJid, {
        text: applyRtlDirection(normalizeChatMarkdown(text)),
      });
      if (sent?.key?.id) lastSentId = sent.key.id;
    }

    return lastSentId;
  }
}

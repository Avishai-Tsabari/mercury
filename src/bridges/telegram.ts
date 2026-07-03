import fs from "node:fs";
import path from "node:path";
import type { Adapter, Message } from "chat";
import {
  downloadMediaFromUrl,
  mimeToExt,
  mimeToMediaType,
} from "../core/media.js";
import {
  escapeHtml,
  markdownToTelegramHtml,
  TELEGRAM_MESSAGE_LIMIT,
  truncateTelegramHtml,
} from "../core/telegram-format.js";
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

const TELEGRAM_API_BASE = "https://api.telegram.org";

interface TelegramFileRef {
  fileId: string;
  mimeType: string;
  size?: number;
  name?: string;
}

/** Telegram Bot API message payload — we only read media fields. */
function telegramRawFileRefs(raw: unknown): TelegramFileRef[] {
  if (!raw || typeof raw !== "object") return [];
  const r = raw as Record<string, Record<string, unknown> | undefined>;
  const out: TelegramFileRef[] = [];

  const voice = r.voice as
    | { file_id?: string; mime_type?: string; file_size?: number }
    | undefined;
  if (voice?.file_id) {
    out.push({
      fileId: voice.file_id,
      mimeType:
        typeof voice.mime_type === "string" ? voice.mime_type : "audio/ogg",
      size: voice.file_size,
    });
  }

  const audio = r.audio as
    | {
        file_id?: string;
        mime_type?: string;
        file_size?: number;
        file_name?: string;
      }
    | undefined;
  if (audio?.file_id) {
    out.push({
      fileId: audio.file_id,
      mimeType:
        typeof audio.mime_type === "string" ? audio.mime_type : "audio/mpeg",
      size: audio.file_size,
      name: typeof audio.file_name === "string" ? audio.file_name : undefined,
    });
  }

  const videoNote = r.video_note as
    | { file_id?: string; mime_type?: string; file_size?: number }
    | undefined;
  if (videoNote?.file_id) {
    out.push({
      fileId: videoNote.file_id,
      mimeType:
        typeof videoNote.mime_type === "string"
          ? videoNote.mime_type
          : "video/mp4",
      size: videoNote.file_size,
      name: "telegram-video-note.mp4",
    });
  }

  return out;
}

const TELEGRAM_REPLY_SNIPPET_MAX = 12_000;

/**
 * Extract human-visible body from a Telegram Bot API Message (or reply fragment).
 */
function extractTelegramMessageVisibleText(
  message: unknown,
): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const m = message as Record<string, unknown>;
  const text = typeof m.text === "string" ? m.text.trim() : "";
  if (text) return text;
  const caption = typeof m.caption === "string" ? m.caption.trim() : "";
  if (caption) return caption;
  if (m.voice) return "[voice message]";
  if (m.audio) return "[audio message]";
  if (m.video_note) return "[video note]";
  if (m.photo && Array.isArray(m.photo) && m.photo.length > 0) return "[photo]";
  if (m.video) return "[video]";
  if (m.document) return "[document]";
  if (m.sticker) return "[sticker]";
  if (m.animation) return "[animation]";
  return undefined;
}

function truncateReplySnippet(s: string): string {
  if (s.length <= TELEGRAM_REPLY_SNIPPET_MAX) return s;
  return `${s.slice(0, TELEGRAM_REPLY_SNIPPET_MAX)}\n… [truncated]`;
}

/**
 * When the user replies to another message, embed quoted content for the model
 * (same idea as WhatsApp inbound `buildReplyContext` in `adapters/whatsapp.ts`).
 */
function buildTelegramReplyContext(
  replyTo: unknown,
  botUserId: string | undefined,
): string | undefined {
  if (!replyTo || typeof replyTo !== "object") return undefined;
  const r = replyTo as Record<string, unknown>;
  const bodyRaw = extractTelegramMessageVisibleText(r);
  if (!bodyRaw) return undefined;
  const body = truncateReplySnippet(bodyRaw);

  const from = r.from as { id?: number } | undefined;
  const messageId =
    typeof r.message_id === "number" ? String(r.message_id) : "unknown";
  const fromUserId = from?.id != null ? String(from.id) : "unknown";
  const fromBot =
    botUserId != null && from?.id != null && String(from.id) === botUserId;

  const attrs = [
    `platform="telegram"`,
    `message_id="${messageId}"`,
    `from_user_id="${fromUserId}"`,
  ];
  if (fromBot) attrs.push(`from_bot="true"`);

  return `<reply_to ${attrs.join(" ")}>\n${body}\n</reply_to>`;
}

/**
 * True if this Telegram message likely carries downloadable media (adapter
 * attachments and/or raw voice/audio/video_note).
 */
export function telegramInboundLooksLikeMedia(message: {
  attachments?: unknown[] | null;
  raw?: unknown;
}): boolean {
  if ((message.attachments?.length ?? 0) > 0) return true;
  return telegramRawFileRefs(message.raw).length > 0;
}

export class TelegramBridge implements PlatformBridge {
  readonly platform = "telegram";

  constructor(
    private readonly adapter: Adapter,
    private readonly botToken: string,
    private readonly formatEnabled = true,
  ) {}

  parseThread(threadId: string): { externalId: string; isDM: boolean } {
    const parts = threadId.split(":");
    const externalId = parts.slice(1).join(":");
    const chatId = parts[1] ?? "";
    const isDM = !chatId.startsWith("-");
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
    const rawRefs = telegramRawFileRefs(msg.raw);
    const hadIncomingAttachments =
      rawAttachments.length > 0 || rawRefs.length > 0;
    if (!text && !hadIncomingAttachments) return null;

    type AttSource = {
      url?: string;
      name?: string;
      size?: number;
      mimeType?: string;
      fetchData?: () => Promise<Buffer>;
    };

    let sources: AttSource[] = rawAttachments as AttSource[];
    if (
      ctx.media.enabled &&
      rawAttachments.length === 0 &&
      rawRefs.length > 0
    ) {
      sources = rawRefs.map((ref) => ({
        mimeType: ref.mimeType,
        name: ref.name,
        size: ref.size,
        fetchData: () => this.downloadTelegramFile(ref.fileId),
      }));
    }

    const attachments: MessageAttachment[] = [];
    if (ctx.media.enabled && sources.length > 0) {
      if (await ctx.isOverQuota()) {
        logger.warn("Skipping media download — storage quota exceeded", {
          spaceId,
        });
      } else {
        const workspace = ctx.getWorkspace(spaceId);
        const inboxDir = path.join(workspace, "inbox");
        for (const att of sources) {
          const mimeType = att.mimeType || "application/octet-stream";
          const type = mimeToMediaType(mimeType);

          if (att.url) {
            const result = await downloadMediaFromUrl(att.url, {
              type,
              mimeType,
              filename: att.name,
              expectedSizeBytes: att.size,
              maxSizeBytes: ctx.media.maxSizeBytes,
              outputDir: inboxDir,
            });
            if (result) attachments.push(result);
          } else if (att.fetchData) {
            try {
              const buffer = await att.fetchData();
              if (buffer.length > ctx.media.maxSizeBytes) {
                logger.warn("Telegram attachment exceeds size limit", {
                  type,
                  sizeBytes: buffer.length,
                  maxBytes: ctx.media.maxSizeBytes,
                });
                continue;
              }
              fs.mkdirSync(inboxDir, { recursive: true });
              const ext = mimeToExt(mimeType);
              const safeName = att.name
                ? path.basename(att.name).replace(/[^a-zA-Z0-9._-]/g, "_")
                : undefined;
              const filename = safeName
                ? `${Date.now()}-${safeName}`
                : `${Date.now()}-${type}.${ext}`;
              const filePath = path.join(inboxDir, filename);
              fs.writeFileSync(filePath, buffer);
              attachments.push({
                path: filePath,
                type,
                mimeType,
                filename: att.name || filename,
                sizeBytes: buffer.length,
              });
            } catch (err) {
              logger.error("Telegram attachment download failed", {
                type,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        }
      }
    }

    const { externalId, isDM } = this.parseThread(threadId);

    // @chat-adapter/telegram does not set isReplyToBot in metadata. Derive it from
    // the raw Telegram message: reply_to_message.from.id === botUserId.
    const metadataIsReply = (msg.metadata as { isReplyToBot?: boolean })
      ?.isReplyToBot;
    const raw = msg.raw as
      | {
          message_id?: number;
          reply_to_message?: { from?: { id?: number }; message_id?: number };
        }
      | undefined;
    const botUserId = (this.adapter as { botUserId?: string }).botUserId;
    const derivedReplyToBot =
      raw?.reply_to_message?.from?.id != null &&
      botUserId != null &&
      String(raw.reply_to_message.from.id) === botUserId;
    const isReplyToBot = metadataIsReply ?? derivedReplyToBot ?? false;

    const replyContext = buildTelegramReplyContext(
      raw?.reply_to_message,
      botUserId,
    );
    const combinedText = [text, replyContext]
      .filter(Boolean)
      .join("\n\n")
      .trim();

    return {
      platform: "telegram",
      spaceId,
      conversationExternalId: externalId,
      callerId: `telegram:${msg.author.userId || "unknown"}`,
      authorName: msg.author.userName,
      text: combinedText,
      isDM,
      isReplyToBot,
      attachments,
      hadIncomingAttachments,
      replyToPlatformMessageId:
        raw?.reply_to_message?.message_id != null
          ? String(raw.reply_to_message.message_id)
          : undefined,
      platformMessageId:
        raw?.message_id != null ? String(raw.message_id) : undefined,
    };
  }

  private async downloadTelegramFile(fileId: string): Promise<Buffer> {
    const apiUrl = `${TELEGRAM_API_BASE}/bot${this.botToken}/getFile`;
    const gf = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: fileId }),
    });
    if (!gf.ok) {
      throw new Error(`getFile HTTP ${gf.status}`);
    }
    const body = (await gf.json()) as {
      ok?: boolean;
      result?: { file_path?: string };
    };
    const filePath = body.result?.file_path;
    if (!body.ok || !filePath) {
      throw new Error("getFile: missing file_path");
    }
    const fileUrl = `${TELEGRAM_API_BASE}/file/bot${this.botToken}/${filePath}`;
    const fileResp = await fetch(fileUrl);
    if (!fileResp.ok) {
      throw new Error(`file download HTTP ${fileResp.status}`);
    }
    return Buffer.from(await fileResp.arrayBuffer());
  }

  async sendReply(
    threadId: string,
    text: string,
    files?: EgressFile[],
  ): Promise<string | undefined> {
    let sentPlatformId: string | undefined;
    if (text) {
      if (this.formatEnabled) {
        sentPlatformId = await this.sendTextMessage(threadId, text);
      } else {
        const sent = await this.adapter.postMessage(
          threadId,
          applyRtlDirection(normalizeChatMarkdown(text)),
        );
        sentPlatformId = sent.id;
      }
    }

    if (files && files.length > 0) {
      await this.uploadFiles(threadId, files);
    }

    return sentPlatformId;
  }

  private async sendTextMessage(
    threadId: string,
    text: string,
  ): Promise<string | undefined> {
    const { chatId, messageThreadId } = this.parseThreadId(threadId);
    let formatted: string;
    try {
      formatted = markdownToTelegramHtml(text);
    } catch {
      formatted = escapeHtml(text);
    }
    const truncated = truncateTelegramHtml(formatted, TELEGRAM_MESSAGE_LIMIT);

    const apiUrl = `${TELEGRAM_API_BASE}/bot${this.botToken}/sendMessage`;
    // RLM injection runs AFTER HTML format + truncation: the per-line split must
    // operate on the lines Telegram actually receives, and the prefix bytes must
    // not push the message past TELEGRAM_MESSAGE_LIMIT before truncation applies.
    const body: Record<string, string | number> = {
      chat_id: chatId,
      text: applyRtlDirection(truncated),
      parse_mode: "HTML",
    };
    if (messageThreadId !== undefined) {
      body.message_thread_id = messageThreadId;
    }

    try {
      const resp = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        logger.error("Telegram sendMessage HTTP error", {
          status: resp.status,
          error: errText,
        });
        return undefined;
      }
      const result = (await resp.json()) as {
        ok?: boolean;
        description?: string;
        result?: { message_id?: number };
      };
      if (!result.ok) {
        logger.error("Telegram sendMessage API error", {
          error: result.description,
        });
        return undefined;
      }
      return result.result?.message_id != null
        ? String(result.result.message_id)
        : undefined;
    } catch (err) {
      logger.error("Telegram sendMessage failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  private parseThreadId(threadId: string): {
    chatId: string;
    messageThreadId?: number;
  } {
    const parts = threadId.split(":");
    const chatId = parts[1] ?? "";
    const messageThreadPart = parts[2];
    const messageThreadId = messageThreadPart
      ? Number.parseInt(messageThreadPart, 10)
      : undefined;
    return {
      chatId,
      messageThreadId: Number.isFinite(messageThreadId)
        ? messageThreadId
        : undefined,
    };
  }

  /**
   * Pick Bot API method so audio shows as voice / music in Telegram instead of a generic file.
   * OGG (typical voice notes) → sendVoice; other audio/* → sendAudio; everything else → sendDocument.
   */
  private telegramUploadTarget(file: EgressFile): {
    method: "sendVoice" | "sendAudio" | "sendDocument";
    field: "voice" | "audio" | "document";
  } {
    const mime = file.mimeType.split(";")[0].trim().toLowerCase();
    if (mime === "audio/ogg" || mime === "audio/opus") {
      return { method: "sendVoice", field: "voice" };
    }
    if (mime.startsWith("audio/")) {
      return { method: "sendAudio", field: "audio" };
    }
    return { method: "sendDocument", field: "document" };
  }

  async editMessage(
    threadId: string,
    messageId: string,
    text: string,
  ): Promise<boolean> {
    const { chatId } = this.parseThreadId(threadId);
    const apiUrl = `${TELEGRAM_API_BASE}/bot${this.botToken}/editMessageText`;
    try {
      let formatted: string;
      try {
        formatted = markdownToTelegramHtml(text);
      } catch {
        formatted = escapeHtml(text);
      }
      const truncated = truncateTelegramHtml(formatted, TELEGRAM_MESSAGE_LIMIT);
      const resp = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: Number(messageId),
          text: applyRtlDirection(truncated),
          parse_mode: "HTML",
        }),
      });
      if (!resp.ok) return false;
      const result = (await resp.json()) as { ok?: boolean };
      return result.ok === true;
    } catch {
      return false;
    }
  }

  async deleteMessages(threadId: string, messageIds: string[]): Promise<void> {
    const { chatId } = this.parseThreadId(threadId);
    const apiUrl = `${TELEGRAM_API_BASE}/bot${this.botToken}/deleteMessage`;
    for (const id of messageIds) {
      try {
        await fetch(apiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, message_id: Number(id) }),
        });
      } catch {
        // best-effort
      }
    }
  }

  private async uploadFiles(
    threadId: string,
    files: EgressFile[],
  ): Promise<void> {
    const { chatId, messageThreadId } = this.parseThreadId(threadId);

    for (const file of files) {
      try {
        const buffer = fs.readFileSync(file.path);
        const { method, field } = this.telegramUploadTarget(file);
        const apiUrl = `${TELEGRAM_API_BASE}/bot${this.botToken}/${method}`;
        const form = new FormData();
        form.append("chat_id", chatId);
        form.append(
          field,
          new Blob([buffer], { type: file.mimeType }),
          file.filename,
        );
        if (messageThreadId !== undefined) {
          form.append("message_thread_id", String(messageThreadId));
        }

        const resp = await fetch(apiUrl, {
          method: "POST",
          body: form,
        });

        if (!resp.ok) {
          const errText = await resp.text();
          logger.error("Telegram file upload HTTP error", {
            filename: file.filename,
            method,
            status: resp.status,
            error: errText,
          });
        } else {
          const body = (await resp.json()) as {
            ok?: boolean;
            description?: string;
          };
          if (!body.ok) {
            logger.error("Telegram file upload API error", {
              filename: file.filename,
              method,
              error: body.description,
            });
          }
        }
      } catch (err) {
        logger.error("Telegram file upload failed", {
          filename: file.filename,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

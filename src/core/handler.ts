import type { Adapter, Message } from "chat";
import { telegramInboundLooksLikeMedia } from "../bridges/telegram.js";
import type { AppConfig } from "../config.js";
import { logger } from "../logger.js";
import type { NormalizeContext, PlatformBridge } from "../types.js";
import {
  type AutoSpaceConfig,
  inferConversationKind,
  resolveConversation,
} from "./conversation.js";
import type { MercuryCoreRuntime } from "./runtime.js";
import { loadTriggerConfig, matchTrigger } from "./trigger.js";

export interface MessageHandlerOptions {
  bridge: PlatformBridge;
  core: MercuryCoreRuntime;
  config: AppConfig;
  ctx: NormalizeContext;
}

export function createMessageHandler(opts: MessageHandlerOptions) {
  const { bridge, core, config, ctx } = opts;
  const defaultPatterns = config.triggerPatterns
    .split(",")
    .map((s: string) => s.trim())
    .filter(Boolean);

  const autoSpaceConfig: AutoSpaceConfig | undefined = config.dmAutoSpaceEnabled
    ? {
        enabled: true,
        adminIds: config.dmAutoSpaceAdminIds
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        defaultSystemPrompt: config.dmAutoSpaceDefaultSystemPrompt,
        defaultMemberPermissions: config.dmAutoSpaceDefaultMemberPermissions,
        rateLimitDailyMember: config.rateLimitDailyMember,
      }
    : undefined;

  return async (
    adapter: Adapter,
    threadId: string,
    message: Message,
  ): Promise<void> => {
    try {
      logger.debug("Incoming message", {
        adapter: adapter.name,
        threadId,
        textPreview: String(message.text ?? "").slice(0, 80),
        isMe: message.author.isMe,
      });

      if (message.author.isMe) return;

      const text = message.text.trim();
      const looksLikeMedia =
        bridge.platform === "telegram"
          ? telegramInboundLooksLikeMedia(message)
          : (message.attachments?.length ?? 0) > 0;
      if (!text && !looksLikeMedia) {
        return;
      }

      const { externalId, isDM } = bridge.parseThread(threadId);
      const kind = inferConversationKind(bridge.platform, externalId, isDM);
      const resolution = resolveConversation(
        core.db,
        bridge.platform,
        externalId,
        kind,
        undefined,
        autoSpaceConfig,
        message.author.userName ?? message.author.fullName,
      );

      if (!resolution) {
        logger.debug("Message ignored: conversation not linked to a space", {
          platform: bridge.platform,
          externalId,
          kind,
        });
        return;
      }

      const { spaceId } = resolution;

      const triggerConfig = loadTriggerConfig(core.db, spaceId, {
        patterns: defaultPatterns,
        match: config.triggerMatch,
      });
      const hasAttachments = looksLikeMedia;
      const triggerResult = matchTrigger(
        text,
        triggerConfig,
        isDM,
        hasAttachments,
      );

      if (triggerResult.matched) {
        try {
          await adapter.startTyping(threadId);
        } catch {
          // Best-effort typing indicator
        }
      }

      const ingress = await bridge.normalize(threadId, message, ctx, spaceId);
      if (!ingress) return;

      logger.info(
        `Message from: ${ingress.callerId}${ingress.authorName ? ` (${ingress.authorName})` : ""}`,
      );

      if (ingress.isReplyToBot && !isDM && !triggerResult.matched) {
        try {
          await adapter.startTyping(threadId);
        } catch {
          // Best-effort typing indicator
        }
      }

      const startTime = Date.now();
      let lastStatusMessageId: string | undefined;
      let hadStatusMessage = false;

      const heartbeat = setInterval(() => {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        const statusText = `⏳ Processing… (${elapsed}s)`;
        const currentId = lastStatusMessageId;

        if (currentId && bridge.editMessage) {
          bridge
            .editMessage(threadId, currentId, statusText)
            .then((ok) => {
              if (!ok) {
                // Edit failed — fall back to delete+send
                bridge
                  .sendReply(threadId, statusText)
                  .then(async (id) => {
                    await bridge
                      .deleteMessages?.(threadId, [currentId])
                      .catch(() => {});
                    if (id) lastStatusMessageId = id;
                  })
                  .catch(() => {});
              }
            })
            .catch(() => {});
        } else {
          const prevId = lastStatusMessageId;
          bridge
            .sendReply(threadId, statusText)
            .then(async (id) => {
              if (prevId) {
                await bridge
                  .deleteMessages?.(threadId, [prevId])
                  .catch(() => {});
              }
              if (id) {
                lastStatusMessageId = id;
                hadStatusMessage = true;
              }
            })
            .catch(() => {});
        }
      }, 30_000);

      let result: Awaited<ReturnType<typeof core.handleRawInput>>;
      try {
        result = await core.handleRawInput(ingress, "chat-sdk");
      } finally {
        clearInterval(heartbeat);
      }

      if (lastStatusMessageId) {
        await bridge
          .deleteMessages?.(threadId, [lastStatusMessageId])
          .catch(() => {});
      }

      if (result.type === "ignore") return;

      if (result.type === "denied") {
        await bridge.sendReply(threadId, result.reason);
        return;
      }

      if (result.result) {
        const { reply, files, assistantMessageId } = result.result;
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        const finalReply =
          hadStatusMessage && reply
            ? `${reply}\n\n_(responded in ${elapsed}s)_`
            : reply;
        if (finalReply || files.length > 0) {
          const sentPlatformId = await bridge.sendReply(
            threadId,
            finalReply,
            files.length > 0 ? files : undefined,
          );

          // Record the platform message ID mapping for the bot's outbound message
          if (
            sentPlatformId &&
            assistantMessageId &&
            ingress.conversationExternalId
          ) {
            core.recordOutboundPlatformId(
              assistantMessageId,
              bridge.platform,
              ingress.conversationExternalId,
              sentPlatformId,
            );
          }
        }
      }
    } catch (err) {
      logger.error("Message handler error", {
        platform: bridge.platform,
        threadId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}

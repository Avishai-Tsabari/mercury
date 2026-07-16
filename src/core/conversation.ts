import { logger } from "../logger.js";
import type { Db } from "../storage/db.js";
import type { Conversation } from "../types.js";

export interface ConversationResolution {
  conversation: Conversation;
  spaceId: string;
}

export interface AutoSpaceConfig {
  enabled: boolean;
  adminIds: string[];
  defaultSystemPrompt: string;
  defaultMemberPermissions: string;
  rateLimitDailyMember: number;
}

function normalizePhone(raw: string): string {
  return raw.replace(/^[+]+/, "").replace(/@.*$/, "");
}

export function deriveDmSpaceId(platform: string, externalId: string): string {
  const cleaned = normalizePhone(externalId)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "");
  if (platform === "whatsapp") return `dm-${cleaned}`;
  return `dm-${platform}-${cleaned}`;
}

function seedSpaceConfigIfAbsent(
  db: Db,
  spaceId: string,
  key: string,
  value: string,
): void {
  if (db.getSpaceConfig(spaceId, key) === null) {
    db.setSpaceConfig(spaceId, key, value, "dm-auto-space");
  }
}

export function resolveConversation(
  db: Db,
  platform: string,
  externalId: string,
  kind: string,
  observedTitle?: string,
  autoSpace?: AutoSpaceConfig,
  authorName?: string,
): ConversationResolution | null {
  const conversation = db.ensureConversation(
    platform,
    externalId,
    kind,
    observedTitle,
  );

  if (conversation.spaceId) {
    return { conversation, spaceId: conversation.spaceId };
  }

  if (!autoSpace?.enabled || kind !== "dm") return null;

  const senderNormalized = normalizePhone(externalId);
  const isAdmin = autoSpace.adminIds.some(
    (n) => normalizePhone(n) === senderNormalized,
  );

  if (isAdmin) {
    db.ensureSpace("main");
    db.linkConversation(conversation.id, "main");
    logger.info("dm-auto-space: admin number linked to main", {
      platform,
      externalId: senderNormalized,
    });
    return {
      conversation: { ...conversation, spaceId: "main" },
      spaceId: "main",
    };
  }

  const spaceId = deriveDmSpaceId(platform, externalId);
  db.ensureSpace(spaceId);

  const displayName = authorName || senderNormalized;
  db.updateSpaceName(spaceId, displayName);

  seedSpaceConfigIfAbsent(db, spaceId, "trigger.match", "always");
  seedSpaceConfigIfAbsent(db, spaceId, "context.mode", "context");
  seedSpaceConfigIfAbsent(db, spaceId, "debounce.idle_timeout_ms", "2000");
  if (autoSpace.defaultMemberPermissions) {
    seedSpaceConfigIfAbsent(
      db,
      spaceId,
      "role.member.permissions",
      autoSpace.defaultMemberPermissions,
    );
  }
  if (autoSpace.defaultSystemPrompt) {
    seedSpaceConfigIfAbsent(
      db,
      spaceId,
      "system_prompt",
      autoSpace.defaultSystemPrompt,
    );
  }
  if (autoSpace.rateLimitDailyMember > 0) {
    seedSpaceConfigIfAbsent(
      db,
      spaceId,
      "rate_limit.member",
      String(autoSpace.rateLimitDailyMember),
    );
  }

  db.linkConversation(conversation.id, spaceId);
  logger.info("dm-auto-space: created space and linked conversation", {
    platform,
    externalId: senderNormalized,
    spaceId,
    displayName,
  });
  return { conversation: { ...conversation, spaceId }, spaceId };
}

export function inferConversationKind(
  platform: string,
  externalId: string,
  isDM: boolean,
): string {
  if (isDM) return "dm";

  switch (platform) {
    case "whatsapp":
      return "group";
    case "discord":
      return externalId.includes(":") ? "thread" : "channel";
    case "slack":
      return "channel";
    case "teams":
      return "channel";
    default:
      return "group";
  }
}

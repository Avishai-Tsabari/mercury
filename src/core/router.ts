import type { AppConfig } from "../config.js";
import type { Db } from "../storage/db.js";
import type { MessageAttachment } from "../types.js";
import { SLASH_COMMANDS } from "./commands.js";
import { hasPermission, resolveRole } from "./permissions.js";
import { loadTriggerConfig, matchTrigger } from "./trigger.js";

export type RouteResult =
  | {
      type: "assistant";
      prompt: string;
      callerId: string;
      role: string;
      isReplyToBot: boolean;
      isDM: boolean;
    }
  | {
      type: "command";
      command: string;
      verb?: string;
      arg?: string;
      callerId: string;
      role: string;
    }
  | { type: "denied"; reason: string }
  | { type: "ignore" };

const SEEDED_ADMIN_COMMANDS = new Set(["spaces"]);

/**
 * Chat-level commands that bypass the LLM.
 * Mapped to the permission required to execute them.
 */
const CHAT_COMMANDS: Record<string, string> = {
  stop: "stop",
  compact: "compact",
  clear: "clear",
};

export function routeInput(input: {
  text: string;
  spaceId: string;
  callerId: string;
  isDM: boolean;
  isReplyToBot: boolean;
  db: Db;
  config: AppConfig;
  /** Attachments after normalize (saved to inbox). */
  attachments?: MessageAttachment[];
  /**
   * True when the inbound message had attachments or downloadable media before
   * normalize, even if nothing was persisted (routing vs silent drop).
   */
  hadIncomingAttachments?: boolean;
  /** Display name of the message author (e.g. WhatsApp pushName). */
  authorName?: string | null;
}): RouteResult {
  const text = input.text.trim();
  const persisted = (input.attachments?.length ?? 0) > 0;
  const hadIncoming = input.hadIncomingAttachments ?? false;
  const hasAttachments = persisted || hadIncoming;
  if (!text && !hasAttachments) return { type: "ignore" };

  const seededAdmins = input.config.admins
    ? input.config.admins
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  input.db.ensureSpace(input.spaceId);

  // Resolve role (seeds admins + auto-upserts member)
  const role = resolveRole(
    input.db,
    input.spaceId,
    input.callerId,
    seededAdmins,
    input.authorName,
  );

  // Load trigger config for this group
  const defaultPatterns = input.config.triggerPatterns
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // Auto-inject @botUsername so adapters that rewrite @-mentions (e.g. WhatsApp)
  // always trigger the bot without manual config.
  const atBot = `@${input.config.botUsername}`;
  if (!defaultPatterns.some((p) => p.toLowerCase() === atBot.toLowerCase())) {
    defaultPatterns.push(atBot);
  }
  const triggerConfig = loadTriggerConfig(input.db, input.spaceId, {
    patterns: defaultPatterns,
    match: input.config.triggerMatch,
  });

  // Match trigger OR reply-to-bot
  const result = matchTrigger(text, triggerConfig, input.isDM, hasAttachments);
  const isReplyTrigger = input.isReplyToBot && !input.isDM;
  if (!result.matched && !isReplyTrigger) return { type: "ignore" };

  // Use stripped prompt if trigger matched, otherwise full text for replies
  const prompt = result.matched ? result.prompt : text;

  // Check for slash commands (e.g. "/model list", "/model switch 2")
  // Only parse the first line — appended context (reply quotes etc.) must not
  // bleed into verb/arg tokens.
  if (prompt.startsWith("/")) {
    const firstLine = prompt.split("\n")[0].trim();
    const [rawCategory, rawVerb, ...argParts] = firstLine
      .slice(1)
      .trim()
      .split(/\s+/);
    const category = rawCategory.toLowerCase();
    const verb = rawVerb?.toLowerCase() || undefined;
    const arg = argParts.join(" ").trim() || undefined;
    if (SLASH_COMMANDS.some((c) => c.name === category)) {
      return gateSlashCommand(
        input.db,
        input.spaceId,
        category,
        role,
        input.callerId,
        input.isDM,
        seededAdmins,
        verb,
        arg,
      );
    }
  }

  // Check for commands after trigger (e.g. "@Pi stop", "Pi compact")
  const cmdWord = prompt.toLowerCase().trim();
  if (cmdWord in CHAT_COMMANDS) {
    return gateCommand(input.db, input.spaceId, cmdWord, role, input.callerId);
  }

  // Check prompt permission
  if (!hasPermission(input.db, input.spaceId, role, "prompt")) {
    return {
      type: "denied",
      reason: "You don't have permission to use the agent in this group.",
    };
  }

  return {
    type: "assistant",
    prompt,
    callerId: input.callerId,
    role,
    isReplyToBot: input.isReplyToBot,
    isDM: input.isDM,
  };
}

function gateSlashCommand(
  db: Db,
  spaceId: string,
  command: string,
  role: string,
  callerId: string,
  isDM: boolean,
  seededAdmins: string[],
  verb?: string,
  arg?: string,
): RouteResult {
  if (SEEDED_ADMIN_COMMANDS.has(command)) {
    if (!seededAdmins.includes(callerId)) {
      return {
        type: "denied",
        reason: `You don't have permission to use '/${command}'.`,
      };
    }
    return { type: "command", command, verb, arg, callerId, role };
  }
  if (!isDM && role !== "admin" && role !== "system") {
    return {
      type: "denied",
      reason: "Slash commands are only available to admins in groups.",
    };
  }
  if (!hasPermission(db, spaceId, role, "prompt")) {
    return {
      type: "denied",
      reason: `You don't have permission to use '/${command}'.`,
    };
  }
  return { type: "command", command, verb, arg, callerId, role };
}

function gateCommand(
  db: Db,
  spaceId: string,
  command: string,
  role: string,
  callerId: string,
): RouteResult {
  const permission = CHAT_COMMANDS[command];
  if (!permission) return { type: "ignore" };

  if (!hasPermission(db, spaceId, role, permission)) {
    return {
      type: "denied",
      reason: `You don't have permission to use '${command}'.`,
    };
  }

  return { type: "command", command, callerId, role };
}

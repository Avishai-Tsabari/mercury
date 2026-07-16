/**
 * Direct message delivery — deterministic single-recipient send.
 *
 * Powers `ctx.send()` (extensions) and `POST /api/send`. Writes straight to
 * the adapter outbox via MessageSender — no agent run, no LLM in the path.
 */

import type { Db } from "../storage/db.js";
import { deriveDmSpaceId } from "./conversation.js";

export const DIRECT_SEND_MAX_LENGTH = 4096;

export type DirectSendFailureReason =
  | "sender_not_ready"
  | "unknown_recipient"
  | "invalid_text";

export class DirectSendError extends Error {
  readonly reason: DirectSendFailureReason;

  constructor(reason: DirectSendFailureReason, message: string) {
    super(message);
    this.name = "DirectSendError";
    this.reason = reason;
  }

  static senderNotReady(): DirectSendError {
    return new DirectSendError(
      "sender_not_ready",
      "Message sender not initialized — adapters not started yet or context has no delivery path",
    );
  }

  static unknownRecipient(recipient: string): DirectSendError {
    return new DirectSendError(
      "unknown_recipient",
      `No existing space matches recipient "${recipient}" — direct send never creates spaces`,
    );
  }

  static invalidText(detail: string): DirectSendError {
    return new DirectSendError("invalid_text", detail);
  }
}

/**
 * Resolve a recipient to an existing space id. Never creates spaces.
 *
 * Resolution order:
 * 1. Exact space id (e.g. "dm-49123456789", "main").
 * 2. Raw caller/external id — the primary form. WhatsApp phone JIDs and
 *    opaque LIDs both work because the same normalization that keys DM
 *    auto-spaces is applied (strip leading "+", strip "@..." suffix,
 *    lowercase). A "platform:" prefix (e.g. "whatsapp:123@lid") is honored;
 *    bare ids default to whatsapp.
 */
export function resolveRecipientSpaceId(
  db: Db,
  recipient: string,
): string | null {
  const raw = recipient.trim();
  if (!raw) return null;

  if (db.getSpace(raw)) return raw;

  let platform = "whatsapp";
  let externalId = raw;
  const colon = raw.indexOf(":");
  if (colon > 0) {
    platform = raw.slice(0, colon).toLowerCase();
    externalId = raw.slice(colon + 1);
  }

  const candidate = deriveDmSpaceId(platform, externalId);
  return db.getSpace(candidate) ? candidate : null;
}

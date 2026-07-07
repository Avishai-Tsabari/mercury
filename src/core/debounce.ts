import { logger } from "../logger.js";
import type { IngressMessage } from "../types.js";

interface DebounceEntry {
  ingresses: IngressMessage[];
  timer: ReturnType<typeof setTimeout>;
}

interface ProcessingEntry {
  pending: IngressMessage[] | null;
}

type FlushCallback = (merged: IngressMessage) => Promise<void>;

const DEBOUNCE_PLATFORMS: Record<string, number> = {
  whatsapp: 2000,
  telegram: 2000,
};

export function getDefaultDebounceMs(platform: string): number {
  return DEBOUNCE_PLATFORMS[platform] ?? 0;
}

export function mergeIngresses(batch: IngressMessage[]): IngressMessage {
  if (batch.length === 1) return batch[0];

  const first = batch[0];
  const last = batch[batch.length - 1];

  return {
    platform: first.platform,
    spaceId: first.spaceId,
    conversationExternalId: first.conversationExternalId,
    callerId: first.callerId,
    authorName: first.authorName,
    text: batch.map((m) => m.text).join("\n"),
    isDM: first.isDM,
    isReplyToBot: first.isReplyToBot,
    attachments: batch.flatMap((m) => m.attachments),
    hadIncomingAttachments: batch.some((m) => m.hadIncomingAttachments),
    replyToPlatformMessageId: first.replyToPlatformMessageId,
    platformMessageId: last.platformMessageId,
  };
}

export class MessageDebouncer {
  private batches = new Map<string, DebounceEntry>();
  private processing = new Map<string, ProcessingEntry>();

  submit(
    key: string,
    ingress: IngressMessage,
    timeoutMs: number,
    onFlush: FlushCallback,
  ): void {
    const proc = this.processing.get(key);
    if (proc) {
      if (!proc.pending) {
        proc.pending = [ingress];
      } else {
        proc.pending.push(ingress);
      }
      return;
    }

    const existing = this.batches.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      existing.ingresses.push(ingress);
      existing.timer = setTimeout(() => {
        this.flush(key, onFlush);
      }, timeoutMs);
    } else {
      const timer = setTimeout(() => {
        this.flush(key, onFlush);
      }, timeoutMs);
      this.batches.set(key, { ingresses: [ingress], timer });
    }
  }

  flushKey(key: string, onFlush: FlushCallback): void {
    const entry = this.batches.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.batches.delete(key);
    this.executeFlush(key, entry.ingresses, onFlush);
  }

  isProcessing(key: string): boolean {
    return this.processing.has(key);
  }

  flushAll(onFlush: FlushCallback): void {
    for (const [key, entry] of this.batches) {
      clearTimeout(entry.timer);
      this.executeFlush(key, entry.ingresses, onFlush);
    }
    this.batches.clear();
  }

  private flush(key: string, onFlush: FlushCallback): void {
    const entry = this.batches.get(key);
    if (!entry) return;
    this.batches.delete(key);
    this.executeFlush(key, entry.ingresses, onFlush);
  }

  private executeFlush(
    key: string,
    ingresses: IngressMessage[],
    onFlush: FlushCallback,
  ): void {
    const merged = mergeIngresses(ingresses);
    this.processing.set(key, { pending: null });

    onFlush(merged)
      .catch((err) => {
        logger.error("Debounce flush error", {
          key,
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        const proc = this.processing.get(key);
        if (proc?.pending) {
          const batch = proc.pending;
          proc.pending = null;
          this.processing.delete(key);
          this.executeFlush(key, batch, onFlush);
        } else {
          this.processing.delete(key);
        }
      });
  }
}

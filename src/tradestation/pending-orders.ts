import { randomUUID } from "node:crypto";
import type { Db } from "../storage/db.js";
import { TRADESTATION_EXT } from "./host-api.js";

export const PENDING_ORDER_PREFIX = "pending_order:";
export const PENDING_ORDER_TTL_MS = 15 * 60 * 1000;

/** Exact JSON body sent to TradeStation confirm/place. */
export type TradeStationOrderRequestJson = Record<string, unknown>;

export interface PendingOrderRecord {
  v: 1;
  spaceId: string;
  callerId: string;
  createdAt: number;
  expiresAt: number;
  orderRequest: TradeStationOrderRequestJson;
  /** Short text for user-facing summary */
  summary: string;
}

export function cleanupExpiredTradestationPending(db: Db): void {
  const rows = db.listExtState(TRADESTATION_EXT);
  const now = Date.now();
  for (const { key, value } of rows) {
    if (!key.startsWith(PENDING_ORDER_PREFIX)) continue;
    try {
      const rec = JSON.parse(value) as PendingOrderRecord;
      if (rec.expiresAt < now) {
        db.deleteExtState(TRADESTATION_EXT, key);
      }
    } catch {
      db.deleteExtState(TRADESTATION_EXT, key);
    }
  }
}

export function createPendingOrderId(): string {
  return randomUUID();
}

export function pendingOrderKey(id: string): string {
  return `${PENDING_ORDER_PREFIX}${id}`;
}

export function savePendingOrder(
  db: Db,
  id: string,
  record: PendingOrderRecord,
): void {
  db.setExtState(TRADESTATION_EXT, pendingOrderKey(id), JSON.stringify(record));
}

export function loadPendingOrder(
  db: Db,
  id: string,
): PendingOrderRecord | null {
  const raw = db.getExtState(TRADESTATION_EXT, pendingOrderKey(id));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PendingOrderRecord;
  } catch {
    return null;
  }
}

export function deletePendingOrder(db: Db, id: string): void {
  db.deleteExtState(TRADESTATION_EXT, pendingOrderKey(id));
}

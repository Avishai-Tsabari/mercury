/**
 * Host-side TradeStation REST v3 calls using tokens in extension_state.
 * Used by core API routes; keeps order placement off the agent container.
 */

import type { Db } from "../storage/db.js";

export const TRADESTATION_EXT = "tradestation";

export function tradeStationApiBase(): string {
  const raw = process.env.MERCURY_TS_API_BASE?.trim();
  if (raw) return raw.replace(/\/$/, "");
  return "https://api.tradestation.com/v3";
}

export type TradeStationFetch = typeof fetch;

export async function tradeStationAuthorizedJson(
  db: Db,
  init: {
    method: "GET" | "POST" | "PUT" | "DELETE";
    path: string;
    body?: unknown;
  },
  fetchImpl: TradeStationFetch = fetch,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const token = db.getExtState(TRADESTATION_EXT, "access_token");
  const authErr = db.getExtState(TRADESTATION_EXT, "auth_error");
  if (authErr) {
    return {
      ok: false,
      status: 401,
      data: { error: "TradeStation auth error", code: authErr },
    };
  }
  if (!token) {
    return {
      ok: false,
      status: 401,
      data: {
        error:
          "TradeStation access token missing — configure OAuth on the Mercury host",
      },
    };
  }

  const base = tradeStationApiBase();
  const url = new URL(init.path.replace(/^\//, ""), `${base}/`);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  let body: string | undefined;
  if (init.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.body);
  }

  const res = await fetchImpl(url.toString(), {
    method: init.method,
    headers,
    body,
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { ok: res.ok, status: res.status, data };
}

/** TradeStation SIM accounts use an AccountID prefix convention (see TS docs). */
export function isLikelySimAccount(accountId: string): boolean {
  return /^SIM/i.test(accountId.trim());
}

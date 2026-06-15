export const TRADESTATION_EXT = "tradestation" as const;

type Db = {
  getExtState(ext: string, key: string): string | null;
  setExtState(ext: string, key: string, value: string): void;
  deleteExtState(ext: string, key: string): boolean;
};

const TRADESTATION_TOKEN_URL = "https://signin.tradestation.com/oauth/token";

export async function runTradeStationTokenRefresh(
  db: Db,
  log: { info(msg: string): void; warn(msg: string): void; error(msg: string): void },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const clientId =
    process.env.MERCURY_TS_CLIENT_ID?.trim() ||
    process.env.TS_CLIENT_ID?.trim() ||
    null;
  if (!clientId) {
    log.warn("[ts-refresh] no client_id — skipping");
    return;
  }

  const clientSecret = process.env.MERCURY_TS_CLIENT_SECRET?.trim() || null;

  let refreshToken =
    db.getExtState(TRADESTATION_EXT, "refresh_token") ??
    process.env.MERCURY_TRADESTATION_REFRESH_TOKEN?.trim() ??
    process.env.TS_REFRESH_TOKEN?.trim() ??
    null;

  if (!refreshToken) {
    log.warn("[ts-refresh] no refresh_token — skipping");
    return;
  }

  const accessToken = db.getExtState(TRADESTATION_EXT, "access_token");
  const expiryRaw = db.getExtState(TRADESTATION_EXT, "token_expiry_ms");
  if (accessToken && expiryRaw) {
    const expiry = Number(expiryRaw);
    if (expiry > Date.now() + 60_000) {
      return;
    }
  }

  const bodyParams: Record<string, string> = {
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: refreshToken,
  };
  if (clientSecret) bodyParams.client_secret = clientSecret;
  const body = new URLSearchParams(bodyParams);

  let res: Response;
  try {
    res = await fetchImpl(TRADESTATION_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[ts-refresh] fetch error: ${msg}`);
    db.setExtState(TRADESTATION_EXT, "auth_error", "refresh_failed:network");
    return;
  }

  if (!res.ok) {
    log.warn(`[ts-refresh] token refresh failed: ${res.status}`);
    db.setExtState(TRADESTATION_EXT, "auth_error", `refresh_failed:${res.status}`);
    return;
  }

  let data: Record<string, unknown>;
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    db.setExtState(TRADESTATION_EXT, "auth_error", "refresh_failed:invalid_json");
    return;
  }

  const newAccess = typeof data.access_token === "string" ? data.access_token : null;
  if (!newAccess) {
    db.setExtState(TRADESTATION_EXT, "auth_error", "refresh_failed:no_access_token");
    return;
  }

  db.setExtState(TRADESTATION_EXT, "access_token", newAccess);
  if (typeof data.refresh_token === "string" && data.refresh_token) {
    db.setExtState(TRADESTATION_EXT, "refresh_token", data.refresh_token);
  }
  if (typeof data.expires_in === "number") {
    db.setExtState(
      TRADESTATION_EXT,
      "token_expiry_ms",
      String(Date.now() + data.expires_in * 1000),
    );
  }
  db.deleteExtState(TRADESTATION_EXT, "auth_error");
  log.info("[ts-refresh] tokens refreshed");
}

import {
  runTradeStationTokenRefresh,
  TRADESTATION_EXT,
} from "./host/refresh.js";

const API_BASE_DEFAULT = "https://api.tradestation.com/v3";

function apiBaseFromHost(): string {
  const raw = process.env.MERCURY_TS_API_BASE?.trim();
  if (raw) return raw.replace(/\/$/, "");
  const env = process.env.MERCURY_TS_ENVIRONMENT?.trim().toUpperCase();
  if (env === "LIVE" || env === "SIM") {
    return API_BASE_DEFAULT;
  }
  return API_BASE_DEFAULT;
}

type ConnectionStatus = "connected" | "needs-reauth" | "broken" | "unknown";

type ConnectionStatusCtx = {
  db: {
    getExtState(e: string, k: string): string | null;
  };
};

type ExtCtx = {
  db: {
    getExtState(e: string, k: string): string | null;
    setExtState(e: string, k: string, v: string): void;
    deleteExtState(e: string, k: string): boolean;
  };
  log: {
    info(m: string): void;
    warn(m: string): void;
    error(m: string): void;
  };
};

/** Structural match for `MercuryExtensionAPI` (avoid package subpath imports). */
type MercuryExt = {
  permission(opts: { defaultRoles: string[] }): void;
  env(def: { from: string; as?: string }): void;
  requires(
    capabilities: (
      | "tools"
      | "vision"
      | "audio_input"
      | "audio_output"
      | "extended_thinking"
    )[],
  ): void;
  job(name: string, def: { interval: number; run: (ctx: ExtCtx) => Promise<void> }): void;
  on(event: "startup", handler: (event: Record<string, never>, ctx: ExtCtx) => Promise<void>): void;
  on(
    event: "before_container",
    handler: (
      event: { spaceId: string; callerId: string },
      ctx: ExtCtx & {
        hasCallerPermission(spaceId: string, callerId: string, permission: string): boolean;
      },
    ) => Promise<{ env?: Record<string, string> } | undefined>,
  ): void;
  skill(relativePath: string): void;
  connection(def: {
    displayName: string;
    iconUrl?: string;
    category:
      | "email"
      | "drive"
      | "calendar"
      | "finance"
      | "messaging"
      | "docs"
      | "workspace"
      | "other";
    authType:
      | "oauth2"
      | "apikey"
      | "app-password"
      | "credentials-file"
      | "form"
      | "custom";
    credentialEnvVar?: string;
    scopes?: string[];
    statusCheck?: (ctx: ConnectionStatusCtx) => Promise<{ status: ConnectionStatus; detail?: string }>;
  }): void;
};

export default function (mercury: MercuryExt) {
  mercury.permission({ defaultRoles: [] });
  mercury.requires(["tools"]);
  mercury.env({ from: "MERCURY_TS_CLIENT_ID" });
  mercury.env({ from: "MERCURY_TS_CLIENT_SECRET" });
  mercury.env({ from: "MERCURY_TRADESTATION_REFRESH_TOKEN" });

  mercury.connection({
    displayName: "TradeStation",
    category: "finance",
    authType: "oauth2",
    scopes: ["openid", "offline_access", "MarketData", "ReadAccount", "Trade"],
    // No credentialEnvVar — credentials live in extension_state, not env.
    statusCheck: async (ctx) => {
      const authError = ctx.db.getExtState(TRADESTATION_EXT, "auth_error");
      if (authError) {
        return { status: "needs-reauth", detail: authError };
      }
      const token = ctx.db.getExtState(TRADESTATION_EXT, "access_token");
      if (token) {
        return { status: "connected" };
      }
      return { status: "unknown" };
    },
  });

  mercury.on("startup", async (_, ctx) => {
    await runTradeStationTokenRefresh(ctx.db, ctx.log);
  });

  mercury.job("ts-token-refresh", {
    interval: 10 * 60 * 1000,
    run: async (ctx) => {
      await runTradeStationTokenRefresh(ctx.db, ctx.log);
    },
  });

  mercury.on("before_container", async (event, ctx) => {
    if (
      !ctx.hasCallerPermission(event.spaceId, event.callerId, TRADESTATION_EXT)
    ) {
      return undefined;
    }

    const base = apiBaseFromHost();
    const authError = ctx.db.getExtState(TRADESTATION_EXT, "auth_error");
    const token = ctx.db.getExtState(TRADESTATION_EXT, "access_token");

    const env: Record<string, string> = {
      TRADESTATION_API_BASE: base,
    };

    if (authError) {
      env.TRADESTATION_AUTH_ERROR = authError;
    }

    if (token) {
      env.TRADESTATION_ACCESS_TOKEN = token;
    }

    return { env };
  });

  mercury.skill("./skill");
}

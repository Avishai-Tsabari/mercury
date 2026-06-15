import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { ApiContext, AuthContext, Env } from "./api-types.js";
import { resolveRole } from "./permissions.js";
import {
  config,
  connections,
  control,
  conversations,
  extensions,
  media,
  messages,
  mutes,
  permissions,
  prefs,
  roles,
  spaces,
  tasks,
  tradestation,
  tts,
} from "./routes/index.js";

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// ─── App Factory ──────────────────────────────────────────────────────────

export function createApiApp(apiCtx: ApiContext): Hono<Env> {
  const app = new Hono<Env>();

  // ─── Auth Middleware ────────────────────────────────────────────────────

  app.use("*", async (c, next) => {
    // Validate API secret when configured
    const secret = apiCtx.config.apiSecret;
    if (secret) {
      const authHeader = c.req.header("authorization");
      const token = authHeader?.startsWith("Bearer ")
        ? authHeader.slice(7)
        : undefined;

      if (!token || !safeCompare(token, secret)) {
        return c.json({ error: "Unauthorized" }, 401);
      }
    }

    // Parse auth headers
    const callerId = c.req.header("x-mercury-caller");
    const spaceId = c.req.header("x-mercury-space");

    if (!callerId || !spaceId) {
      return c.json(
        { error: "Missing X-Mercury-Caller or X-Mercury-Space headers" },
        400,
      );
    }

    // Resolve role
    const seededAdmins = apiCtx.config.admins
      ? apiCtx.config.admins
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

    apiCtx.db.ensureSpace(spaceId);
    const role = resolveRole(apiCtx.db, spaceId, callerId, seededAdmins);

    // Store in request context
    c.set("auth", { callerId, spaceId, role } as AuthContext);
    c.set("apiCtx", apiCtx);
    await next();
  });

  // ─── Mount Routes ───────────────────────────────────────────────────────

  app.route("/", control);
  app.route("/tasks", tasks);
  app.route("/config", config);
  app.route("/prefs", prefs);
  app.route("/roles", roles);
  app.route("/permissions", permissions);
  app.route("/spaces", spaces);
  app.route("/conversations", conversations);
  app.route("/media", media);
  app.route("/messages", messages);
  app.route("/mutes", mutes);
  app.route("/ext", extensions);
  app.route("/connections", connections);
  app.route("/tradestation", tradestation);
  app.route("/tts", tts);

  // ─── Fallback ───────────────────────────────────────────────────────────

  app.all("*", (c) => {
    return c.json({ error: "Not found" }, 404);
  });

  return app;
}

// Re-export types for convenience
export type { ApiContext, AuthContext, Env } from "./api-types.js";

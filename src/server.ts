import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Adapter } from "chat";
import { Hono } from "hono";
import type { WhatsAppBaileysAdapter } from "./adapters/whatsapp.js";
import type { AppConfig } from "./config.js";
import { resolveProjectPath } from "./config.js";
import { createApiApp } from "./core/api.js";
import { createChatRoute } from "./core/routes/chat.js";
import { createConsoleApp } from "./core/routes/console.js";
import { createDashboardRoutes } from "./core/routes/dashboard.js";
import type { MercuryCoreRuntime } from "./core/runtime.js";
import type { ConfigRegistry } from "./extensions/config-registry.js";
import { createMercuryExtensionContext } from "./extensions/context.js";
import { ensureDerivedImage } from "./extensions/image-builder.js";
import { ExtensionRegistry } from "./extensions/loader.js";
import { logger } from "./logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const MAX_BODY_SIZE = 50 * 1024 * 1024; // 50 MB

type WaitUntil = (task: Promise<unknown>) => void;

type WebhookHandler = (
  request: Request,
  options?: { waitUntil?: WaitUntil },
) => Promise<Response>;

export interface ServerContext {
  core: MercuryCoreRuntime;
  config: AppConfig;
  adapters: Record<string, Adapter>;
  webhooks: Record<string, WebhookHandler>;
  startTime: number;
  registry: ExtensionRegistry;
  configRegistry: ConfigRegistry;
  /** Current Mercury project directory (usually `process.cwd()`). */
  projectRoot: string;
  /** Root of the mercury-agent package (for bundled `examples/extensions`). */
  packageRoot: string;
}

/**
 * Authorize an infra request against the `MERCURY_API_SECRET` Bearer token —
 * the same secret enforced by `/api/*` and `/api/console/*`. Returns 503 when no
 * secret is configured (a side-effecting endpoint must never silently run
 * unauthenticated), 401 on a missing or mismatched token, `ok` when valid.
 * Length is checked before `timingSafeEqual` (which throws on unequal buffer
 * lengths); the comparison itself is constant-time. Exported for testing.
 */
export function authorizeApiSecret(
  authHeader: string | undefined,
  secret: string | undefined,
): { ok: true } | { ok: false; status: 401 | 503 } {
  if (!secret) return { ok: false, status: 503 };
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const tokenBuf = Buffer.from(token);
  const secretBuf = Buffer.from(secret);
  if (
    tokenBuf.length !== secretBuf.length ||
    !timingSafeEqual(tokenBuf, secretBuf)
  ) {
    return { ok: false, status: 401 };
  }
  return { ok: true };
}

export function createApp(ctx: ServerContext): Hono {
  const {
    core,
    config,
    adapters,
    webhooks,
    startTime,
    projectRoot,
    packageRoot,
  } = ctx;

  const waitUntil: WaitUntil = (task) => {
    void task.catch((error) => {
      logger.error(
        "Background task failed",
        error instanceof Error ? error : undefined,
      );
    });
  };

  const app = new Hono();

  // ─── Body Size Limit ──────────────────────────────────────────────────
  app.use("*", async (c, next) => {
    const contentLength = c.req.header("content-length");
    if (contentLength && Number.parseInt(contentLength, 10) > MAX_BODY_SIZE) {
      return c.json({ error: "Request body too large" }, 413);
    }
    await next();
  });

  // ─── Dashboard ──────────────────────────────────────────────────────────

  // Cache dashboard HTML at startup
  let dashboardHtml: string | null = null;
  try {
    const html = readFileSync(join(__dirname, "dashboard/index.html"), "utf8");
    let version = "unknown";
    try {
      const pkg = JSON.parse(
        readFileSync(join(packageRoot, "package.json"), "utf8"),
      );
      version = `v${pkg.version}`;
    } catch {
      // ignore — version stays "unknown"
    }
    dashboardHtml = html.replace("{{VERSION}}", version);
  } catch {
    // Dashboard not found — will return 404
  }

  // Cache tokens.css at startup
  let tokensCss: string | null = null;
  try {
    tokensCss = readFileSync(join(__dirname, "dashboard/tokens.css"), "utf8");
  } catch {
    // tokens.css not found — will return 404
  }

  app.get("/", (c) => {
    if (!dashboardHtml) return c.text("Dashboard not found", 404);
    return c.html(dashboardHtml);
  });

  app.get("/dashboard", (c) => {
    if (!dashboardHtml) return c.text("Dashboard not found", 404);
    return c.html(dashboardHtml);
  });

  app.get("/dashboard/tokens.css", (c) => {
    if (!tokensCss) return c.text("tokens.css not found", 404);
    c.header("Content-Type", "text/css; charset=utf-8");
    c.header("Cache-Control", "public, max-age=300");
    return c.body(tokensCss);
  });

  // Dashboard partials (htmx)
  const adapterStatus: Record<string, boolean> = {};
  for (const name of Object.keys(adapters)) {
    adapterStatus[name] = true;
  }

  const dashboardRoutes = createDashboardRoutes({
    core,
    adapters: adapterStatus,
    startTime,
    registry: ctx.registry,
    configRegistry: ctx.configRegistry,
    extensionCtx: createMercuryExtensionContext({
      db: core.db,
      config,
      log: logger,
    }),
    projectRoot,
    packageRoot,
  });

  // Login route — validates token, sets session cookie, redirects to dashboard
  app.get("/dashboard/login", (c) => {
    const secret = config.apiSecret;
    if (!secret) {
      return c.redirect("/dashboard");
    }
    const token = c.req.query("token");
    if (
      !token ||
      token.length !== secret.length ||
      !timingSafeEqual(Buffer.from(token), Buffer.from(secret))
    ) {
      return c.text("Invalid or missing token", 401);
    }
    c.header(
      "Set-Cookie",
      `mercury_token=${token}; Path=/; HttpOnly; SameSite=Strict`,
    );
    return c.redirect("/dashboard");
  });

  app.use("/dashboard/*", async (c, next) => {
    // Login route handled above — skip auth
    if (c.req.path === "/dashboard/login") return next();

    const secret = config.apiSecret;
    if (secret) {
      const authHeader = c.req.header("authorization");
      const token = authHeader?.startsWith("Bearer ")
        ? authHeader.slice(7)
        : undefined;
      const cookie = c.req.header("cookie");
      const cookieToken = cookie
        ?.split(";")
        .map((s) => s.trim())
        .find((s) => s.startsWith("mercury_token="))
        ?.split("=")[1];

      const provided = token || cookieToken;
      if (
        !provided ||
        provided.length !== secret.length ||
        !timingSafeEqual(Buffer.from(provided), Buffer.from(secret))
      ) {
        return c.json({ error: "Unauthorized" }, 401);
      }
    }
    await next();
  });
  app.route("/dashboard", dashboardRoutes);

  // ─── Health & Auth ──────────────────────────────────────────────────────

  app.get("/health", (c) => {
    const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
    const adapterStatus: Record<string, boolean> = {};
    for (const name of Object.keys(adapters)) {
      adapterStatus[name] = true;
    }
    const currentImage = core.containerRunner.image;
    const extImage = currentImage.startsWith("mercury-agent-ext-")
      ? currentImage
      : null;
    return c.json({
      status: "ok",
      version:
        process.env.MERCURY_VERSION ??
        process.env.npm_package_version ??
        "unknown",
      uptime: uptimeSeconds,
      queue: {
        active: core.queue.activeCount,
        pending: core.queue.pendingCount,
      },
      containers: {
        active: core.containerRunner.activeCount,
      },
      adapters: adapterStatus,
      extImage,
    });
  });

  // ─── Pre-build ext image (called by the orchestrator during Phase A of rolling deploy) ──
  // Builds the derived ext image for the given base image tag against this agent's
  // current extension set. After this completes the image is cached — the swap
  // container finds it immediately and skips the build, exiting warming in ~1s.
  //
  // Auth: requires the MERCURY_API_SECRET Bearer token (same as /api/* and
  // /api/console/*). Unlike /health this endpoint has side effects — it loads
  // extensions with caller-supplied env and spawns a Docker build — so it must
  // not rely on mercury-net topology alone (the process binds 0.0.0.0:8787).
  // When no secret is configured it refuses with 503 rather than running open,
  // so it can never silently serve unauthenticated.
  app.post("/pre-build-ext-image", async (c) => {
    const auth = authorizeApiSecret(
      c.req.header("authorization"),
      config.apiSecret,
    );
    if (!auth.ok) {
      return c.json(
        auth.status === 503
          ? { error: "MERCURY_API_SECRET must be set for /pre-build-ext-image" }
          : { error: "Unauthorized" },
        auth.status,
      );
    }
    const raw = await c.req.json().catch(() => null);
    const body =
      raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const targetAgentImage = body.targetAgentImage;
    if (typeof targetAgentImage !== "string" || !targetAgentImage) {
      return c.json({ error: "targetAgentImage is required" }, 400);
    }

    // When targetEnv is provided, simulate extension loading with the target
    // container's env so the pre-built image hash matches the -next container.
    let extensions = ctx.registry.list();
    const targetEnv = body.targetEnv;
    if (
      targetEnv &&
      typeof targetEnv === "object" &&
      !Array.isArray(targetEnv)
    ) {
      // Coerce all values to strings to avoid null/number values slipping past
      // the credential gate check (!envToCheck[credVar]).
      const envOverride = Object.fromEntries(
        Object.entries(targetEnv as Record<string, unknown>)
          .filter(([, v]) => typeof v === "string")
          .map(([k, v]) => [k, v as string]),
      );
      const tempRegistry = new ExtensionRegistry();
      const extensionsDir = resolveProjectPath(`${config.dataDir}/extensions`);
      const builtinExtDir = join(packageRoot, "resources/extensions");
      try {
        await tempRegistry.loadAll(
          extensionsDir,
          core.db,
          logger,
          null,
          [builtinExtDir],
          envOverride,
        );
        extensions = tempRegistry.list();
      } catch (err) {
        logger.warn(
          "pre-build: failed to load extensions with targetEnv, falling back to current registry",
          {
            error: err instanceof Error ? err.message : String(err),
          },
        );
      }
    }

    const derivedImage = await ensureDerivedImage(
      targetAgentImage,
      extensions,
      logger,
      process.env.MERCURY_AGENT_ID,
    );
    return c.json({ status: "ok", derivedImage });
  });

  app.get("/auth/whatsapp", (c) => {
    const whatsappAdapter = adapters.whatsapp as
      | WhatsAppBaileysAdapter
      | undefined;
    if (!whatsappAdapter) {
      return c.json({ error: "WhatsApp adapter not enabled" }, 400);
    }
    const status = whatsappAdapter.getQrStatus();
    return c.json(status);
  });

  // ─── Control plane JSON API (Bearer MERCURY_API_SECRET) ─────────────────
  const consoleApp = createConsoleApp({
    projectRoot,
    packageRoot,
    apiSecret: config.apiSecret,
    db: core.db,
    spacesDir: config.spacesDir,
    dbPath: config.dbPath,
    whatsappAuthDir: config.whatsappAuthDir,
    registry: ctx.registry,
    config,
  });
  app.route("/api/console", consoleApp);

  // ─── Internal API ───────────────────────────────────────────────────────

  const apiApp = createApiApp({
    db: core.db,
    config,
    containerRunner: core.containerRunner,
    queue: core.queue,
    scheduler: core.scheduler,
    registry: ctx.registry,
    configRegistry: ctx.configRegistry,
    runtime: core,
  });

  app.route("/api", apiApp);
  app.route("/chat", createChatRoute(core));

  // ─── Webhooks ───────────────────────────────────────────────────────────

  app.all("/webhooks/:platform", async (c) => {
    const platform = c.req.param("platform");
    logger.info("Webhook dispatch", { platform });

    const handler = webhooks[platform];
    if (!handler) {
      return c.text(`Unknown platform: ${platform}`, 404);
    }

    return handler(c.req.raw, { waitUntil });
  });

  // ─── Fallback ───────────────────────────────────────────────────────────

  app.all("*", (c) => {
    return c.text("Not found", 404);
  });

  return app;
}

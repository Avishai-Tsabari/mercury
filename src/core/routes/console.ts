import { spawnSync } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { CronExpressionParser } from "cron-parser";
import { Hono } from "hono";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { AppConfig } from "../../config.js";
import {
  EXTENSION_CATALOG,
  getCatalogEntryByName,
} from "../../extensions/catalog.js";
import {
  installExtensionFromDirectory,
  removeInstalledExtension,
  resolveExamplesExtensionDir,
} from "../../extensions/installer.js";
import type { ExtensionRegistry } from "../../extensions/loader.js";
import { logger } from "../../logger.js";
import type { Db } from "../../storage/db.js";
import { removeSpaceWorkspace } from "../../storage/memory.js";
import {
  isBuiltinConfigKey,
  validateBuiltinConfigValue,
} from "./config-builtin.js";
import { resolveConnectionList } from "./connections.js";
import { ensureSpacesDirExists, getStorageInfo } from "./storage.js";

/* ── Adapter configuration helpers ──────────────────────────────── */

/** Which env vars each adapter requires (beyond the enable flag). */
const ADAPTER_CREDENTIALS: Record<string, string[]> = {
  whatsapp: [],
  telegram: ["MERCURY_TELEGRAM_BOT_TOKEN"],
  discord: ["MERCURY_DISCORD_BOT_TOKEN"],
  slack: ["MERCURY_SLACK_BOT_TOKEN", "MERCURY_SLACK_SIGNING_SECRET"],
  teams: ["MERCURY_TEAMS_APP_ID", "MERCURY_TEAMS_APP_PASSWORD"],
};

const ADAPTER_ENABLE_VARS: Record<string, string> = {
  whatsapp: "MERCURY_ENABLE_WHATSAPP",
  telegram: "MERCURY_ENABLE_TELEGRAM",
  discord: "MERCURY_ENABLE_DISCORD",
  slack: "MERCURY_ENABLE_SLACK",
  teams: "MERCURY_ENABLE_TEAMS",
};

/**
 * Parse a `.env` file into ordered entries preserving comments and blanks.
 * Returns an array of `{ key, value, raw }` where key is null for non-KV lines.
 */
export function parseDotEnv(
  content: string,
): { key: string | null; value: string; raw: string }[] {
  return content.split(/\r?\n/).map((raw) => {
    const m = raw.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)/);
    if (!m) return { key: null, value: "", raw };
    return { key: m[1], value: m[2], raw };
  });
}

/**
 * Update keys in a `.env` file. Keys mapped to `null` are removed.
 * Writes atomically via tmp+rename.
 */
export function updateDotEnv(
  envPath: string,
  updates: Record<string, string | null>,
): void {
  const content = existsSync(envPath) ? readFileSync(envPath, "utf-8") : "";
  const entries = parseDotEnv(content);
  const remaining = { ...updates };

  // Update or remove existing lines
  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.key && entry.key in remaining) {
      const val = remaining[entry.key];
      if (val !== null) {
        lines.push(`${entry.key}=${val}`);
      }
      // val === null → skip line (remove)
      delete remaining[entry.key];
    } else {
      lines.push(entry.raw);
    }
  }

  // Append new keys
  for (const [k, v] of Object.entries(remaining)) {
    if (v !== null) {
      lines.push(`${k}=${v}`);
    }
  }

  const out = lines.join("\n");
  const tmp = `${envPath}.tmp`;
  writeFileSync(tmp, out, { mode: 0o600 });
  renameSync(tmp, envPath);
}

/**
 * Update the `ingress` section of a mercury.yaml file.
 * Creates the file with just the ingress section if it doesn't exist.
 */
function updateMercuryYaml(
  yamlPath: string,
  ingressUpdate: Record<string, boolean>,
): void {
  let doc: Record<string, unknown> = {};
  if (existsSync(yamlPath)) {
    const raw = readFileSync(yamlPath, "utf-8");
    doc = (parseYaml(raw) as Record<string, unknown>) ?? {};
  }
  const ingress = (doc.ingress as Record<string, boolean>) ?? {};
  Object.assign(ingress, ingressUpdate);
  doc.ingress = ingress;
  const out = stringifyYaml(doc);
  const tmp = `${yamlPath}.tmp`;
  writeFileSync(tmp, out, "utf-8");
  renameSync(tmp, yamlPath);
}

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * JSON control-plane API (Bearer MERCURY_API_SECRET only).
 * Complements dashboard HTML forms for remote provisioning tools.
 */
export function createConsoleApp(opts: {
  projectRoot: string;
  packageRoot: string;
  apiSecret: string | undefined;
  db?: Db;
  spacesDir: string;
  dbPath: string;
  whatsappAuthDir: string;
  registry?: ExtensionRegistry;
  /** Used by /connections to build extension contexts for statusCheck. */
  config?: AppConfig;
}): Hono {
  const app = new Hono();

  ensureSpacesDirExists(opts.spacesDir);

  app.use("*", async (c, next) => {
    if (!opts.apiSecret) {
      return c.json(
        { error: "MERCURY_API_SECRET must be set for /api/console" },
        503,
      );
    }
    const auth = c.req.header("authorization");
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!safeCompare(token, opts.apiSecret)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    await next();
  });

  app.get("/extensions", (c) => {
    const list = (opts.registry?.list() ?? []).map((ext) => ({
      name: ext.name,
      hasCli: ext.clis.length > 0,
      hasSkill: !!ext.skillDir,
    }));
    return c.json({ extensions: list });
  });

  app.get("/extensions/catalog", (c) => {
    return c.json({
      extensions: EXTENSION_CATALOG.map((e) => ({
        name: e.name,
        sourceDir: e.sourceDir,
      })),
    });
  });

  app.post("/extensions/install", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      source?: string;
      catalogName?: string;
    };
    const source = typeof body.source === "string" ? body.source.trim() : "";
    const catalogName =
      typeof body.catalogName === "string" ? body.catalogName.trim() : "";

    if (catalogName) {
      const entry = getCatalogEntryByName(catalogName);
      if (!entry) {
        return c.json({ error: "Unknown catalog extension" }, 400);
      }
      const src = resolveExamplesExtensionDir(
        opts.packageRoot,
        entry.sourceDir,
      );
      if (!existsSync(src)) {
        return c.json(
          { error: "Bundled extension source not found on this install" },
          500,
        );
      }
      const result = await installExtensionFromDirectory({
        cwd: opts.projectRoot,
        sourceDir: src,
        destName: entry.name,
      });
      if (!result.ok) {
        return c.json({ error: result.error }, 500);
      }
      return c.json({ ok: true, name: entry.name });
    }

    if (source) {
      const r = spawnSync("mercury", ["add", source], {
        cwd: opts.projectRoot,
        encoding: "utf8",
        env: process.env,
      });
      if (r.status !== 0) {
        return c.json(
          {
            error: (r.stderr || r.stdout || "mercury add failed").trim(),
          },
          500,
        );
      }
      return c.json({ ok: true, log: (r.stdout || "").trim() });
    }

    return c.json(
      { error: "Provide JSON body { catalogName } or { source }" },
      400,
    );
  });

  app.post("/restart", (c) => {
    setTimeout(() => process.kill(process.pid, "SIGTERM"), 500);
    return c.json({ ok: true, restarting: true });
  });

  app.delete("/extensions/:name", (c) => {
    const name = c.req.param("name");
    const result = removeInstalledExtension({ cwd: opts.projectRoot, name });
    if (!result.ok) {
      return c.json({ error: result.error }, 400);
    }
    return c.json({ ok: true });
  });

  /**
   * List all connection-enabled extensions with resolved runtime status.
   * Mirrors `/api/connections` but Bearer-authed so the console can call it
   * without the caller/space headers that the internal API middleware enforces.
   */
  app.get("/connections", async (c) => {
    if (!opts.registry) {
      return c.json({ error: "Extension registry not initialized" }, 503);
    }
    if (!opts.db) {
      return c.json({ error: "Database not initialized" }, 503);
    }
    if (!opts.config) {
      return c.json({ error: "Config not initialized" }, 503);
    }
    const connections = await resolveConnectionList({
      registry: opts.registry,
      db: opts.db,
      config: opts.config,
    });
    return c.json({ connections });
  });

  /* ── Credential injection ────────────────────────────────────── */

  app.post("/credentials", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      envVar?: string;
      value?: string;
      restart?: boolean;
    };

    const envVar = typeof body.envVar === "string" ? body.envVar.trim() : "";
    const value = typeof body.value === "string" ? body.value : "";
    const shouldRestart = body.restart !== false;

    if (!envVar || !/^[A-Z_][A-Z0-9_]*$/.test(envVar)) {
      return c.json(
        { error: "envVar must be a valid SCREAMING_SNAKE_CASE name" },
        400,
      );
    }

    const envPath = path.join(opts.projectRoot, ".env");
    updateDotEnv(envPath, { [envVar]: value || null });
    logger.info(`Console: credential written`, { envVar, removed: !value });

    if (shouldRestart && value) {
      setTimeout(() => process.kill(process.pid, "SIGTERM"), 500);
      return c.json({ ok: true, envVar, restarting: true });
    }

    return c.json({ ok: true, envVar, restarting: false });
  });

  /* ── Adapter management ──────────────────────────────────────── */

  /** Return current adapter enable/disable state and credential presence. */
  app.get("/adapters", (c) => {
    const adapters: Record<
      string,
      { enabled: boolean; credentials: Record<string, boolean> }
    > = {};
    for (const [name, creds] of Object.entries(ADAPTER_CREDENTIALS)) {
      const enableVar = ADAPTER_ENABLE_VARS[name];
      const enabled =
        process.env[enableVar]?.toLowerCase() === "true" ||
        process.env[enableVar] === "1";
      const credentials: Record<string, boolean> = {};
      for (const envKey of creds) {
        credentials[envKey] = !!process.env[envKey];
      }
      adapters[name] = { enabled, credentials };
    }
    return c.json({ adapters });
  });

  /**
   * Configure adapters: update .env + mercury.yaml, then restart.
   *
   * Body: `{ adapters: { [name]: { enabled: boolean, env?: Record<string,string> } } }`
   *
   * Credentials are only written when provided (non-empty string).
   * An adapter being disabled removes its enable flag but keeps stored credentials
   * so re-enabling doesn't require re-entering them.
   */
  app.post("/adapters/configure", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      adapters?: Record<
        string,
        { enabled?: boolean; env?: Record<string, string> }
      >;
    };

    if (!body.adapters || typeof body.adapters !== "object") {
      return c.json({ error: "Body must include { adapters: { ... } }" }, 400);
    }

    const envUpdates: Record<string, string | null> = {};
    const ingressUpdates: Record<string, boolean> = {};

    for (const [name, cfg] of Object.entries(body.adapters)) {
      // __model_providers is a synthetic key used by the console to push
      // model provider API keys and the model chain. It is not a real adapter —
      // skip enable/credentials validation and just write the env vars.
      if (name === "__model_providers") {
        if (cfg.env) {
          for (const [k, v] of Object.entries(cfg.env)) {
            const trimmed = typeof v === "string" ? v.trim() : "";
            if (trimmed) {
              envUpdates[k] = trimmed;
            }
          }
        }
        continue;
      }

      if (!(name in ADAPTER_CREDENTIALS)) {
        return c.json({ error: `Unknown adapter: ${name}` }, 400);
      }

      const enabled = cfg.enabled === true;
      const enableVar = ADAPTER_ENABLE_VARS[name];
      envUpdates[enableVar] = enabled ? "true" : "false";
      ingressUpdates[name] = enabled;

      // Validate that required credentials are present (either in payload or already in env)
      if (enabled) {
        for (const reqVar of ADAPTER_CREDENTIALS[name]) {
          const inPayload = cfg.env?.[reqVar]?.trim();
          const inEnv = !!process.env[reqVar];
          if (!inPayload && !inEnv) {
            return c.json(
              {
                error: `Adapter "${name}" requires ${reqVar} but it is not set`,
              },
              400,
            );
          }
        }
      }

      // Write any credential env vars that were provided
      if (cfg.env) {
        for (const [k, v] of Object.entries(cfg.env)) {
          const trimmed = typeof v === "string" ? v.trim() : "";
          if (trimmed) {
            envUpdates[k] = trimmed;
          }
          // Empty string → keep existing (don't overwrite)
        }
      }
    }

    try {
      const envPath = path.join(opts.projectRoot, ".env");
      updateDotEnv(envPath, envUpdates);

      const yamlPath = path.join(opts.projectRoot, "mercury.yaml");
      updateMercuryYaml(yamlPath, ingressUpdates);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: `Failed to write config: ${msg}` }, 500);
    }

    // Schedule a graceful restart so the response reaches the caller
    setTimeout(() => {
      process.kill(process.pid, "SIGTERM");
    }, 500);

    return c.json({ ok: true, restarting: true });
  });

  /**
   * Purge Baileys WhatsApp auth files so the next re-enable generates a fresh QR.
   * Idempotent: absent directory is treated as success.
   * Path comes from config — never from the request body.
   */
  app.post("/adapters/whatsapp/purge", async (c) => {
    const authDir = opts.whatsappAuthDir;
    const alreadyAbsent = !existsSync(authDir);
    if (!alreadyAbsent) {
      try {
        await rm(authDir, { recursive: true, force: true });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return c.json({ error: "purge_failed", detail }, 500);
      }
    }
    logger.info("whatsapp auth purged", {
      whatsappAuthDir: authDir,
      alreadyAbsent,
    });
    const result: { wiped: boolean; alreadyAbsent?: boolean } = { wiped: true };
    if (alreadyAbsent) result.alreadyAbsent = true;
    return c.json(result);
  });

  /* ── Usage data ──────────────────────────────────────────────── */

  app.get("/usage", (c) => {
    if (!opts.db) {
      return c.json({ error: "Database not available" }, 503);
    }
    const totals = opts.db.getUsageTotals();
    const summary = opts.db.getUsageSummary();
    const perSpace = summary.map((row) => ({
      spaceId: row.spaceId,
      totalInputTokens: row.totalInputTokens,
      totalOutputTokens: row.totalOutputTokens,
      totalTokens: row.totalTokens,
      totalCost: row.totalCost,
      runCount: row.runCount,
      lastUsedAt: row.lastUsedAt ?? null,
    }));
    return c.json({ totals, perSpace });
  });

  app.get("/storage", async (c) => {
    const info = await getStorageInfo({
      spacesDir: opts.spacesDir,
      dbPath: opts.dbPath,
    });
    return c.json(info);
  });

  /* ── Space config management ────────────────────────────────── */

  app.get("/spaces", (c) => {
    if (!opts.db) {
      return c.json({ error: "Database not available" }, 503);
    }
    const spaces = opts.db.listSpaces();
    return c.json({ spaces });
  });

  app.post("/spaces", async (c) => {
    if (!opts.db) {
      return c.json({ error: "Database not available" }, 503);
    }
    let body: { id?: unknown; name?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const id = typeof body.id === "string" ? body.id.trim() : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!id) {
      return c.json({ error: "id is required" }, 400);
    }
    if (!name) {
      return c.json({ error: "name is required" }, 400);
    }
    try {
      const space = opts.db.createSpace(id, name);
      return c.json(space, 201);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith("Space already exists")) {
        return c.json({ error: `Space already exists: ${id}` }, 409);
      }
      if (msg.startsWith("Invalid space id")) {
        return c.json({ error: msg }, 400);
      }
      return c.json({ error: msg }, 500);
    }
  });

  app.patch("/spaces/:spaceId", async (c) => {
    if (!opts.db) {
      return c.json({ error: "Database not available" }, 503);
    }
    let body: { name?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) {
      return c.json({ error: "name is required" }, 400);
    }
    const spaceId = c.req.param("spaceId");
    const updated = opts.db.updateSpaceName(spaceId, name);
    if (!updated) {
      return c.json({ error: "Space not found" }, 404);
    }
    return c.json({ ok: true });
  });

  app.delete("/spaces/:spaceId", (c) => {
    if (!opts.db) {
      return c.json({ error: "Database not available" }, 503);
    }
    const spaceId = c.req.param("spaceId");
    const result = opts.db.deleteSpace(spaceId);
    if (!result.deleted) {
      return c.json({ error: "Space not found" }, 404);
    }
    removeSpaceWorkspace(opts.spacesDir, spaceId);
    return c.json({ ok: true, removed: result.removed });
  });

  app.get("/spaces/:spaceId/config", (c) => {
    if (!opts.db) {
      return c.json({ error: "Database not available" }, 503);
    }
    const spaceId = c.req.param("spaceId");
    const config: Record<string, string> = {};
    for (const entry of opts.db.listSpaceConfig(spaceId)) {
      config[entry.key] = entry.value;
    }
    return c.json({ spaceId, config });
  });

  app.put("/spaces/:spaceId/config", async (c) => {
    if (!opts.db) {
      return c.json({ error: "Database not available" }, 503);
    }
    const spaceId = c.req.param("spaceId");
    const body = (await c.req.json().catch(() => ({}))) as {
      key?: string;
      value?: string;
    };
    const key = typeof body.key === "string" ? body.key.trim() : "";
    const value = typeof body.value === "string" ? body.value : "";

    if (!key) {
      return c.json({ error: "key is required" }, 400);
    }

    // Validate against built-in keys
    if (isBuiltinConfigKey(key)) {
      const err = validateBuiltinConfigValue(key, value);
      if (err) {
        return c.json({ error: err }, 400);
      }
    }

    opts.db.setSpaceConfig(spaceId, key, value, "console");
    return c.json({ ok: true });
  });

  app.post("/spaces/:spaceId/tasks", async (c) => {
    if (!opts.db) {
      return c.json({ error: "Database not available" }, 503);
    }
    const spaceId = c.req.param("spaceId");

    const space = opts.db.getSpace(spaceId);
    if (!space) {
      return c.json({ error: "Space not found" }, 404);
    }

    const body = (await c.req.json().catch(() => ({}))) as {
      cron?: unknown;
      prompt?: unknown;
      timezone?: unknown;
      name?: unknown;
    };

    const cron = typeof body.cron === "string" ? body.cron.trim() : "";
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";

    if (!cron) {
      return c.json({ error: "cron is required" }, 400);
    }
    if (!prompt) {
      return c.json({ error: "prompt is required" }, 400);
    }

    let timezone: string | undefined;
    if (typeof body.timezone === "string" && body.timezone) {
      try {
        if (!Intl.supportedValuesOf("timeZone").includes(body.timezone)) {
          return c.json({ error: "Invalid timezone identifier" }, 400);
        }
        timezone = body.timezone;
      } catch {
        return c.json({ error: "Invalid timezone identifier" }, 400);
      }
    }

    const name =
      typeof body.name === "string" && body.name.trim()
        ? body.name.trim().slice(0, 100)
        : undefined;

    let nextRunAt: number;
    try {
      const interval = CronExpressionParser.parse(cron, {
        currentDate: new Date(),
        tz: timezone ?? "UTC",
      });
      nextRunAt = interval.next().getTime();
    } catch {
      return c.json({ error: "Invalid cron expression" }, 400);
    }

    const id = opts.db.createTask(
      spaceId,
      { cron },
      prompt,
      nextRunAt,
      "system",
      false,
      timezone,
      name,
    );

    return c.json(
      {
        id,
        cron,
        prompt,
        timezone: timezone ?? null,
        name: name ?? null,
        nextRunAt,
      },
      201,
    );
  });

  app.get("/spaces/:spaceId/messages", (c) => {
    if (!opts.db) {
      return c.json({ error: "Database not available" }, 503);
    }
    const spaceId = c.req.param("spaceId");
    const limitParam = c.req.query("limit");
    const limit = Math.min(Math.max(1, Number(limitParam) || 50), 200);
    const messages = opts.db.getRecentMessages(spaceId, limit);
    messages.reverse();
    return c.json({
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        createdAt: m.createdAt,
        runMeta: m.runMeta ? JSON.stringify(m.runMeta) : null,
      })),
    });
  });

  return app;
}

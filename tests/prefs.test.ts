import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Hono } from "hono";
import { formatPreferencesXml } from "../src/agent/preferences-prompt.js";
import type { AppConfig } from "../src/config.js";
import { createApiApp, type Env } from "../src/core/api.js";
import { seededSpaces } from "../src/core/permissions.js";
import { SpaceQueue } from "../src/core/space-queue.js";
import { ConfigRegistry } from "../src/extensions/config-registry.js";
import { ExtensionRegistry } from "../src/extensions/loader.js";
import { Db } from "../src/storage/db.js";

describe("space_preferences (Db)", () => {
  let tmpDir: string;
  let db: Db;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-prefs-db-"));
    db = new Db(path.join(tmpDir, "state.db"));
    db.ensureSpace("main");
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("set, get, list, delete", () => {
    db.setSpacePreference("main", "stock-sources", "Use Yahoo Finance", "u1");
    expect(db.getSpacePreference("main", "stock-sources")).toBe(
      "Use Yahoo Finance",
    );
    const list = db.listSpacePreferences("main");
    expect(list.length).toBe(1);
    expect(list[0].key).toBe("stock-sources");
    expect(list[0].createdBy).toBe("u1");
    expect(db.deleteSpacePreference("main", "stock-sources")).toBe(true);
    expect(db.getSpacePreference("main", "stock-sources")).toBeNull();
  });

  test("upsert does not count toward 50-cap when updating existing key", () => {
    for (let i = 0; i < 50; i++) {
      db.setSpacePreference("main", `k${i}`, `v${i}`, "u1");
    }
    db.setSpacePreference("main", "k0", "updated", "u1");
    expect(db.countSpacePreferences("main")).toBe(50);
  });

  test("rejects 51st distinct key", () => {
    for (let i = 0; i < 50; i++) {
      db.setSpacePreference("main", `k${i}`, `v${i}`, "u1");
    }
    expect(() => db.setSpacePreference("main", "extra", "x", "u1")).toThrow(
      "Maximum 50",
    );
  });

  test("deleteSpace removes preferences", () => {
    db.setSpacePreference("main", "a", "1", "u1");
    const r = db.deleteSpace("main");
    expect(r.deleted).toBe(true);
    expect(r.removed.preferences).toBe(1);
  });
});

describe("formatPreferencesXml", () => {
  test("returns null when empty", () => {
    expect(formatPreferencesXml()).toBeNull();
    expect(formatPreferencesXml([])).toBeNull();
  });

  test("escapes XML in body and attributes", () => {
    const xml = formatPreferencesXml([{ key: "x", value: "a & b < c" }]);
    expect(xml).toContain('key="x"');
    expect(xml).toContain("a &amp; b &lt; c");
  });
});

describe("/api/prefs", () => {
  let tmpDir: string;
  let db: Db;
  let app: Hono<Env>;
  let config: AppConfig;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-prefs-api-"));
    db = new Db(path.join(tmpDir, "state.db"));
    seededSpaces.clear();

    config = {
      logLevel: "silent",
      logFormat: "text",
      modelProvider: "anthropic",
      model: "claude-sonnet-4-20250514",
      triggerPatterns: "@Pi,Pi",
      triggerMatch: "mention",
      dataDir: tmpDir,
      agentContainerImage: "mercury-agent:test",
      containerTimeoutMs: 60000,
      maxConcurrency: 2,
      rateLimitPerUser: 10,
      rateLimitWindowMs: 60000,
      port: 8787,
      botUsername: "mercury",
      enableDiscord: false,
      discordGatewayDurationMs: 600000,
      enableSlack: false,
      enableWhatsApp: false,
      mediaEnabled: true,
      mediaMaxSizeMb: 10,
      admins: "admin1",
      kbDistillIntervalMs: 0,
      globalDir: path.join(tmpDir, "global"),
      spacesDir: path.join(tmpDir, "spaces"),
      whatsappAuthDir: path.join(tmpDir, "whatsapp"),
    } as AppConfig;

    app = createApiApp({
      db,
      config,
      containerRunner: { abort: () => false },
      queue: new SpaceQueue(2),
      scheduler: { triggerTask: async () => {} },
      registry: new ExtensionRegistry(),
      configRegistry: new ConfigRegistry(),
    });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function api(
    method: string,
    pathname: string,
    options: {
      callerId?: string;
      spaceId?: string;
      body?: unknown;
    } = {},
  ): Promise<{ status: number; data: Record<string, unknown> }> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-mercury-caller": options.callerId ?? "admin1",
      "x-mercury-space": options.spaceId ?? "g1",
    };
    const path = pathname.replace(/^\/api/, "");
    const res = await app.request(path, {
      method,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const data = (await res.json()) as Record<string, unknown>;
    return { status: res.status, data };
  }

  test("admin can set and list", async () => {
    const put = await api("PUT", "/api/prefs", {
      body: { key: "stock-sources", value: "Yahoo" },
    });
    expect(put.status).toBe(200);

    const list = await api("GET", "/api/prefs");
    expect(list.status).toBe(200);
    const prefs = list.data.preferences as Array<{
      key: string;
      value: string;
    }>;
    expect(
      prefs.some((p) => p.key === "stock-sources" && p.value === "Yahoo"),
    ).toBe(true);
  });

  test("member can list but not set", async () => {
    await api("PUT", "/api/prefs", {
      body: { key: "k", value: "v" },
    });

    const getOk = await api("GET", "/api/prefs", { callerId: "user1" });
    expect(getOk.status).toBe(200);

    const putDeny = await api("PUT", "/api/prefs", {
      callerId: "user1",
      body: { key: "k2", value: "v2" },
    });
    expect(putDeny.status).toBe(403);
  });

  test("invalid key returns 400", async () => {
    const r = await api("PUT", "/api/prefs", {
      body: { key: "Bad Key", value: "x" },
    });
    expect(r.status).toBe(400);
  });

  test("get by key and delete", async () => {
    await api("PUT", "/api/prefs", {
      body: { key: "a", value: "b" },
    });
    const one = await api("GET", "/api/prefs/a");
    expect(one.status).toBe(200);
    expect(one.data.value).toBe("b");

    const del = await api("DELETE", "/api/prefs/a");
    expect(del.status).toBe(200);

    const missing = await api("GET", "/api/prefs/a");
    expect(missing.status).toBe(404);
  });
});

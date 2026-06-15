import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Hono } from "hono";
import type { AppConfig } from "../src/config.js";
import { createApiApp, type Env } from "../src/core/api.js";
import { resetPermissions, seededSpaces } from "../src/core/permissions.js";
import { SpaceQueue } from "../src/core/space-queue.js";
import { ConfigRegistry } from "../src/extensions/config-registry.js";
import { ExtensionRegistry } from "../src/extensions/loader.js";
import { Db } from "../src/storage/db.js";

let tmpDir: string;
let db: Db;
let configRegistry: ConfigRegistry;
let app: Hono<Env>;

const containerRunner = { abort: () => false } as never;
const scheduler = { triggerTask: async () => false } as never;

function req(
  method: string,
  path: string,
  opts: { body?: unknown; caller?: string; space?: string } = {},
) {
  const headers: Record<string, string> = {
    "X-Mercury-Caller": opts.caller ?? "admin1",
    "X-Mercury-Space": opts.space ?? "test-group",
    "Content-Type": "application/json",
  };
  return app.request(path, {
    method,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
}

beforeEach(() => {
  resetPermissions();
  seededSpaces.clear();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-config-test-"));
  db = new Db(path.join(tmpDir, "test.db"));
  configRegistry = new ConfigRegistry();

  // Seed admin
  const config = {
    port: 8787,
    admins: "admin1",
  } as AppConfig;

  db.ensureSpace("test-group");

  app = createApiApp({
    db,
    config,
    containerRunner,
    queue: new SpaceQueue(2),
    scheduler,
    registry: new ExtensionRegistry(),
    configRegistry,
  });
});

afterEach(() => {
  resetPermissions();
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("ConfigRegistry", () => {
  test("register and retrieve config", () => {
    configRegistry.register("napkin", "enabled", {
      description: "Enable napkin",
      default: "true",
    });

    expect(configRegistry.size).toBe(1);
    expect(configRegistry.isValidKey("napkin.enabled")).toBe(true);
    expect(configRegistry.isValidKey("napkin.other")).toBe(false);

    const cfg = configRegistry.get("napkin.enabled");
    expect(cfg).toBeDefined();
    expect(cfg?.extension).toBe("napkin");
    expect(cfg?.description).toBe("Enable napkin");
    expect(cfg?.default).toBe("true");
  });

  test("duplicate key throws", () => {
    configRegistry.register("ext", "key", {
      description: "d",
      default: "v",
    });
    expect(() =>
      configRegistry.register("ext", "key", {
        description: "d",
        default: "v",
      }),
    ).toThrow("already registered");
  });

  test("validation works", () => {
    configRegistry.register("ext", "mode", {
      description: "Mode",
      default: "fast",
      validate: (v) => v === "fast" || v === "slow",
    });

    expect(configRegistry.validate("ext.mode", "fast")).toBe(true);
    expect(configRegistry.validate("ext.mode", "slow")).toBe(true);
    expect(configRegistry.validate("ext.mode", "invalid")).toBe(false);
  });

  test("validate returns true when no validator", () => {
    configRegistry.register("ext", "open", {
      description: "d",
      default: "x",
    });
    expect(configRegistry.validate("ext.open", "anything")).toBe(true);
  });

  test("validate returns false for unknown key", () => {
    expect(configRegistry.validate("unknown.key", "val")).toBe(false);
  });

  test("getAll returns all configs", () => {
    configRegistry.register("a", "x", { description: "d", default: "1" });
    configRegistry.register("b", "y", { description: "d", default: "2" });
    expect(configRegistry.getAll()).toHaveLength(2);
  });

  test("getForExtension filters", () => {
    configRegistry.register("a", "x", { description: "d", default: "1" });
    configRegistry.register("a", "y", { description: "d", default: "2" });
    configRegistry.register("b", "z", { description: "d", default: "3" });

    expect(configRegistry.getForExtension("a")).toHaveLength(2);
    expect(configRegistry.getForExtension("b")).toHaveLength(1);
    expect(configRegistry.getForExtension("c")).toHaveLength(0);
  });

  test("reset clears all", () => {
    configRegistry.register("a", "x", { description: "d", default: "1" });
    configRegistry.reset();
    expect(configRegistry.size).toBe(0);
  });
});

describe("Config API route with extension configs", () => {
  test("GET /config includes available extension configs", async () => {
    configRegistry.register("napkin", "enabled", {
      description: "Enable napkin",
      default: "true",
    });

    const res = await req("GET", "/config");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.available).toHaveLength(1);
    expect(body.available[0].key).toBe("napkin.enabled");
    expect(body.available[0].description).toBe("Enable napkin");
    expect(body.available[0].default).toBe("true");
  });

  test("PUT /config accepts extension config key", async () => {
    configRegistry.register("napkin", "enabled", {
      description: "Enable napkin",
      default: "true",
      validate: (v) => v === "true" || v === "false",
    });

    const res = await req("PUT", "/config", {
      body: { key: "napkin.enabled", value: "false" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.key).toBe("napkin.enabled");
    expect(body.value).toBe("false");
  });

  test("PUT /config rejects invalid extension config value", async () => {
    configRegistry.register("napkin", "mode", {
      description: "Mode",
      default: "fast",
      validate: (v) => v === "fast" || v === "slow",
    });

    const res = await req("PUT", "/config", {
      body: { key: "napkin.mode", value: "turbo" },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid value");
  });

  test("PUT /config rejects unknown key", async () => {
    const res = await req("PUT", "/config", {
      body: { key: "unknown.key", value: "val" },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("Invalid config key");
  });

  test("PUT /config still accepts built-in keys", async () => {
    const res = await req("PUT", "/config", {
      body: { key: "trigger.match", value: "always" },
    });
    expect(res.status).toBe(200);
  });

  test("PUT /config still validates built-in keys", async () => {
    const res = await req("PUT", "/config", {
      body: { key: "trigger.match", value: "invalid" },
    });
    expect(res.status).toBe(400);
  });
});

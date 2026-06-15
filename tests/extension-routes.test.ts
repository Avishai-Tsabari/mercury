import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Hono } from "hono";
import type { AgentContainerRunner } from "../src/agent/container-runner.js";
import type { AppConfig } from "../src/config.js";
import { createApiApp, type Env } from "../src/core/api.js";
import { resetPermissions, seededSpaces } from "../src/core/permissions.js";
import { SpaceQueue } from "../src/core/space-queue.js";
import type { TaskScheduler } from "../src/core/task-scheduler.js";
import { ConfigRegistry } from "../src/extensions/config-registry.js";
import { ExtensionRegistry } from "../src/extensions/loader.js";
import { Db } from "../src/storage/db.js";

type ExtensionSummary = {
  name: string;
  hasCli: boolean;
  permission: string | null;
};

type ListExtensionsResponse = {
  extensions: ExtensionSummary[];
};

let tmpDir: string;
let db: Db;
let app: Hono<Env>;
let registry: ExtensionRegistry;

const headers = (caller = "admin1", group = "test-group") => ({
  "x-mercury-caller": caller,
  "x-mercury-space": group,
  "content-type": "application/json",
});

const containerRunner = {
  isRunning: () => false,
  abort: () => false,
  activeCount: 0,
  getActiveGroups: () => [],
} as unknown as AgentContainerRunner;

const scheduler = {
  start: () => {},
  stop: () => {},
  getUpcomingTasks: () => [],
} as unknown as TaskScheduler;

beforeEach(async () => {
  resetPermissions();
  seededSpaces.clear();

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-ext-routes-"));
  db = new Db(path.join(tmpDir, "state.db"));

  // Create extension dir with two extensions
  const extDir = path.join(tmpDir, "extensions");
  fs.mkdirSync(extDir, { recursive: true });

  // Extension with CLI + permission
  const napkinDir = path.join(extDir, "napkin");
  fs.mkdirSync(napkinDir, { recursive: true });
  fs.writeFileSync(
    path.join(napkinDir, "index.ts"),
    `export default function(m) {
			m.cli({ name: "napkin", install: "bun add -g napkin-ai" });
			m.permission({ defaultRoles: ["admin", "member"] });
		}`,
  );

  // Extension without CLI (job only)
  const distillDir = path.join(extDir, "kb-distill");
  fs.mkdirSync(distillDir, { recursive: true });
  fs.writeFileSync(
    path.join(distillDir, "index.ts"),
    `export default function(m) {
			m.job("run", { interval: 60000, run: async () => {} });
		}`,
  );

  registry = new ExtensionRegistry();
  const log = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  } as const;
  await registry.loadAll(extDir, db, log);

  const config = {
    port: 8787,
    admins: "admin1",
  } as AppConfig;

  app = createApiApp({
    db,
    config,
    containerRunner,
    queue: new SpaceQueue(2),
    scheduler,
    registry,
    configRegistry: new ConfigRegistry(),
  });
});

afterEach(() => {
  resetPermissions();
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── GET /ext ─────────────────────────────────────────────────────────────

describe("GET /ext", () => {
  test("lists all extensions", async () => {
    const res = await app.request("/ext", { headers: headers() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListExtensionsResponse;
    expect(body.extensions).toHaveLength(2);

    const names = body.extensions.map((e) => e.name).sort();
    expect(names).toEqual(["kb-distill", "napkin"]);
  });

  test("includes CLI and permission info", async () => {
    const res = await app.request("/ext", { headers: headers() });
    const body = (await res.json()) as ListExtensionsResponse;

    const napkin = body.extensions.find((e) => e.name === "napkin");
    expect(napkin.hasCli).toBe(true);
    expect(napkin.permission).toBe("napkin");

    const distill = body.extensions.find((e) => e.name === "kb-distill");
    expect(distill.hasCli).toBe(false);
    expect(distill.permission).toBeNull();
  });

  test("requires auth headers", async () => {
    const res = await app.request("/ext");
    expect(res.status).toBe(400);
  });
});

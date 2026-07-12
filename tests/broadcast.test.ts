import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Hono } from "hono";
import type { AppConfig } from "../src/config.js";
import { createApiApp, type Env } from "../src/core/api.js";
import { seededSpaces } from "../src/core/permissions.js";
import { SpaceQueue } from "../src/core/space-queue.js";
import { ConfigRegistry } from "../src/extensions/config-registry.js";
import { ExtensionRegistry } from "../src/extensions/loader.js";
import { Db } from "../src/storage/db.js";

let tmpDir: string;
let db: Db;
let config: AppConfig;
let app: Hono<Env>;

const containerRunner = {
  abortedSpaces: new Set<string>(),
  abort(spaceId: string): boolean {
    const wasRunning = this.abortedSpaces.has(spaceId);
    this.abortedSpaces.add(spaceId);
    return wasRunning;
  },
  reset() {
    this.abortedSpaces.clear();
  },
};

const scheduler = {
  async triggerTask(_taskId: number): Promise<void> {},
};

function createMockRuntime(overrides?: {
  broadcastResult?: {
    total: number;
    delivered: number;
    failed: number;
    errors: Array<{ spaceId: string; error: string }>;
  };
  broadcastError?: string;
}) {
  return {
    broadcastToAutoSpaces: async (_text: string) => {
      if (overrides?.broadcastError) {
        throw new Error(overrides.broadcastError);
      }
      return (
        overrides?.broadcastResult ?? {
          total: 0,
          delivered: 0,
          failed: 0,
          errors: [],
        }
      );
    },
  };
}

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
    "x-mercury-space": options.spaceId ?? "main",
  };

  const res = await app.request(pathname, {
    method,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const data = (await res.json()) as Record<string, unknown>;
  return { status: res.status, data };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-broadcast-test-"));
  db = new Db(path.join(tmpDir, "state.db"));
  seededSpaces.clear();

  config = {
    logLevel: "silent",
    logFormat: "text",
    modelProvider: "anthropic",
    model: "claude-opus-4-8",
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
    tsAllowLiveOrders: false,
    globalDir: path.join(tmpDir, "global"),
    spacesDir: path.join(tmpDir, "spaces"),
    whatsappAuthDir: path.join(tmpDir, "whatsapp"),
    dmAutoSpaceEnabled: true,
    dmAutoSpaceAdminIds: "972501234567",
    dmAutoSpaceDefaultSystemPrompt: "",
    dmAutoSpaceDefaultMemberPermissions: "prompt,prefs.get",
  } as AppConfig;
});

afterEach(async () => {
  db.close();
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
});

describe("POST /broadcast", () => {
  test("returns 403 for non-admin caller", async () => {
    app = createApiApp({
      db,
      config,
      containerRunner,
      queue: new SpaceQueue(2),
      scheduler,
      registry: new ExtensionRegistry(),
      configRegistry: new ConfigRegistry(),
      runtime: createMockRuntime() as never,
    });

    const { status, data } = await api("POST", "/broadcast", {
      callerId: "random-user",
      body: { text: "Hello everyone" },
    });

    expect(status).toBe(403);
    expect(data.error).toContain("admin");
  });

  test("returns 400 for missing text", async () => {
    app = createApiApp({
      db,
      config,
      containerRunner,
      queue: new SpaceQueue(2),
      scheduler,
      registry: new ExtensionRegistry(),
      configRegistry: new ConfigRegistry(),
      runtime: createMockRuntime() as never,
    });

    const { status, data } = await api("POST", "/broadcast", {
      callerId: "admin1",
      body: {},
    });

    expect(status).toBe(400);
    expect(data.error).toContain("text");
  });

  test("returns 400 for empty text", async () => {
    app = createApiApp({
      db,
      config,
      containerRunner,
      queue: new SpaceQueue(2),
      scheduler,
      registry: new ExtensionRegistry(),
      configRegistry: new ConfigRegistry(),
      runtime: createMockRuntime() as never,
    });

    const { status } = await api("POST", "/broadcast", {
      callerId: "admin1",
      body: { text: "   " },
    });

    expect(status).toBe(400);
  });

  test("returns 503 when dm_auto_space is disabled", async () => {
    config.dmAutoSpaceEnabled = false;

    app = createApiApp({
      db,
      config,
      containerRunner,
      queue: new SpaceQueue(2),
      scheduler,
      registry: new ExtensionRegistry(),
      configRegistry: new ConfigRegistry(),
      runtime: createMockRuntime() as never,
    });

    const { status, data } = await api("POST", "/broadcast", {
      callerId: "admin1",
      body: { text: "Hello" },
    });

    expect(status).toBe(503);
    expect(data.error).toContain("dm_auto_space");
  });

  test("returns 503 when runtime is not set", async () => {
    app = createApiApp({
      db,
      config,
      containerRunner,
      queue: new SpaceQueue(2),
      scheduler,
      registry: new ExtensionRegistry(),
      configRegistry: new ConfigRegistry(),
    });

    const { status } = await api("POST", "/broadcast", {
      callerId: "admin1",
      body: { text: "Hello" },
    });

    expect(status).toBe(503);
  });

  test("broadcasts to all dm- spaces and returns summary", async () => {
    app = createApiApp({
      db,
      config,
      containerRunner,
      queue: new SpaceQueue(2),
      scheduler,
      registry: new ExtensionRegistry(),
      configRegistry: new ConfigRegistry(),
      runtime: createMockRuntime({
        broadcastResult: {
          total: 3,
          delivered: 2,
          failed: 1,
          errors: [{ spaceId: "dm-555", error: "No bridge" }],
        },
      }) as never,
    });

    const { status, data } = await api("POST", "/broadcast", {
      callerId: "admin1",
      body: { text: "Maintenance tonight" },
    });

    expect(status).toBe(200);
    expect(data.total).toBe(3);
    expect(data.delivered).toBe(2);
    expect(data.failed).toBe(1);
    expect(data.errors).toBeArrayOfSize(1);
  });

  test("allows dmAutoSpaceAdminIds to broadcast", async () => {
    app = createApiApp({
      db,
      config,
      containerRunner,
      queue: new SpaceQueue(2),
      scheduler,
      registry: new ExtensionRegistry(),
      configRegistry: new ConfigRegistry(),
      runtime: createMockRuntime() as never,
    });

    const { status } = await api("POST", "/broadcast", {
      callerId: "whatsapp:972501234567",
      body: { text: "Hello" },
    });

    expect(status).toBe(200);
  });

  test("returns 409 when broadcast is already in progress", async () => {
    app = createApiApp({
      db,
      config,
      containerRunner,
      queue: new SpaceQueue(2),
      scheduler,
      registry: new ExtensionRegistry(),
      configRegistry: new ConfigRegistry(),
      runtime: createMockRuntime({
        broadcastError: "Broadcast already in progress",
      }) as never,
    });

    const { status, data } = await api("POST", "/broadcast", {
      callerId: "admin1",
      body: { text: "Hello" },
    });

    expect(status).toBe(409);
    expect(data.error).toContain("already in progress");
  });

  test("returns 400 for text exceeding 4096 chars", async () => {
    app = createApiApp({
      db,
      config,
      containerRunner,
      queue: new SpaceQueue(2),
      scheduler,
      registry: new ExtensionRegistry(),
      configRegistry: new ConfigRegistry(),
      runtime: createMockRuntime() as never,
    });

    const { status } = await api("POST", "/broadcast", {
      callerId: "admin1",
      body: { text: "x".repeat(4097) },
    });

    expect(status).toBe(400);
  });
});

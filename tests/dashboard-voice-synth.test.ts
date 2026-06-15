import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppConfig } from "../src/config.js";
import { createDashboardRoutes } from "../src/core/routes/dashboard.js";
import type { MercuryCoreRuntime } from "../src/core/runtime.js";
import { ConfigRegistry } from "../src/extensions/config-registry.js";
import { Db } from "../src/storage/db.js";

let tmpDir: string;
let db: Db;
let configRegistry: ConfigRegistry;
let app: ReturnType<typeof createDashboardRoutes>;

const minimalConfig = {
  triggerMatch: "mention",
  triggerPatterns: "@Pi,Pi",
} as unknown as AppConfig;

function registerVoiceSynthKeys(reg: ConfigRegistry): void {
  reg.register("voice-synth", "mode", {
    description: "TTS attachment mode",
    default: "on_demand",
    validate: (v) => v === "on_demand" || v === "auto",
  });
  reg.register("voice-synth", "auto", {
    description: "Legacy auto flag",
    default: "false",
    validate: (v) => v === "true" || v === "false",
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-dash-vsynth-"));
  db = new Db(path.join(tmpDir, "state.db"));
  db.createSpace("space-a", "Space A");
  configRegistry = new ConfigRegistry();
  registerVoiceSynthKeys(configRegistry);

  const core = {
    db,
    config: minimalConfig,
    queue: { pendingCount: 0 },
  } as unknown as MercuryCoreRuntime;

  app = createDashboardRoutes({
    core,
    adapters: {},
    startTime: 0,
    configRegistry,
    projectRoot: tmpDir,
    packageRoot: tmpDir,
  });
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("dashboard /api/voice-synth", () => {
  test("POST apply stores voice-synth.mode", async () => {
    const body = new URLSearchParams({
      spaceId: "space-a",
      intent: "apply",
      mode: "auto",
    });

    const res = await app.request("/api/voice-synth", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok?: boolean };
    expect(data.ok).toBe(true);
    expect(db.getSpaceConfig("space-a", "voice-synth.mode")).toBe("auto");
  });

  test("POST reset clears voice-synth.mode and voice-synth.auto", async () => {
    db.setSpaceConfig("space-a", "voice-synth.mode", "auto", "dashboard");
    db.setSpaceConfig("space-a", "voice-synth.auto", "true", "dashboard");

    const body = new URLSearchParams({
      spaceId: "space-a",
      intent: "reset",
    });

    const res = await app.request("/api/voice-synth", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    expect(res.status).toBe(200);
    expect(db.getSpaceConfig("space-a", "voice-synth.mode")).toBeNull();
    expect(db.getSpaceConfig("space-a", "voice-synth.auto")).toBeNull();
  });

  test("POST apply on_demand clears legacy voice-synth.auto", async () => {
    db.setSpaceConfig("space-a", "voice-synth.auto", "true", "dashboard");

    const body = new URLSearchParams({
      spaceId: "space-a",
      intent: "apply",
      mode: "on_demand",
    });

    const res = await app.request("/api/voice-synth", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    expect(res.status).toBe(200);
    expect(db.getSpaceConfig("space-a", "voice-synth.mode")).toBe("on_demand");
    expect(db.getSpaceConfig("space-a", "voice-synth.auto")).toBeNull();
  });

  test("POST apply invalid mode returns 400", async () => {
    const body = new URLSearchParams({
      spaceId: "space-a",
      intent: "apply",
      mode: "maybe",
    });

    const res = await app.request("/api/voice-synth", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    expect(res.status).toBe(400);
  });

  test("POST without configRegistry returns 400", async () => {
    const coreOnly = {
      db,
      config: minimalConfig,
      queue: { pendingCount: 0 },
    } as unknown as MercuryCoreRuntime;
    const bareApp = createDashboardRoutes({
      core: coreOnly,
      adapters: {},
      startTime: 0,
      projectRoot: tmpDir,
      packageRoot: tmpDir,
    });

    const body = new URLSearchParams({
      spaceId: "space-a",
      intent: "apply",
      mode: "auto",
    });

    const res = await bareApp.request("/api/voice-synth", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    expect(res.status).toBe(400);
  });

  test("space page includes voice-synth panel when extension keys registered", async () => {
    const res = await app.request("/page/spaces/space-a", {
      method: "GET",
      headers: { "HX-Request": "true" },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("/dashboard/api/voice-synth");
    expect(html).toContain("Voice synthesis");
  });
});

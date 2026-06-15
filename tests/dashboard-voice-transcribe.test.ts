import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDashboardRoutes } from "../src/core/routes/dashboard.js";
import type { MercuryCoreRuntime } from "../src/core/runtime.js";
import { ConfigRegistry } from "../src/extensions/config-registry.js";
import { Db } from "../src/storage/db.js";

let tmpDir: string;
let db: Db;
let configRegistry: ConfigRegistry;
let app: ReturnType<typeof createDashboardRoutes>;

function registerVoiceTranscribeKeys(reg: ConfigRegistry): void {
  reg.register("voice-transcribe", "provider", {
    description: "provider",
    default: "local",
    validate: (v) => v === "local" || v === "api",
  });
  reg.register("voice-transcribe", "model", {
    description: "model",
    default: "mike249/whisper-tiny-he-2",
  });
  reg.register("voice-transcribe", "local_engine", {
    description: "engine",
    default: "transformers",
    validate: (v) => v === "transformers" || v === "faster_whisper",
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-dash-voice-"));
  db = new Db(path.join(tmpDir, "state.db"));
  db.createSpace("space-a", "Space A");
  configRegistry = new ConfigRegistry();
  registerVoiceTranscribeKeys(configRegistry);

  const core = {
    db,
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

describe("dashboard /api/voice-transcribe", () => {
  test("POST apply preset stores triplet", async () => {
    const body = new URLSearchParams({
      spaceId: "space-a",
      intent: "apply",
      preset: "he_ivrit_fw",
      custom_model: "",
      custom_local_engine: "transformers",
      custom_provider: "local",
    });

    const res = await app.request("/api/voice-transcribe", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok?: boolean };
    expect(data.ok).toBe(true);

    expect(db.getSpaceConfig("space-a", "voice-transcribe.provider")).toBe(
      "local",
    );
    expect(db.getSpaceConfig("space-a", "voice-transcribe.local_engine")).toBe(
      "faster_whisper",
    );
    expect(db.getSpaceConfig("space-a", "voice-transcribe.model")).toBe(
      "ivrit-ai/faster-whisper-v2-d4",
    );
  });

  test("POST reset clears voice-transcribe keys", async () => {
    db.setSpaceConfig("space-a", "voice-transcribe.model", "x/y", "dashboard");
    db.setSpaceConfig(
      "space-a",
      "voice-transcribe.provider",
      "local",
      "dashboard",
    );
    db.setSpaceConfig(
      "space-a",
      "voice-transcribe.local_engine",
      "transformers",
      "dashboard",
    );

    const body = new URLSearchParams({
      spaceId: "space-a",
      intent: "reset",
    });

    const res = await app.request("/api/voice-transcribe", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    expect(res.status).toBe(200);
    expect(db.getSpaceConfig("space-a", "voice-transcribe.model")).toBeNull();
    expect(
      db.getSpaceConfig("space-a", "voice-transcribe.provider"),
    ).toBeNull();
    expect(
      db.getSpaceConfig("space-a", "voice-transcribe.local_engine"),
    ).toBeNull();
  });

  test("POST apply custom validates and stores", async () => {
    const body = new URLSearchParams({
      spaceId: "space-a",
      intent: "apply",
      preset: "custom",
      custom_model: "org/custom-model",
      custom_local_engine: "transformers",
      custom_provider: "local",
    });

    const res = await app.request("/api/voice-transcribe", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    expect(res.status).toBe(200);
    expect(db.getSpaceConfig("space-a", "voice-transcribe.model")).toBe(
      "org/custom-model",
    );
  });

  test("POST apply invalid preset returns 400", async () => {
    const body = new URLSearchParams({
      spaceId: "space-a",
      intent: "apply",
      preset: "not-a-real-preset",
    });

    const res = await app.request("/api/voice-transcribe", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    expect(res.status).toBe(400);
  });

  test("POST without configRegistry returns 400", async () => {
    const coreOnly = {
      db,
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
      preset: "he_tiny_tf",
    });

    const res = await bareApp.request("/api/voice-transcribe", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    expect(res.status).toBe(400);
  });
});

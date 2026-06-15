import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppConfig } from "../src/config.js";
import { createDashboardRoutes } from "../src/core/routes/dashboard.js";
import type { MercuryCoreRuntime } from "../src/core/runtime.js";
import { Db } from "../src/storage/db.js";

let tmpDir: string;
let db: Db;
let app: ReturnType<typeof createDashboardRoutes>;

const minimalConfig = {
  triggerMatch: "mention",
  triggerPatterns: "@Pi,Pi",
} as unknown as AppConfig;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-dash-scfg-"));
  db = new Db(path.join(tmpDir, "state.db"));
  db.createSpace("space-a", "Space A");

  const core = { db, config: minimalConfig } as unknown as MercuryCoreRuntime;
  app = createDashboardRoutes({
    core,
    adapters: {},
    startTime: 0,
    projectRoot: tmpDir,
    packageRoot: tmpDir,
  });
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("dashboard /api/space-config", () => {
  test("POST sets trigger.match", async () => {
    const body = new URLSearchParams({
      spaceId: "space-a",
      key: "trigger.match",
      value: "always",
    });
    const res = await app.request("/api/space-config", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok?: boolean };
    expect(data.ok).toBe(true);
    expect(db.getSpaceConfig("space-a", "trigger.match")).toBe("always");
  });

  test("POST rejects invalid trigger.match", async () => {
    const body = new URLSearchParams({
      spaceId: "space-a",
      key: "trigger.match",
      value: "nope",
    });
    const res = await app.request("/api/space-config", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    expect(res.status).toBe(400);
  });

  test("POST rejects unknown key", async () => {
    const body = new URLSearchParams({
      spaceId: "space-a",
      key: "ext.custom",
      value: "x",
    });
    const res = await app.request("/api/space-config", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    expect(res.status).toBe(400);
  });

  test("POST 404 when space missing", async () => {
    const body = new URLSearchParams({
      spaceId: "missing",
      key: "trigger.match",
      value: "always",
    });
    const res = await app.request("/api/space-config", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    expect(res.status).toBe(404);
  });

  test("DELETE clears override", async () => {
    db.setSpaceConfig("space-a", "trigger.match", "always", "test");
    const res = await app.request(
      `/api/space-config?spaceId=${encodeURIComponent("space-a")}&key=${encodeURIComponent("trigger.match")}`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(200);
    expect(db.getSpaceConfig("space-a", "trigger.match")).toBeNull();
  });

  test("DELETE 404 when key not set", async () => {
    const res = await app.request(
      `/api/space-config?spaceId=space-a&key=trigger.match`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(404);
  });

  test("DELETE rejects non-builtin key", async () => {
    const res = await app.request(
      `/api/space-config?spaceId=space-a&key=voice-transcribe.model`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(400);
  });
});

const htmxHeaders = { "HX-Request": "true" };

describe("dashboard space page triggers panel", () => {
  test("GET /page/spaces/:id includes Triggers & ambient", async () => {
    const res = await app.request(
      `/page/spaces/${encodeURIComponent("space-a")}`,
      { method: "GET", headers: htmxHeaders },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Triggers & ambient");
    expect(html).toContain("trigger.match");
    expect(html).toContain("/dashboard/api/space-config");
  });

  test("Config panel omits built-in keys from list", async () => {
    db.setSpaceConfig("space-a", "trigger.match", "always", "x");
    db.setSpaceConfig("space-a", "voice-transcribe.model", "m", "x");
    const res = await app.request(
      `/page/spaces/${encodeURIComponent("space-a")}`,
      { method: "GET", headers: htmxHeaders },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("voice-transcribe.model");
    // Built-in should only appear in triggers panel forms, not extension table row
    const extSection = html.split('panel-header">Config')[1] ?? "";
    expect(extSection).not.toContain("trigger.match");
  });
});

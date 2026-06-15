import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDashboardRoutes } from "../src/core/routes/dashboard.js";
import type { MercuryCoreRuntime } from "../src/core/runtime.js";
import { Db } from "../src/storage/db.js";

let tmpDir: string;
let db: Db;
let app: ReturnType<typeof createDashboardRoutes>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-dash-mutes-"));
  db = new Db(path.join(tmpDir, "state.db"));
  db.createSpace("space-a", "Space A");

  const core = { db } as unknown as MercuryCoreRuntime;
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

describe("dashboard /api/mutes", () => {
  test("DELETE removes mute", async () => {
    const exp = Date.now() + 60_000;
    db.muteUser("space-a", "user-1", exp, "agent", "spam");

    const res = await app.request(
      `/api/mutes?spaceId=${encodeURIComponent("space-a")}&platformUserId=${encodeURIComponent("user-1")}`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok?: boolean };
    expect(data.ok).toBe(true);
    expect(db.listMutes("space-a")).toHaveLength(0);
  });

  test("DELETE 404 when not muted", async () => {
    const res = await app.request(
      `/api/mutes?spaceId=space-a&platformUserId=nobody`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(404);
  });

  test("POST creates mute with dashboard as mutedBy", async () => {
    const body = new URLSearchParams({
      spaceId: "space-a",
      platformUserId: "tg-123",
      duration: "1h",
      reason: "manual",
    });

    const res = await app.request("/api/mutes", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      ok?: boolean;
      platformUserId?: string;
    };
    expect(data.ok).toBe(true);
    expect(data.platformUserId).toBe("tg-123");

    const mutes = db.listMutes("space-a");
    expect(mutes).toHaveLength(1);
    expect(mutes[0].platformUserId).toBe("tg-123");
    expect(mutes[0].mutedBy).toBe("dashboard");
    expect(mutes[0].reason).toBe("manual");
  });

  test("POST 404 for unknown space", async () => {
    const body = new URLSearchParams({
      spaceId: "missing",
      platformUserId: "u",
      duration: "10m",
    });
    const res = await app.request("/api/mutes", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    expect(res.status).toBe(404);
  });

  test("POST 400 for bad duration", async () => {
    const body = new URLSearchParams({
      spaceId: "space-a",
      platformUserId: "u",
      duration: "1w",
    });
    const res = await app.request("/api/mutes", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    expect(res.status).toBe(400);
  });
});

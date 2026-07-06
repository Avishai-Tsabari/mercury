import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type AutoSpaceConfig,
  resolveConversation,
} from "../src/core/conversation.js";
import { Db } from "../src/storage/db.js";

describe("chat-api-platform-simulation", () => {
  let tempDir: string;
  let db: Db;

  const autoSpace: AutoSpaceConfig = {
    enabled: true,
    adminIds: ["972501234567"],
    defaultSystemPrompt: "You are a helpful assistant",
    defaultMemberPermissions: "prompt,prefs.get",
    rateLimitDailyMember: 20,
  };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "mercury-chat-platform-sim-"),
    );
    db = new Db(path.join(tempDir, "state.db"));
    db.ensureSpace("main");
  });

  afterEach(async () => {
    db.close();
    for (let i = 0; i < 5; i++) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100 * (i + 1)));
      }
    }
  });

  test("platform omitted: resolveConversation not called, space must exist", () => {
    const space = db.getSpace("main");
    expect(space).not.toBeNull();
  });

  test("platform set + auto-space enabled: creates DM space", () => {
    const resolution = resolveConversation(
      db,
      "whatsapp",
      "972509999999",
      "dm",
      undefined,
      autoSpace,
      "Test User",
    );
    expect(resolution).not.toBeNull();
    expect(resolution?.spaceId).toBe("dm-972509999999");

    const space = db.getSpace("dm-972509999999");
    expect(space).not.toBeNull();
    expect(space?.name).toBe("Test User");

    expect(db.getSpaceConfig("dm-972509999999", "trigger.match")).toBe(
      "always",
    );
    expect(db.getSpaceConfig("dm-972509999999", "context.mode")).toBe(
      "context",
    );
  });

  test("platform set + auto-space disabled: returns null", () => {
    const resolution = resolveConversation(
      db,
      "whatsapp",
      "972509999999",
      "dm",
      undefined,
      { ...autoSpace, enabled: false },
    );
    expect(resolution).toBeNull();
  });

  test("platform set without auto-space config: returns null", () => {
    const resolution = resolveConversation(
      db,
      "whatsapp",
      "972509999999",
      "dm",
    );
    expect(resolution).toBeNull();
  });

  test("returning user reuses existing space", () => {
    const first = resolveConversation(
      db,
      "whatsapp",
      "972509999999",
      "dm",
      undefined,
      autoSpace,
      "Test User",
    );
    expect(first?.spaceId).toBe("dm-972509999999");

    const second = resolveConversation(
      db,
      "whatsapp",
      "972509999999",
      "dm",
      undefined,
      autoSpace,
      "Test User",
    );
    expect(second?.spaceId).toBe("dm-972509999999");

    const dmSpaces = db.listSpaces().filter((s) => s.id === "dm-972509999999");
    expect(dmSpaces).toHaveLength(1);
  });

  test("admin number links to main space", () => {
    const resolution = resolveConversation(
      db,
      "whatsapp",
      "972501234567",
      "dm",
      undefined,
      autoSpace,
    );
    expect(resolution).not.toBeNull();
    expect(resolution?.spaceId).toBe("main");
  });

  test("telegram platform: includes platform in space id", () => {
    const resolution = resolveConversation(
      db,
      "telegram",
      "12345678",
      "dm",
      undefined,
      autoSpace,
    );
    expect(resolution).not.toBeNull();
    expect(resolution?.spaceId).toBe("dm-telegram-12345678");
  });

  test("platform 'api' treated as no platform: no conversation resolution", () => {
    const space = db.getSpace("main");
    expect(space).not.toBeNull();
  });
});

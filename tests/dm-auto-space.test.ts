import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type AutoSpaceConfig,
  resolveConversation,
} from "../src/core/conversation.js";
import { Db } from "../src/storage/db.js";

describe("dm-auto-space", () => {
  let tempDir: string;
  let db: Db;

  const autoSpace: AutoSpaceConfig = {
    enabled: true,
    adminNumbers: ["972501234567"],
    defaultSystemPrompt: "You are a barber shop assistant",
    defaultMemberPermissions: "prompt,prefs.get",
    rateLimitDailyMember: 20,
  };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-auto-space-"));
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

  test("disabled: returns null for unlinked DM", () => {
    const result = resolveConversation(
      db,
      "whatsapp",
      "972509999999@s.whatsapp.net",
      "dm",
    );
    expect(result).toBeNull();
  });

  test("disabled explicitly: returns null", () => {
    const result = resolveConversation(
      db,
      "whatsapp",
      "972509999999@s.whatsapp.net",
      "dm",
      undefined,
      { ...autoSpace, enabled: false },
    );
    expect(result).toBeNull();
  });

  test("enabled: creates space and links for new customer DM", () => {
    const result = resolveConversation(
      db,
      "whatsapp",
      "972509999999@s.whatsapp.net",
      "dm",
      undefined,
      autoSpace,
      "Moshe",
    );
    expect(result).not.toBeNull();
    expect(result?.spaceId).toBe("dm-972509999999");

    const space = db.getSpace("dm-972509999999");
    expect(space).not.toBeNull();
    expect(space?.name).toBe("Moshe");
  });

  test("enabled: seeds space config on creation", () => {
    resolveConversation(
      db,
      "whatsapp",
      "972509999999@s.whatsapp.net",
      "dm",
      undefined,
      autoSpace,
    );

    expect(db.getSpaceConfig("dm-972509999999", "trigger.match")).toBe(
      "always",
    );
    expect(db.getSpaceConfig("dm-972509999999", "context.mode")).toBe(
      "context",
    );
    expect(
      db.getSpaceConfig("dm-972509999999", "role.member.permissions"),
    ).toBe("prompt,prefs.get");
    expect(db.getSpaceConfig("dm-972509999999", "system_prompt")).toBe(
      "You are a barber shop assistant",
    );
    expect(db.getSpaceConfig("dm-972509999999", "rate_limit.member")).toBe(
      "20",
    );
  });

  test("enabled: does not overwrite existing space config", () => {
    db.ensureSpace("dm-972509999999");
    db.setSpaceConfig("dm-972509999999", "trigger.match", "mention", "manual");

    resolveConversation(
      db,
      "whatsapp",
      "972509999999@s.whatsapp.net",
      "dm",
      undefined,
      autoSpace,
    );

    expect(db.getSpaceConfig("dm-972509999999", "trigger.match")).toBe(
      "mention",
    );
  });

  test("admin number: links to main space", () => {
    const result = resolveConversation(
      db,
      "whatsapp",
      "972501234567@s.whatsapp.net",
      "dm",
      undefined,
      autoSpace,
    );
    expect(result).not.toBeNull();
    expect(result?.spaceId).toBe("main");
  });

  test("admin number with + prefix: normalized and matched", () => {
    const config = { ...autoSpace, adminNumbers: ["+972501234567"] };
    const result = resolveConversation(
      db,
      "whatsapp",
      "972501234567@s.whatsapp.net",
      "dm",
      undefined,
      config,
    );
    expect(result).not.toBeNull();
    expect(result?.spaceId).toBe("main");
  });

  test("returning customer: reuses existing space", () => {
    const first = resolveConversation(
      db,
      "whatsapp",
      "972509999999@s.whatsapp.net",
      "dm",
      undefined,
      autoSpace,
      "Moshe",
    );
    expect(first?.spaceId).toBe("dm-972509999999");

    const second = resolveConversation(
      db,
      "whatsapp",
      "972509999999@s.whatsapp.net",
      "dm",
      undefined,
      autoSpace,
      "Moshe",
    );
    expect(second?.spaceId).toBe("dm-972509999999");

    const spaces = db.listSpaces();
    const dmSpaces = spaces.filter((s) => s.id === "dm-972509999999");
    expect(dmSpaces).toHaveLength(1);
  });

  test("group conversations: ignored even when enabled", () => {
    const result = resolveConversation(
      db,
      "whatsapp",
      "120363012345678@g.us",
      "group",
      undefined,
      autoSpace,
    );
    expect(result).toBeNull();
  });

  test("no push name: falls back to phone number", () => {
    resolveConversation(
      db,
      "whatsapp",
      "972509999999@s.whatsapp.net",
      "dm",
      undefined,
      autoSpace,
    );

    const space = db.getSpace("dm-972509999999");
    expect(space).not.toBeNull();
    expect(space?.name).toBe("972509999999");
  });

  test("non-whatsapp platform: includes platform in space id", () => {
    const result = resolveConversation(
      db,
      "telegram",
      "12345678",
      "dm",
      undefined,
      autoSpace,
    );
    expect(result).not.toBeNull();
    expect(result?.spaceId).toBe("dm-telegram-12345678");
  });

  test("no system prompt: does not seed system_prompt key", () => {
    const config = { ...autoSpace, defaultSystemPrompt: "" };
    resolveConversation(
      db,
      "whatsapp",
      "972509999999@s.whatsapp.net",
      "dm",
      undefined,
      config,
    );
    expect(db.getSpaceConfig("dm-972509999999", "system_prompt")).toBeNull();
  });

  test("rate limit 0: does not seed rate_limit.member key", () => {
    const config = { ...autoSpace, rateLimitDailyMember: 0 };
    resolveConversation(
      db,
      "whatsapp",
      "972509999999@s.whatsapp.net",
      "dm",
      undefined,
      config,
    );
    expect(
      db.getSpaceConfig("dm-972509999999", "rate_limit.member"),
    ).toBeNull();
  });
});

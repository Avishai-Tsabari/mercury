import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  inferConversationKind,
  resolveConversation,
} from "../src/core/conversation.js";
import { Db } from "../src/storage/db.js";

let tmpDir: string;
let db: Db;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-conversation-test-"));
  db = new Db(path.join(tmpDir, "state.db"));
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("resolveConversation", () => {
  test("first contact creates unlinked conversation and returns null", () => {
    const result = resolveConversation(db, "whatsapp", "chat-1", "group");
    expect(result).toBeNull();

    const convo = db.findConversation("whatsapp", "chat-1");
    expect(convo).not.toBeNull();
    expect(convo?.spaceId).toBeNull();
    expect(convo?.kind).toBe("group");
  });

  test("returns linked space when conversation is linked", () => {
    db.createSpace("family", "Family");
    const convo = db.ensureConversation("whatsapp", "chat-1", "group");
    db.linkConversation(convo.id, "family");

    const result = resolveConversation(db, "whatsapp", "chat-1", "group");
    expect(result).not.toBeNull();
    expect(result?.spaceId).toBe("family");
    expect(result?.conversation.id).toBe(convo.id);
  });

  test("updates observed title on subsequent contacts", () => {
    db.ensureConversation("discord", "guild:channel", "channel");
    const result = resolveConversation(
      db,
      "discord",
      "guild:channel",
      "channel",
      "General",
    );
    expect(result).toBeNull();

    const convo = db.findConversation("discord", "guild:channel");
    expect(convo?.observedTitle).toBe("General");
  });

  test("updates lastSeenAt on subsequent contacts", async () => {
    db.ensureConversation("slack", "C123", "channel");
    const before = db.findConversation("slack", "C123");
    expect(before).not.toBeNull();

    await new Promise((r) => setTimeout(r, 5));
    resolveConversation(db, "slack", "C123", "channel");

    const after = db.findConversation("slack", "C123");
    expect(after?.lastSeenAt).toBeGreaterThan(before?.lastSeenAt);
  });
});

describe("inferConversationKind", () => {
  test("returns dm when isDM is true", () => {
    expect(inferConversationKind("whatsapp", "anything", true)).toBe("dm");
  });

  test("maps whatsapp non-DM to group", () => {
    expect(inferConversationKind("whatsapp", "123@g.us:123@g.us", false)).toBe(
      "group",
    );
  });

  test("maps discord with colon externalId to thread", () => {
    expect(inferConversationKind("discord", "guild:channel", false)).toBe(
      "thread",
    );
  });

  test("maps slack non-DM to channel", () => {
    expect(inferConversationKind("slack", "C123", false)).toBe("channel");
  });
});

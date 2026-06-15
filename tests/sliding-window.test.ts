import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "../src/storage/db.js";

describe("getRecentTurns", () => {
  let tempDir: string;
  let db: Db;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-sw-"));
    db = new Db(path.join(tempDir, "state.db"));
    db.ensureSpace("space1");
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test("returns empty array when no messages exist", () => {
    const turns = db.getRecentTurns("space1");
    expect(turns).toEqual([]);
  });

  test("returns all messages when fewer than turnCount user messages", () => {
    db.addMessage("space1", "user", "hello");
    db.addMessage("space1", "assistant", "hi there");

    const turns = db.getRecentTurns("space1", 10);
    expect(turns.length).toBe(2);
    expect(turns[0].role).toBe("user");
    expect(turns[1].role).toBe("assistant");
  });

  test("returns messages in ascending chronological order", () => {
    db.addMessage("space1", "user", "first");
    db.addMessage("space1", "assistant", "reply1");
    db.addMessage("space1", "user", "second");
    db.addMessage("space1", "assistant", "reply2");

    const turns = db.getRecentTurns("space1", 10);
    const contents = turns.map((m) => m.content);
    expect(contents).toEqual(["first", "reply1", "second", "reply2"]);
  });

  test("limits to N most recent user turns", () => {
    // Add 5 turns
    for (let i = 1; i <= 5; i++) {
      db.addMessage("space1", "user", `user message ${i}`);
      db.addMessage("space1", "assistant", `assistant reply ${i}`);
    }

    const turns = db.getRecentTurns("space1", 2);
    const userMessages = turns.filter((m) => m.role === "user");
    expect(userMessages.length).toBe(2);
    // Should be the 2 most recent user messages
    expect(userMessages[0].content).toBe("user message 4");
    expect(userMessages[1].content).toBe("user message 5");
  });

  test("respects session boundary — excludes messages before boundary", () => {
    // Add messages before compact
    db.addMessage("space1", "user", "old message 1");
    db.addMessage("space1", "assistant", "old reply 1");

    // Compact sets boundary to latest message
    db.setSessionBoundaryToLatest("space1");

    // Add messages after compact
    db.addMessage("space1", "user", "new message 1");
    db.addMessage("space1", "assistant", "new reply 1");

    const turns = db.getRecentTurns("space1", 10);
    const contents = turns.map((m) => m.content);

    // Old messages should be excluded
    expect(contents).not.toContain("old message 1");
    expect(contents).not.toContain("old reply 1");
    // New messages should be included
    expect(contents).toContain("new message 1");
    expect(contents).toContain("new reply 1");
  });

  test("includes ambient (assistant-only) messages within the window", () => {
    db.addMessage("space1", "user", "user turn");
    db.addMessage("space1", "assistant", "assistant reply");
    db.addMessage("space1", "assistant", "ambient follow-up");

    const turns = db.getRecentTurns("space1", 10);
    const contents = turns.map((m) => m.content);
    expect(contents).toContain("ambient follow-up");
  });

  test("partial turn (user without assistant reply) is included", () => {
    db.addMessage("space1", "user", "turn 1 user");
    db.addMessage("space1", "assistant", "turn 1 assistant");
    db.addMessage("space1", "user", "turn 2 user — no reply yet");

    const turns = db.getRecentTurns("space1", 10);
    const contents = turns.map((m) => m.content);
    expect(contents).toContain("turn 2 user — no reply yet");
  });

  test("isolated spaces do not share messages", () => {
    db.ensureSpace("space2");
    db.addMessage("space1", "user", "space1 message");
    db.addMessage("space2", "user", "space2 message");

    const turns1 = db.getRecentTurns("space1", 10);
    const turns2 = db.getRecentTurns("space2", 10);

    expect(turns1.map((m) => m.content)).toContain("space1 message");
    expect(turns1.map((m) => m.content)).not.toContain("space2 message");
    expect(turns2.map((m) => m.content)).toContain("space2 message");
    expect(turns2.map((m) => m.content)).not.toContain("space1 message");
  });
});

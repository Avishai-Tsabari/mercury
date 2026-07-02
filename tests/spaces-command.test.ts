import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MercuryCoreRuntime } from "../src/core/runtime.js";

describe("Spaces command", () => {
  let tempDir: string;
  let runtime: MercuryCoreRuntime;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-spaces-test-"));

    runtime = new MercuryCoreRuntime({
      modelProvider: "anthropic",
      model: "claude-opus-4-8",
      triggerPatterns: "@Pi,Pi",
      triggerMatch: "mention",
      dataDir: tempDir,
      authPath: undefined,
      agentContainerImage: "test",
      containerTimeoutMs: 60000,
      maxConcurrency: 2,
      rateLimitPerUser: 0,
      rateLimitWindowMs: 60000,
      port: 8787,
      botUsername: "mercury",
      discordGatewayDurationMs: 600000,
      discordGatewaySecret: undefined,
      enableWhatsApp: false,
      admins: "admin1",
      dbPath: path.join(tempDir, "state.db"),
      globalDir: path.join(tempDir, "global"),
      spacesDir: path.join(tempDir, "spaces"),
      whatsappAuthDir: path.join(tempDir, "whatsapp-auth"),
    });

    runtime.containerRunner.reply = mock(async () => ({
      reply: "mocked reply",
      files: [],
    }));

    runtime.db.ensureSpace("test-group");
    runtime.db.setRole("test-group", "admin1", "admin", "test");
  });

  afterEach(() => {
    runtime.rateLimiter.stopCleanup();
    runtime.db.close();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Windows: EBUSY on SQLite WAL cleanup — safe to ignore in tests
    }
  });

  function cmd(text: string, overrides: Record<string, unknown> = {}) {
    return runtime.handleRawInput(
      {
        platform: "whatsapp",
        spaceId: "main",
        conversationExternalId: "conv1",
        text,
        callerId: "admin1",
        isDM: true,
        isReplyToBot: false,
        attachments: [],
        ...overrides,
      },
      "chat-sdk",
    );
  }

  test("/spaces returns help text", async () => {
    const r = await cmd("/spaces");
    expect(r.type).toBe("command");
    expect(r.result?.reply).toContain("/spaces list");
    expect(r.result?.reply).toContain("/spaces create");
  });

  test("/spaces list returns formatted list", async () => {
    runtime.db.createSpace("work", "Work Stuff");
    const r = await cmd("/spaces list");
    expect(r.type).toBe("command");
    expect(r.result?.reply).toContain("main");
    expect(r.result?.reply).toContain("work");
    expect(r.result?.reply).toContain("Work Stuff");
  });

  test("/spaces create valid-id Name succeeds", async () => {
    const r = await cmd("/spaces create test-space My Test Space");
    expect(r.type).toBe("command");
    expect(r.result?.reply).toContain("Created space 'test-space'");
    expect(r.result?.reply).toContain("My Test Space");
    const space = runtime.db.getSpace("test-space");
    expect(space).not.toBeNull();
    expect(space?.name).toBe("My Test Space");
  });

  test("/spaces create without name returns usage", async () => {
    const r = await cmd("/spaces create myid");
    expect(r.type).toBe("command");
    expect(r.result?.reply).toContain("Usage:");
  });

  test("/spaces create INVALID fails (uppercase)", async () => {
    const r = await cmd("/spaces create INVALID Bad Name");
    expect(r.type).toBe("command");
    expect(r.result?.reply).toContain("Invalid space id");
  });

  test("/spaces create main fails (already exists)", async () => {
    const r = await cmd("/spaces create main Dupe");
    expect(r.type).toBe("command");
    expect(r.result?.reply).toContain("already exists");
  });

  test("/spaces switch relinks conversation", async () => {
    runtime.db.createSpace("target", "Target Space");
    const convo = runtime.db.ensureConversation("whatsapp", "conv1", "dm");
    runtime.db.linkConversation(convo.id, "main");

    const r = await cmd("/spaces switch target");
    expect(r.type).toBe("command");
    expect(r.result?.reply).toContain("Switched to space 'Target Space'");

    const updated = runtime.db.findConversation("whatsapp", "conv1");
    expect(updated?.spaceId).toBe("target");
  });

  test("/spaces switch nonexistent returns error", async () => {
    const r = await cmd("/spaces switch nonexistent");
    expect(r.type).toBe("command");
    expect(r.result?.reply).toContain("not found");
  });

  test("/spaces switch to current space returns already-in message", async () => {
    const convo = runtime.db.ensureConversation("whatsapp", "conv1", "dm");
    runtime.db.linkConversation(convo.id, "main");

    const r = await cmd("/spaces switch main");
    expect(r.type).toBe("command");
    expect(r.result?.reply).toContain("Already in space");
  });

  test("/spaces delete main is blocked", async () => {
    const r = await cmd("/spaces delete main");
    expect(r.type).toBe("command");
    expect(r.result?.reply).toContain("Cannot delete");
  });

  test("/spaces delete → yes → deleted", async () => {
    runtime.db.createSpace("temp", "Temp Space");

    const r1 = await cmd("/spaces delete temp");
    expect(r1.result?.reply).toContain("Reply *yes* to confirm");

    const r2 = await cmd("yes");
    expect(r2.result?.reply).toContain("Deleted space 'temp'");
    expect(runtime.db.getSpace("temp")).toBeNull();
  });

  test("/spaces delete → no → cancelled", async () => {
    runtime.db.createSpace("temp", "Temp Space");

    await cmd("/spaces delete temp");
    const r2 = await cmd("no");
    expect(r2.result?.reply).toContain("Delete cancelled");
    expect(runtime.db.getSpace("temp")).not.toBeNull();
  });

  test("/spaces delete → other message → pending cleared and message proceeds", async () => {
    runtime.db.createSpace("temp", "Temp Space");
    const convo = runtime.db.ensureConversation("whatsapp", "conv1", "dm");
    runtime.db.linkConversation(convo.id, "main");

    await cmd("/spaces delete temp");

    const r2 = await cmd("hello there");
    expect(r2.type).toBe("assistant");
    expect(runtime.db.getSpace("temp")).not.toBeNull();
  });

  test("/spaces unlink unlinks current conversation", async () => {
    const convo = runtime.db.ensureConversation("whatsapp", "conv1", "dm");
    runtime.db.linkConversation(convo.id, "main");

    const r = await cmd("/spaces unlink");
    expect(r.type).toBe("command");
    expect(r.result?.reply).toContain("Unlinked");

    const updated = runtime.db.findConversation("whatsapp", "conv1");
    expect(updated?.spaceId).toBeNull();
  });

  test("non-seeded admin gets permission denied", async () => {
    runtime.db.setRole("main", "user2", "admin", "test");
    const r = await cmd("/spaces list", {
      callerId: "user2",
      isDM: true,
    });
    expect(r.type).toBe("denied");
    expect((r as { reason: string }).reason).toContain("don't have permission");
  });
});

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MercuryCoreRuntime } from "../src/core/runtime.js";

function makeMsg(
  text: string,
  overrides?: Partial<Parameters<MercuryCoreRuntime["handleRawInput"]>[0]>,
) {
  return {
    platform: "test",
    spaceId: "test-group",
    text,
    callerId: "admin1",
    isDM: true,
    isReplyToBot: false,
    attachments: [] as never[],
    hadIncomingAttachments: false,
    conversationExternalId: "conv1",
    authorName: "Admin",
    ...overrides,
  };
}

describe("Pause/Resume", () => {
  let tempDir: string;
  let runtime: MercuryCoreRuntime;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-pause-test-"));

    runtime = new MercuryCoreRuntime({
      modelProvider: "anthropic",
      model: "claude-sonnet-4-20250514",
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
      admins: "",
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
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test("/pause sets config key", async () => {
    const result = await runtime.handleRawInput(makeMsg("/pause"), "chat-sdk");
    expect(result.type).toBe("command");
    expect(result.result?.reply).toContain("Bot paused");
    expect(runtime.db.getSpaceConfig("test-group", "paused")).toBe("true");
  });

  test("/resume clears config key", async () => {
    runtime.db.setSpaceConfig("test-group", "paused", "true", "admin1");
    const result = await runtime.handleRawInput(makeMsg("/resume"), "chat-sdk");
    expect(result.type).toBe("command");
    expect(result.result?.reply).toBe("Bot resumed.");
    expect(runtime.db.getSpaceConfig("test-group", "paused")).toBeNull();
  });

  test("messages are ignored while paused", async () => {
    runtime.db.setSpaceConfig("test-group", "paused", "true", "admin1");
    const result = await runtime.handleRawInput(makeMsg("hello"), "chat-sdk");
    expect(result.type).toBe("ignore");
    expect(runtime.containerRunner.reply).not.toHaveBeenCalled();
  });

  test("/resume works while paused", async () => {
    runtime.db.setSpaceConfig("test-group", "paused", "true", "admin1");
    const result = await runtime.handleRawInput(makeMsg("/resume"), "chat-sdk");
    expect(result.type).toBe("command");
    expect(result.result?.reply).toBe("Bot resumed.");
  });

  test("/pause works while paused (re-pause)", async () => {
    runtime.db.setSpaceConfig("test-group", "paused", "true", "admin1");
    const result = await runtime.handleRawInput(makeMsg("/pause"), "chat-sdk");
    expect(result.type).toBe("command");
    expect(result.result?.reply).toBe("Already paused.");
  });

  test("/pause with timer then /pause without timer clears timer", async () => {
    runtime.db.setSpaceConfig("test-group", "paused", "true", "admin1");
    runtime.db.setSpaceConfig(
      "test-group",
      "paused.resume_at",
      String(Date.now() + 60000),
      "admin1",
    );
    const result = await runtime.handleRawInput(makeMsg("/pause"), "chat-sdk");
    expect(result.result?.reply).toContain("indefinite");
    expect(
      runtime.db.getSpaceConfig("test-group", "paused.resume_at"),
    ).toBeNull();
  });

  test("/resume when not paused returns idempotent message", async () => {
    const result = await runtime.handleRawInput(makeMsg("/resume"), "chat-sdk");
    expect(result.result?.reply).toBe("Bot is not paused.");
  });

  test("/pause 30m sets duration", async () => {
    const result = await runtime.handleRawInput(
      makeMsg("/pause 30m"),
      "chat-sdk",
    );
    expect(result.type).toBe("command");
    expect(result.result?.reply).toContain("paused for 30m");
    expect(runtime.db.getSpaceConfig("test-group", "paused")).toBe("true");
    const resumeAt = runtime.db.getSpaceConfig(
      "test-group",
      "paused.resume_at",
    );
    expect(resumeAt).toBeTruthy();
    const epoch = Number.parseInt(resumeAt ?? "0", 10);
    expect(epoch).toBeGreaterThan(Date.now());
    expect(epoch).toBeLessThanOrEqual(Date.now() + 30 * 60 * 1000 + 1000);
  });

  test("/pause rejects invalid duration", async () => {
    const result = await runtime.handleRawInput(
      makeMsg("/pause abc"),
      "chat-sdk",
    );
    expect(result.result?.reply).toContain("Invalid duration");
  });

  test("/pause rejects duration over 24h", async () => {
    const result = await runtime.handleRawInput(
      makeMsg("/pause 25h"),
      "chat-sdk",
    );
    expect(result.result?.reply).toContain("at most 24 hours");
  });

  test("/pause rejects 0m duration", async () => {
    const result = await runtime.handleRawInput(
      makeMsg("/pause 0m"),
      "chat-sdk",
    );
    expect(result.result?.reply).toContain("at least 1 minute");
  });

  test("other slash commands are blocked while paused", async () => {
    runtime.db.setSpaceConfig("test-group", "paused", "true", "admin1");
    const result = await runtime.handleRawInput(makeMsg("/help"), "chat-sdk");
    expect(result.type).toBe("ignore");
  });

  test("auto-resume on startup with past deadline", async () => {
    runtime.db.setSpaceConfig("test-group", "paused", "true", "admin1");
    runtime.db.setSpaceConfig(
      "test-group",
      "paused.resume_at",
      String(Date.now() - 1000),
      "admin1",
    );

    runtime.startScheduler();

    expect(runtime.db.getSpaceConfig("test-group", "paused")).toBeNull();
    expect(
      runtime.db.getSpaceConfig("test-group", "paused.resume_at"),
    ).toBeNull();

    runtime.stopScheduler();
  });

  test("auto-resume on startup with future deadline schedules timer", async () => {
    runtime.db.setSpaceConfig("test-group", "paused", "true", "admin1");
    runtime.db.setSpaceConfig(
      "test-group",
      "paused.resume_at",
      String(Date.now() + 60_000),
      "admin1",
    );

    runtime.startScheduler();

    // Still paused — timer hasn't fired yet
    expect(runtime.db.getSpaceConfig("test-group", "paused")).toBe("true");

    runtime.stopScheduler();
  });
});

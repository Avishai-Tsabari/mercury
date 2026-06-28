import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { seededSpaces } from "../src/core/permissions.js";
import { MercuryCoreRuntime } from "../src/core/runtime.js";

function createRuntime(tempDir: string, overrides?: Record<string, unknown>) {
  return new MercuryCoreRuntime({
    modelProvider: "anthropic",
    model: "claude-sonnet-4-20250514",
    triggerPatterns: "@Pi,Pi",
    triggerMatch: "mention",
    dataDir: tempDir,
    authPath: undefined,
    agentContainerImage: "test",
    containerTimeoutMs: 60000,
    maxConcurrency: 2,
    rateLimitPerUser: 3,
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
    ...overrides,
  });
}

describe("Runtime rate limiting", () => {
  let tempDir: string;
  let runtime: MercuryCoreRuntime;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-rate-test-"));
    seededSpaces.clear();

    runtime = createRuntime(tempDir);

    // Mock the container runner to avoid actual container execution
    runtime.containerRunner.reply = mock(async () => ({
      reply: "mocked reply",
      files: [],
    }));
  });

  afterEach(() => {
    runtime.rateLimiter.stopCleanup();
    runtime.db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test("allows requests under rate limit", async () => {
    const message = {
      platform: "test",
      spaceId: "test-group",
      text: "@Pi hello",
      callerId: "user1",
      isDM: false,
      isReplyToBot: false,
      attachments: [],
    };

    // Should allow 3 requests
    const r1 = await runtime.handleRawInput(message, "chat-sdk");
    expect(r1.type).toBe("assistant");

    const r2 = await runtime.handleRawInput(message, "chat-sdk");
    expect(r2.type).toBe("assistant");

    const r3 = await runtime.handleRawInput(message, "chat-sdk");
    expect(r3.type).toBe("assistant");
  });

  test("blocks requests over rate limit", async () => {
    const message = {
      platform: "test",
      spaceId: "test-group",
      text: "@Pi hello",
      callerId: "user1",
      isDM: false,
      isReplyToBot: false,
      attachments: [],
    };

    // Use up the limit
    await runtime.handleRawInput(message, "chat-sdk");
    await runtime.handleRawInput(message, "chat-sdk");
    await runtime.handleRawInput(message, "chat-sdk");

    // Fourth request should be denied
    const r4 = await runtime.handleRawInput(message, "chat-sdk");
    expect(r4.type).toBe("denied");
    expect(r4.reason).toBe("Rate limit exceeded. Try again shortly.");
  });

  test("different users have separate rate limits", async () => {
    const user1Message = {
      platform: "test",
      spaceId: "test-group",
      text: "@Pi hello",
      callerId: "user1",
      isDM: false,
      isReplyToBot: false,
      attachments: [],
    };

    const user2Message = {
      platform: "test",
      spaceId: "test-group",
      text: "@Pi hello",
      callerId: "user2",
      isDM: false,
      isReplyToBot: false,
      attachments: [],
    };

    // Use up user1's limit
    await runtime.handleRawInput(user1Message, "chat-sdk");
    await runtime.handleRawInput(user1Message, "chat-sdk");
    await runtime.handleRawInput(user1Message, "chat-sdk");

    const r4 = await runtime.handleRawInput(user1Message, "chat-sdk");
    expect(r4.type).toBe("denied");

    // user2 should still be allowed
    const r5 = await runtime.handleRawInput(user2Message, "chat-sdk");
    expect(r5.type).toBe("assistant");
  });

  test("commands bypass rate limit", async () => {
    // Seed admin so stop command is allowed
    runtime.db.ensureSpace("test-group");
    runtime.db.setRole("test-group", "admin1", "admin", "test");

    const promptMessage = {
      platform: "test",
      spaceId: "test-group",
      text: "@Pi hello",
      callerId: "admin1",
      isDM: false,
      isReplyToBot: false,
      attachments: [],
    };

    const stopMessage = {
      platform: "test",
      spaceId: "test-group",
      text: "@Pi stop",
      callerId: "admin1",
      isDM: false,
      isReplyToBot: false,
      attachments: [],
    };

    // Use up the limit with prompts
    await runtime.handleRawInput(promptMessage, "chat-sdk");
    await runtime.handleRawInput(promptMessage, "chat-sdk");
    await runtime.handleRawInput(promptMessage, "chat-sdk");

    // Next prompt should be rate limited
    const r4 = await runtime.handleRawInput(promptMessage, "chat-sdk");
    expect(r4.type).toBe("denied");

    // But stop command should still work
    const stopResult = await runtime.handleRawInput(stopMessage, "chat-sdk");
    expect(stopResult.type).toBe("command");
  });

  test("per-group rate limit override", async () => {
    const message = {
      platform: "test",
      spaceId: "limited-group",
      text: "@Pi hello",
      callerId: "user1",
      isDM: false,
      isReplyToBot: false,
      attachments: [],
    };

    // Set a lower limit for this group
    runtime.db.ensureSpace("limited-group");
    runtime.db.setSpaceConfig("limited-group", "rate_limit", "1", "test");

    // First request should be allowed
    const r1 = await runtime.handleRawInput(message, "chat-sdk");
    expect(r1.type).toBe("assistant");

    // Second request should be denied (limit is 1)
    const r2 = await runtime.handleRawInput(message, "chat-sdk");
    expect(r2.type).toBe("denied");
    expect(r2.reason).toBe("Rate limit exceeded. Try again shortly.");
  });

  test("ignored messages don't count toward rate limit", async () => {
    const ignoredMessage = {
      platform: "test",
      spaceId: "test-group",
      text: "just a regular message without trigger",
      callerId: "user1",
      isDM: false,
      isReplyToBot: false,
      attachments: [],
    };

    const triggeredMessage = {
      platform: "test",
      spaceId: "test-group",
      text: "@Pi hello",
      callerId: "user1",
      isDM: false,
      isReplyToBot: false,
      attachments: [],
    };

    // Send many ignored messages
    for (let i = 0; i < 10; i++) {
      const result = await runtime.handleRawInput(ignoredMessage, "chat-sdk");
      expect(result.type).toBe("ignore");
    }

    // Triggered messages should still be allowed (limit is 3)
    const r1 = await runtime.handleRawInput(triggeredMessage, "chat-sdk");
    expect(r1.type).toBe("assistant");

    const r2 = await runtime.handleRawInput(triggeredMessage, "chat-sdk");
    expect(r2.type).toBe("assistant");

    const r3 = await runtime.handleRawInput(triggeredMessage, "chat-sdk");
    expect(r3.type).toBe("assistant");
  });
});

describe("Role-based daily rate limiting", () => {
  let tempDir: string;
  let runtime: MercuryCoreRuntime;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-daily-rate-"));
    seededSpaces.clear();

    runtime = createRuntime(tempDir, { rateLimitPerUser: 100 });

    runtime.containerRunner.reply = mock(async () => ({
      reply: "mocked reply",
      files: [],
    }));
  });

  afterEach(() => {
    runtime.rateLimiter.stopCleanup();
    runtime.db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test("admin with rate_limit.admin=0 gets unlimited daily access", async () => {
    runtime.db.ensureSpace("s1");
    runtime.db.setRole("s1", "admin1", "admin", "test");
    runtime.db.setSpaceConfig("s1", "rate_limit.admin", "0", "test");
    runtime.db.setSpaceConfig("s1", "rate_limit.member", "2", "test");

    const msg = {
      platform: "test",
      spaceId: "s1",
      text: "@Pi hello",
      callerId: "admin1",
      isDM: false,
      isReplyToBot: false,
      attachments: [],
    };

    for (let i = 0; i < 10; i++) {
      const r = await runtime.handleRawInput(msg, "chat-sdk");
      expect(r.type).toBe("assistant");
    }
  });

  test("member hits daily cap and sees informative denial", async () => {
    runtime.db.ensureSpace("s1");
    runtime.db.setSpaceConfig("s1", "rate_limit.member", "2", "test");

    const msg = {
      platform: "test",
      spaceId: "s1",
      text: "@Pi hello",
      callerId: "user1",
      isDM: false,
      isReplyToBot: false,
      attachments: [],
    };

    const r1 = await runtime.handleRawInput(msg, "chat-sdk");
    expect(r1.type).toBe("assistant");

    const r2 = await runtime.handleRawInput(msg, "chat-sdk");
    expect(r2.type).toBe("assistant");

    const r3 = await runtime.handleRawInput(msg, "chat-sdk");
    expect(r3.type).toBe("denied");
    expect(r3.reason).toContain("2/2 messages today");
    expect(r3.reason).toContain("Resets in");
  });

  test("system caller bypasses daily limit", async () => {
    runtime.db.ensureSpace("s1");
    runtime.db.setSpaceConfig("s1", "rate_limit.member", "1", "test");

    const msg = {
      platform: "test",
      spaceId: "s1",
      text: "@Pi hello",
      callerId: "system",
      isDM: false,
      isReplyToBot: false,
      attachments: [],
    };

    for (let i = 0; i < 5; i++) {
      const r = await runtime.handleRawInput(msg, "chat-sdk");
      expect(r.type).toBe("assistant");
    }
  });

  test("no role key falls through to burst limiter only", async () => {
    runtime.db.ensureSpace("s1");
    // No rate_limit.member set — only burst limiter applies

    const msg = {
      platform: "test",
      spaceId: "s1",
      text: "@Pi hello",
      callerId: "user1",
      isDM: false,
      isReplyToBot: false,
      attachments: [],
    };

    // High burst limit (100), so all should pass
    for (let i = 0; i < 10; i++) {
      const r = await runtime.handleRawInput(msg, "chat-sdk");
      expect(r.type).toBe("assistant");
    }
  });

  test("denied request does not increment daily counter", async () => {
    runtime.db.ensureSpace("s1");
    runtime.db.setSpaceConfig("s1", "rate_limit.member", "1", "test");

    const msg = {
      platform: "test",
      spaceId: "s1",
      text: "@Pi hello",
      callerId: "user1",
      isDM: false,
      isReplyToBot: false,
      attachments: [],
    };

    const r1 = await runtime.handleRawInput(msg, "chat-sdk");
    expect(r1.type).toBe("assistant");

    // These should all be denied but count stays at 1
    for (let i = 0; i < 5; i++) {
      const r = await runtime.handleRawInput(msg, "chat-sdk");
      expect(r.type).toBe("denied");
      expect(r.reason).toContain("1/1 messages today");
    }
  });

  test("daily allowed but burst denied returns burst message", async () => {
    runtime.db.ensureSpace("s1");
    runtime.db.setSpaceConfig("s1", "rate_limit.member", "100", "test");

    // Create runtime with very low burst limit
    runtime.rateLimiter.stopCleanup();
    runtime.db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-daily-rate-"));
    seededSpaces.clear();
    runtime = createRuntime(tempDir, {
      rateLimitPerUser: 1,
      rateLimitWindowMs: 60000,
    });
    runtime.containerRunner.reply = mock(async () => ({
      reply: "mocked reply",
      files: [],
    }));

    runtime.db.ensureSpace("s1");
    runtime.db.setSpaceConfig("s1", "rate_limit.member", "100", "test");

    const msg = {
      platform: "test",
      spaceId: "s1",
      text: "@Pi hello",
      callerId: "user1",
      isDM: false,
      isReplyToBot: false,
      attachments: [],
    };

    const r1 = await runtime.handleRawInput(msg, "chat-sdk");
    expect(r1.type).toBe("assistant");

    const r2 = await runtime.handleRawInput(msg, "chat-sdk");
    expect(r2.type).toBe("denied");
    expect(r2.reason).toBe("Rate limit exceeded. Try again shortly.");
  });

  test("different spaces track daily limits independently", async () => {
    runtime.db.ensureSpace("s1");
    runtime.db.ensureSpace("s2");
    runtime.db.setSpaceConfig("s1", "rate_limit.member", "1", "test");
    runtime.db.setSpaceConfig("s2", "rate_limit.member", "1", "test");

    const msg1 = {
      platform: "test",
      spaceId: "s1",
      text: "@Pi hello",
      callerId: "user1",
      isDM: false,
      isReplyToBot: false,
      attachments: [],
    };

    const msg2 = { ...msg1, spaceId: "s2" };

    const r1 = await runtime.handleRawInput(msg1, "chat-sdk");
    expect(r1.type).toBe("assistant");

    const r2 = await runtime.handleRawInput(msg1, "chat-sdk");
    expect(r2.type).toBe("denied");

    // s2 should still allow
    const r3 = await runtime.handleRawInput(msg2, "chat-sdk");
    expect(r3.type).toBe("assistant");
  });

  test("invalid rate_limit.member value treated as no limit", async () => {
    runtime.db.ensureSpace("s1");
    runtime.db.setSpaceConfig(
      "s1",
      "rate_limit.member",
      "not-a-number",
      "test",
    );

    const msg = {
      platform: "test",
      spaceId: "s1",
      text: "@Pi hello",
      callerId: "user1",
      isDM: false,
      isReplyToBot: false,
      attachments: [],
    };

    for (let i = 0; i < 5; i++) {
      const r = await runtime.handleRawInput(msg, "chat-sdk");
      expect(r.type).toBe("assistant");
    }
  });

  test("negative rate_limit.member value treated as no limit", async () => {
    runtime.db.ensureSpace("s1");
    runtime.db.setSpaceConfig("s1", "rate_limit.member", "-1", "test");

    const msg = {
      platform: "test",
      spaceId: "s1",
      text: "@Pi hello",
      callerId: "user1",
      isDM: false,
      isReplyToBot: false,
      attachments: [],
    };

    for (let i = 0; i < 5; i++) {
      const r = await runtime.handleRawInput(msg, "chat-sdk");
      expect(r.type).toBe("assistant");
    }
  });
});

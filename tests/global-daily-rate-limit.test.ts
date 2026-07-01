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
    rateLimitPerUser: 100,
    rateLimitWindowMs: 60000,
    rateLimitDailyMember: 0,
    rateLimitDailyAdmin: 0,
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
  } as any);
}

function makeMsg(text = "@Pi hello") {
  return {
    platform: "test",
    spaceId: "main",
    callerId: "user1",
    text,
    isDM: false,
    isReplyToBot: false,
    attachments: [],
  };
}

describe("Global daily rate limit fallback", () => {
  let tempDir: string;
  let runtime: MercuryCoreRuntime;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "mercury-daily-rate-test-"),
    );
    seededSpaces.clear();
  });

  afterEach(async () => {
    runtime.rateLimiter.stopCleanup();
    runtime.db.close();
    for (let i = 0; i < 5; i++) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100 * (i + 1)));
      }
    }
  });

  test("global daily member limit = 0: unlimited (no daily check)", async () => {
    runtime = createRuntime(tempDir, { rateLimitDailyMember: 0 });
    runtime.containerRunner.reply = mock(async () => ({
      reply: "ok",
      files: [],
    }));

    for (let i = 0; i < 5; i++) {
      const result = await runtime.handleRawInput(makeMsg(), "chat-sdk");
      expect(result.type).not.toBe("denied");
    }
  });

  test("global daily member limit enforced when per-space not set", async () => {
    runtime = createRuntime(tempDir, { rateLimitDailyMember: 2 });
    runtime.containerRunner.reply = mock(async () => ({
      reply: "ok",
      files: [],
    }));

    const r1 = await runtime.handleRawInput(makeMsg(), "chat-sdk");
    expect(r1.type).toBe("assistant");

    const r2 = await runtime.handleRawInput(makeMsg(), "chat-sdk");
    expect(r2.type).toBe("assistant");

    const r3 = await runtime.handleRawInput(makeMsg(), "chat-sdk");
    expect(r3.type).toBe("denied");
  });

  test("per-space override takes precedence over global", async () => {
    runtime = createRuntime(tempDir, { rateLimitDailyMember: 1 });
    runtime.containerRunner.reply = mock(async () => ({
      reply: "ok",
      files: [],
    }));
    runtime.db.setSpaceConfig("main", "rate_limit.member", "5", "test");

    const r1 = await runtime.handleRawInput(makeMsg(), "chat-sdk");
    expect(r1.type).toBe("assistant");

    const r2 = await runtime.handleRawInput(makeMsg(), "chat-sdk");
    expect(r2.type).toBe("assistant");
  });
});

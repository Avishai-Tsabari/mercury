import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppConfig } from "../src/config.js";
import { MercuryCoreRuntime } from "../src/core/runtime.js";

function baseConfig(tempDir: string): AppConfig {
  return {
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
    enableSlack: false,
    enableDiscord: false,
    enableTeams: false,
    enableTelegram: false,
    admins: "admin1",
    dbPath: path.join(tempDir, "state.db"),
    globalDir: path.join(tempDir, "global"),
    spacesDir: path.join(tempDir, "spaces"),
    whatsappAuthDir: path.join(tempDir, "whatsapp-auth"),
    resolvedModelChain: [
      { provider: "anthropic", model: "claude-sonnet-4-20250514" },
    ],
    resolvedModelChainCapabilities: [
      {
        tools: true,
        vision: false,
        audio_input: false,
        audio_output: false,
        extended_thinking: false,
      },
    ],
    parsedModelCapabilitiesEnv: null,
    effectiveModelChainBudgetMs: 120_000,
  } as AppConfig;
}

describe("Reply-chain isolation", () => {
  let tempDir: string;
  let runtime: MercuryCoreRuntime;
  let lastReplyPayload: {
    prompt?: string;
    messages?: unknown[];
    extraEnv?: Record<string, string>;
  };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-reply-iso-"));
    lastReplyPayload = {};
    runtime = new MercuryCoreRuntime(baseConfig(tempDir));
    runtime.containerRunner.reply = mock(async (input) => {
      lastReplyPayload = input;
      return { reply: "mocked reply", files: [] };
    });
    runtime.db.ensureSpace("g1");
    runtime.db.setRole("g1", "admin1", "admin", "test");
  });

  afterEach(() => {
    runtime.rateLimiter.stopCleanup();
    runtime.db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test("strips <reply_to> from prompt for unprivileged group reply-to-bot", async () => {
    const promptWithReply =
      'follow up question\n\n<reply_to platform="telegram" message_id="123" from_user_id="bot" from_bot="true">\nHere is your secret email content\n</reply_to>';

    await runtime.handleRawInput(
      {
        platform: "test",
        spaceId: "g1",
        conversationExternalId: "c1",
        callerId: "member1",
        text: promptWithReply,
        isDM: false,
        isReplyToBot: true,
        attachments: [],
      },
      "chat-sdk",
    );

    expect(runtime.containerRunner.reply).toHaveBeenCalled();
    expect(lastReplyPayload.prompt).toBe("follow up question");
    expect(lastReplyPayload.prompt).not.toContain("<reply_to");
    expect(lastReplyPayload.prompt).not.toContain("secret email");
  });

  test("sets MERCURY_REPLY_ISOLATED=1 for isolated requests", async () => {
    await runtime.handleRawInput(
      {
        platform: "test",
        spaceId: "g1",
        conversationExternalId: "c1",
        callerId: "member1",
        text: 'hello\n<reply_to from_bot="true">\nstuff\n</reply_to>',
        isDM: false,
        isReplyToBot: true,
        attachments: [],
      },
      "chat-sdk",
    );

    expect(lastReplyPayload.extraEnv?.MERCURY_REPLY_ISOLATED).toBe("1");
  });

  test("clears history for isolated requests", async () => {
    runtime.db.addMessage("g1", "user", "prior question");
    runtime.db.addMessage("g1", "assistant", "prior answer with secrets");
    runtime.db.setSpaceConfig("g1", "context.mode", "context", "system");

    await runtime.handleRawInput(
      {
        platform: "test",
        spaceId: "g1",
        conversationExternalId: "c1",
        callerId: "member1",
        text: "what did you say?",
        isDM: false,
        isReplyToBot: true,
        attachments: [],
      },
      "chat-sdk",
    );

    expect(lastReplyPayload.messages).toEqual([]);
  });

  test("does NOT isolate admin reply-to-bot in group", async () => {
    const promptWithReply =
      'question\n<reply_to from_bot="true">\nsensitive\n</reply_to>';

    await runtime.handleRawInput(
      {
        platform: "test",
        spaceId: "g1",
        conversationExternalId: "c1",
        callerId: "admin1",
        text: promptWithReply,
        isDM: false,
        isReplyToBot: true,
        attachments: [],
      },
      "chat-sdk",
    );

    expect(lastReplyPayload.prompt).toContain("<reply_to");
    expect(lastReplyPayload.prompt).toContain("sensitive");
    expect(lastReplyPayload.extraEnv?.MERCURY_REPLY_ISOLATED).toBeUndefined();
  });

  test("does NOT isolate DM reply-to-bot", async () => {
    const promptWithReply =
      'question\n<reply_to from_bot="true">\nsensitive\n</reply_to>';

    await runtime.handleRawInput(
      {
        platform: "test",
        spaceId: "g1",
        conversationExternalId: "c1",
        callerId: "member1",
        text: promptWithReply,
        isDM: true,
        isReplyToBot: true,
        attachments: [],
      },
      "chat-sdk",
    );

    expect(lastReplyPayload.prompt).toContain("<reply_to");
    expect(lastReplyPayload.prompt).toContain("sensitive");
  });

  test("does NOT isolate non-reply group message", async () => {
    await runtime.handleRawInput(
      {
        platform: "test",
        spaceId: "g1",
        conversationExternalId: "c1",
        callerId: "member1",
        text: "@Pi hello",
        isDM: false,
        isReplyToBot: false,
        attachments: [],
      },
      "chat-sdk",
    );

    expect(lastReplyPayload.extraEnv?.MERCURY_REPLY_ISOLATED).toBeUndefined();
  });
});

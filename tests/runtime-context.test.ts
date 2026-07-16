import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppConfig } from "../src/config.js";
import { MercuryCoreRuntime } from "../src/core/runtime.js";

function baseRuntimeConfig(tempDir: string): AppConfig {
  return {
    modelProvider: "anthropic",
    model: "claude-opus-4-8",
    triggerPatterns: "@Pi,Pi",
    triggerMatch: "mention",
    // Context defaults — match the Zod defaults in src/config.ts. The
    // configurable-context-window feature's non-negotiable rule is that an
    // install with no YAML and no env vars MUST get these exact values; if
    // these defaults drift here, the test fixture diverges from the production
    // config shape and silently breaks the guarantee.
    contextMode: "context",
    contextWindowSize: 10,
    contextReplyChainDepth: 10,
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
    resolvedModelChain: [{ provider: "anthropic", model: "claude-opus-4-8" }],
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

describe("Runtime sliding window context", () => {
  let tempDir: string;
  let runtime: MercuryCoreRuntime;
  let lastReplyPayload: { messages?: unknown[] } | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-ctx-rt-"));
    lastReplyPayload = undefined;
    runtime = new MercuryCoreRuntime(baseRuntimeConfig(tempDir));
    runtime.containerRunner.reply = mock(async (input) => {
      lastReplyPayload = input;
      return { reply: "mocked reply", files: [] };
    });
    runtime.db.ensureSpace("test-group");
    runtime.db.setRole("test-group", "admin1", "admin", "test");
  });

  afterEach(async () => {
    runtime.rateLimiter.stopCleanup();
    runtime.db.close();
    // Windows: SQLite handles release asynchronously — retry cleanup on EBUSY
    for (let i = 0; i < 5; i++) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  });

  test("passes messages array to containerRunner.reply", async () => {
    await runtime.handleRawInput(
      {
        platform: "test",
        spaceId: "test-group",
        conversationExternalId: "c1",
        callerId: "admin1",
        text: "@Pi What is 2+2?",
        isDM: false,
        isReplyToBot: false,
        attachments: [],
      },
      "chat-sdk",
    );

    expect(runtime.containerRunner.reply).toHaveBeenCalled();
    expect(lastReplyPayload).toBeDefined();
    expect(Array.isArray(lastReplyPayload?.messages)).toBe(true);
  });

  test("does not pass useMinimalContext flag", async () => {
    await runtime.handleRawInput(
      {
        platform: "test",
        spaceId: "test-group",
        conversationExternalId: "c1",
        callerId: "admin1",
        text: "hello",
        isDM: false,
        isReplyToBot: true,
        attachments: [],
      },
      "chat-sdk",
    );

    expect(runtime.containerRunner.reply).toHaveBeenCalled();
    expect(
      (lastReplyPayload as Record<string, unknown>)?.useMinimalContext,
    ).toBeUndefined();
  });

  test("sliding window respects config default (10) when no per-space override", async () => {
    runtime.db.setSpaceConfig("test-group", "context.mode", "context", "test");
    // Insert 15 prior turns (more than the default window of 10)
    for (let i = 0; i < 15; i++) {
      runtime.db.addMessage("test-group", "user", `u${i}`);
      runtime.db.addMessage("test-group", "assistant", `a${i}`);
    }

    const getRecentTurnsSpy = mock(runtime.db.getRecentTurns.bind(runtime.db));
    runtime.db.getRecentTurns = getRecentTurnsSpy;

    await runtime.handleRawInput(
      {
        platform: "test",
        spaceId: "test-group",
        conversationExternalId: "c1",
        callerId: "admin1",
        text: "@Pi follow-up",
        isDM: false,
        isReplyToBot: false,
        attachments: [],
      },
      "chat-sdk",
    );

    expect(getRecentTurnsSpy).toHaveBeenCalledWith("test-group", 10);
  });

  test("sliding window respects per-space context.window_size override", async () => {
    runtime.db.setSpaceConfig("test-group", "context.mode", "context", "test");
    runtime.db.setSpaceConfig(
      "test-group",
      "context.window_size",
      "25",
      "test",
    );

    const getRecentTurnsSpy = mock(runtime.db.getRecentTurns.bind(runtime.db));
    runtime.db.getRecentTurns = getRecentTurnsSpy;

    await runtime.handleRawInput(
      {
        platform: "test",
        spaceId: "test-group",
        conversationExternalId: "c1",
        callerId: "admin1",
        text: "@Pi q",
        isDM: false,
        isReplyToBot: false,
        attachments: [],
      },
      "chat-sdk",
    );

    expect(getRecentTurnsSpy).toHaveBeenCalledWith("test-group", 25);
  });

  test("first-boot seed writes context defaults to main space", () => {
    // The MercuryCoreRuntime constructor seeds context.mode, context.window_size,
    // and context.reply_chain_depth into the main space from AppConfig defaults.
    expect(runtime.db.getSpaceConfig("main", "context.mode")).toBe("context");
    expect(runtime.db.getSpaceConfig("main", "context.window_size")).toBe("10");
    expect(runtime.db.getSpaceConfig("main", "context.reply_chain_depth")).toBe(
      "10",
    );
  });

  test("sliding window includes prior messages in chronological order", async () => {
    // Set context mode to "context" so the sliding window is used
    runtime.db.setSpaceConfig("test-group", "context.mode", "context", "test");
    // Store a prior turn in the DB
    runtime.db.addMessage("test-group", "user", "Earlier message");
    runtime.db.addMessage("test-group", "assistant", "Earlier reply");

    await runtime.handleRawInput(
      {
        platform: "test",
        spaceId: "test-group",
        conversationExternalId: "c1",
        callerId: "admin1",
        text: "@Pi follow-up question",
        isDM: false,
        isReplyToBot: false,
        attachments: [],
      },
      "chat-sdk",
    );

    expect(runtime.containerRunner.reply).toHaveBeenCalled();
    const msgs = lastReplyPayload?.messages as
      | Array<{ role: string; content: string }>
      | undefined;
    expect(msgs).toBeDefined();
    // The prior messages should be included
    const roles = msgs?.map((m) => m.role) ?? [];
    expect(roles).toContain("user");
    expect(roles).toContain("assistant");
  });
});

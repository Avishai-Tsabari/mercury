import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MercuryCoreRuntime } from "../src/core/runtime.js";

describe("Runtime compact command", () => {
  let tempDir: string;
  let runtime: MercuryCoreRuntime;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-compact-test-"));

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

  test("compact resets DB boundary and returns Compacted.", async () => {
    // Add some messages so boundary can be set
    runtime.db.addMessage("test-group", "user", "hi");

    const result = await runtime.handleRawInput(
      {
        platform: "test",
        spaceId: "test-group",
        text: "@Pi compact",
        callerId: "admin1",
        isDM: false,
        isReplyToBot: false,
        attachments: [],
      },
      "chat-sdk",
    );

    expect(result.type).toBe("command");
    expect(result.result?.reply).toBe("Compacted.");
    // Container runner should NOT be called for a command
    expect(runtime.containerRunner.reply).not.toHaveBeenCalled();
  });

  test("compact with no messages still succeeds", async () => {
    const result = await runtime.handleRawInput(
      {
        platform: "test",
        spaceId: "test-group",
        text: "@Pi compact",
        callerId: "admin1",
        isDM: false,
        isReplyToBot: false,
        attachments: [],
      },
      "chat-sdk",
    );

    expect(result.type).toBe("command");
    expect(result.result?.reply).toBe("Compacted.");
  });
});

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { seededSpaces } from "../src/core/permissions.js";
import { MercuryCoreRuntime } from "../src/core/runtime.js";

const SPACE = "guard-space";
const ENV_VAR = "MERCURY_TEST_SENSITIVE_GUARD_VAR";

function createRuntime(tempDir: string) {
  return new MercuryCoreRuntime({
    modelProvider: "anthropic",
    model: "claude-opus-4-8",
    triggerPatterns: "@Pi,Pi",
    triggerMatch: "mention",
    dataDir: tempDir,
    authPath: undefined,
    agentContainerImage: "test",
    containerTimeoutMs: 60000,
    maxConcurrency: 2,
    rateLimitPerUser: 100,
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
}

function makeMsg(text: string) {
  return {
    platform: "test",
    spaceId: SPACE,
    callerId: "user1",
    text,
    isDM: false,
    isReplyToBot: false,
    attachments: [],
  };
}

describe("Sensitive-connection guard locale", () => {
  let tempDir: string;
  let runtime: MercuryCoreRuntime;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-guard-test-"));
    seededSpaces.clear();
    process.env[ENV_VAR] = "set";

    runtime = createRuntime(tempDir);
    runtime.containerRunner.reply = mock(async () => ({
      reply: "ok",
      files: [],
    }));

    // Fake a loaded extension with an active sensitive connection.
    (
      runtime as unknown as {
        extensionRegistry: {
          list: () => unknown[];
          getCliExtensions: () => unknown[];
          getClaimedEnvSources: () => Set<string>;
        };
      }
    ).extensionRegistry = {
      list: () => [
        {
          name: "test-ext",
          envVars: [],
          connection: {
            sensitive: true,
            displayName: "TestConn",
            credentialEnvVar: ENV_VAR,
          },
        },
      ],
      getCliExtensions: () => [],
      getClaimedEnvSources: () => new Set<string>(),
    };

    // Group-linked conversation + guard enabled by admin
    runtime.db.ensureSpace(SPACE);
    const conv = runtime.db.ensureConversation("test", "group-1", "group");
    runtime.db.linkConversation(conv.id, SPACE);
    runtime.db.setSpaceConfig(
      SPACE,
      "security.sensitive_connections_allowed",
      "true",
      "test",
    );
  });

  afterEach(async () => {
    delete process.env[ENV_VAR];
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

  test("en space: English warning, yes proceeds", async () => {
    const r1 = await runtime.handleRawInput(makeMsg("@Pi do it"), "chat-sdk");
    expect(r1.type).toBe("denied");
    if (r1.type !== "denied") throw new Error("unreachable");
    expect(r1.reason).toContain("Reply *yes* to proceed or *no* to cancel");
    expect(r1.reason).toContain("TestConn");

    const r2 = await runtime.handleRawInput(makeMsg("@Pi yes"), "chat-sdk");
    expect(r2.type).toBe("assistant");
  });

  test("he space: Hebrew warning, כן proceeds", async () => {
    runtime.db.setSpaceConfig(SPACE, "messages.locale", "he", "test");

    const r1 = await runtime.handleRawInput(makeMsg("@Pi do it"), "chat-sdk");
    expect(r1.type).toBe("denied");
    if (r1.type !== "denied") throw new Error("unreachable");
    expect(r1.reason).toContain("TestConn");
    expect(r1.reason).toContain("כן");

    const r2 = await runtime.handleRawInput(makeMsg("@Pi כן"), "chat-sdk");
    expect(r2.type).toBe("assistant");
  });

  test("he space: English yes still accepted", async () => {
    runtime.db.setSpaceConfig(SPACE, "messages.locale", "he", "test");

    await runtime.handleRawInput(makeMsg("@Pi do it"), "chat-sdk");
    const r2 = await runtime.handleRawInput(makeMsg("@Pi yes"), "chat-sdk");
    expect(r2.type).toBe("assistant");
  });

  test("he space: לא cancels with Hebrew message", async () => {
    runtime.db.setSpaceConfig(SPACE, "messages.locale", "he", "test");

    await runtime.handleRawInput(makeMsg("@Pi do it"), "chat-sdk");
    const r2 = await runtime.handleRawInput(makeMsg("@Pi לא"), "chat-sdk");
    expect(r2.type).toBe("denied");
    if (r2.type !== "denied") throw new Error("unreachable");
    expect(r2.reason).toBe("בוטל.");
  });

  test("en space: כן is NOT a confirm word — treated as a new prompt", async () => {
    await runtime.handleRawInput(makeMsg("@Pi do it"), "chat-sdk");
    const r2 = await runtime.handleRawInput(makeMsg("@Pi כן"), "chat-sdk");
    // New message replaces the pending confirmation and re-warns
    expect(r2.type).toBe("denied");
    if (r2.type !== "denied") throw new Error("unreachable");
    expect(r2.reason).toContain("Reply *yes* to proceed");
  });

  test("disabled guard message localized, mrctl command verbatim", async () => {
    runtime.db.setSpaceConfig(
      SPACE,
      "security.sensitive_connections_allowed",
      "false",
      "test",
    );
    runtime.db.setSpaceConfig(SPACE, "messages.locale", "he", "test");

    const r = await runtime.handleRawInput(makeMsg("@Pi do it"), "chat-sdk");
    expect(r.type).toBe("denied");
    if (r.type !== "denied") throw new Error("unreachable");
    expect(r.reason).toContain("אינטגרציות רגישות");
    expect(r.reason).toContain(
      "mrctl config set security.sensitive_connections_allowed true",
    );
  });
});

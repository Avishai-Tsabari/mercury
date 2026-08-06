import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppConfig } from "../src/config.js";
import {
  gateIncomingMedia,
  gateOutgoingMedia,
} from "../src/core/media-gate.js";
import {
  getRolePermissions,
  resetPermissions,
  seededSpaces,
  withMediaBackCompat,
} from "../src/core/permissions.js";
import { MercuryCoreRuntime } from "../src/core/runtime.js";
import { Db } from "../src/storage/db.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-media-test-"));
  seededSpaces.clear();
  resetPermissions();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("media permission defaults", () => {
  test("member default set contains both media permissions", () => {
    const db = new Db(path.join(tmpDir, "state.db"));
    db.ensureSpace("g1");
    const perms = getRolePermissions(db, "g1", "member");
    expect(perms.has("media.receive")).toBe(true);
    expect(perms.has("media.send")).toBe(true);
    db.close();
  });

  test("stored override without media names revokes media (post-migration lists are literal)", () => {
    const db = new Db(path.join(tmpDir, "state.db"));
    db.ensureSpace("g1");
    // Written AFTER the startup migration ran (migration runs in the Db
    // constructor), so this list is literal.
    db.setSpaceConfig(
      "g1",
      "role.member.permissions",
      "prompt,prefs.get",
      "admin",
    );
    const perms = getRolePermissions(db, "g1", "member");
    expect(perms.has("media.receive")).toBe(false);
    expect(perms.has("media.send")).toBe(false);
    expect(perms.has("prompt")).toBe(true);
    db.close();
  });
});

describe("withMediaBackCompat", () => {
  test("appends both to a list mentioning neither", () => {
    expect(withMediaBackCompat(["prompt", "prefs.get"])).toEqual([
      "prompt",
      "prefs.get",
      "media.receive",
      "media.send",
    ]);
  });

  test("returns verbatim when media.receive is listed", () => {
    expect(withMediaBackCompat(["prompt", "media.receive"])).toEqual([
      "prompt",
      "media.receive",
    ]);
  });

  test("returns verbatim when media.send is listed", () => {
    expect(withMediaBackCompat(["prompt", "media.send"])).toEqual([
      "prompt",
      "media.send",
    ]);
  });

  test("media.purge is not an opt-out signal", () => {
    expect(withMediaBackCompat(["prompt", "media.purge"])).toEqual([
      "prompt",
      "media.purge",
      "media.receive",
      "media.send",
    ]);
  });
});

describe("stored-row startup migration", () => {
  test("appends both to pre-existing rows, preserving updated_by; second startup is a no-op", () => {
    const dbPath = path.join(tmpDir, "state.db");
    let db = new Db(dbPath);
    db.ensureSpace("g1");
    // Simulate a pre-upgrade deployment: seeded row without media names and a
    // cleared guard key (the row was written before the migration existed).
    db.setSpaceConfig(
      "g1",
      "role.member.permissions",
      "prompt,prefs.get",
      "dm-auto-space",
    );
    db.setSpaceConfig(
      "g1",
      "role.moderator.permissions",
      "prompt,tasks.list",
      "admin",
    );
    db.deleteProjectConfig("migration.media_role_permissions");
    db.close();

    // Restart: migration fires.
    db = new Db(dbPath);
    expect(db.getSpaceConfig("g1", "role.member.permissions")).toBe(
      "prompt,prefs.get,media.receive,media.send",
    );
    expect(db.getSpaceConfigUpdatedBy("g1", "role.member.permissions")).toBe(
      "dm-auto-space",
    );
    expect(db.getSpaceConfig("g1", "role.moderator.permissions")).toBe(
      "prompt,tasks.list,media.receive,media.send",
    );
    expect(db.getSpaceConfigUpdatedBy("g1", "role.moderator.permissions")).toBe(
      "admin",
    );

    // Post-migration revocation sticks across restarts.
    db.setSpaceConfig("g1", "role.member.permissions", "prompt", "admin");
    db.close();
    db = new Db(dbPath);
    expect(db.getSpaceConfig("g1", "role.member.permissions")).toBe("prompt");
    db.close();
  });

  test("rows already mentioning a media transfer name are left verbatim", () => {
    const dbPath = path.join(tmpDir, "state.db");
    let db = new Db(dbPath);
    db.ensureSpace("g1");
    db.setSpaceConfig(
      "g1",
      "role.member.permissions",
      "prompt,media.receive",
      "admin",
    );
    db.deleteProjectConfig("migration.media_role_permissions");
    db.close();

    db = new Db(dbPath);
    expect(db.getSpaceConfig("g1", "role.member.permissions")).toBe(
      "prompt,media.receive",
    );
    db.close();
  });
});

describe("gateIncomingMedia", () => {
  function makeWorkspace(): string {
    const ws = path.join(tmpDir, "ws");
    fs.mkdirSync(path.join(ws, "inbox"), { recursive: true });
    return ws;
  }

  test("deletes inbox files, drops attachments, and builds a prompt note", () => {
    const ws = makeWorkspace();
    fs.writeFileSync(path.join(ws, "inbox", "photo.jpg"), "img");
    const result = gateIncomingMedia({
      workspacePath: ws,
      spaceId: "g1",
      callerRole: "member",
      attachments: [
        { path: "inbox/photo.jpg", type: "image", mimeType: "image/jpeg" },
      ],
      hadIncomingAttachments: true,
    });
    expect(fs.existsSync(path.join(ws, "inbox", "photo.jpg"))).toBe(false);
    expect(result.attachments).toBeUndefined();
    expect(result.promptNote).toContain("file receiving is disabled");
  });

  test("refuses to delete paths resolving outside inbox/", () => {
    const ws = makeWorkspace();
    const victim = path.join(ws, "secret.txt");
    fs.writeFileSync(victim, "keep me");
    const result = gateIncomingMedia({
      workspacePath: ws,
      spaceId: "g1",
      callerRole: "member",
      attachments: [
        {
          path: "inbox/../secret.txt",
          type: "document",
          mimeType: "text/plain",
        },
      ],
      hadIncomingAttachments: true,
    });
    expect(fs.existsSync(victim)).toBe(true);
    // Attachment is still dropped from the message even though nothing was deleted.
    expect(result.attachments).toBeUndefined();
    expect(result.promptNote).not.toBeNull();
  });

  test("no attachments and no hadIncomingAttachments → no-op", () => {
    const ws = makeWorkspace();
    const result = gateIncomingMedia({
      workspacePath: ws,
      spaceId: "g1",
      callerRole: "member",
      attachments: undefined,
      hadIncomingAttachments: false,
    });
    expect(result.promptNote).toBeNull();
  });

  test("hadIncomingAttachments without persisted files still notes the block", () => {
    const ws = makeWorkspace();
    const result = gateIncomingMedia({
      workspacePath: ws,
      spaceId: "g1",
      callerRole: "member",
      attachments: [],
      hadIncomingAttachments: true,
    });
    expect(result.attachments).toBeUndefined();
    expect(result.promptNote).toContain("file receiving is disabled");
  });
});

describe("gateOutgoingMedia", () => {
  test("withholds files and appends a notice to the reply", () => {
    const result = gateOutgoingMedia({
      spaceId: "g1",
      callerRole: "member",
      files: [
        {
          path: "/ws/outbox/report.pdf",
          filename: "report.pdf",
          mimeType: "application/pdf",
          sizeBytes: 10,
        },
      ],
      reply: "Here is your report.",
    });
    expect(result.files).toEqual([]);
    expect(result.reply).toContain("Here is your report.");
    expect(result.reply).toContain("file delivery is disabled for your role");
  });

  test("empty files → unchanged reply", () => {
    const result = gateOutgoingMedia({
      spaceId: "g1",
      callerRole: "member",
      files: [],
      reply: "hi",
    });
    expect(result.reply).toBe("hi");
    expect(result.files).toEqual([]);
  });

  test("empty reply gets the notice alone", () => {
    const result = gateOutgoingMedia({
      spaceId: "g1",
      callerRole: "member",
      files: [
        {
          path: "/ws/outbox/a.txt",
          filename: "a.txt",
          mimeType: "text/plain",
          sizeBytes: 1,
        },
      ],
      reply: "",
    });
    expect(result.reply).toMatch(/^\(1 generated file was not delivered/);
  });
});

describe("runtime media gates (integration)", () => {
  function baseConfig(tempDir: string): AppConfig {
    return {
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

  let tempDir: string;
  let runtime: MercuryCoreRuntime;
  let lastReplyPayload: {
    prompt?: string;
    attachments?: unknown[];
  };
  let mockFiles: {
    path: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
  }[];

  function seedInboxFile(spaceId: string, name: string): string {
    const inbox = path.join(tempDir, "spaces", spaceId, "inbox");
    fs.mkdirSync(inbox, { recursive: true });
    const p = path.join(inbox, name);
    fs.writeFileSync(p, "data");
    return p;
  }

  beforeEach(() => {
    // Outer beforeEach already created tempDir; use a nested dir for the runtime.
    const rtDir = fs.mkdtempSync(path.join(tmpDir, "rt-"));
    tempDir = rtDir;
    mockFiles = [];
    lastReplyPayload = {};
    runtime = new MercuryCoreRuntime(baseConfig(rtDir));
    runtime.containerRunner.reply = mock(async (input) => {
      lastReplyPayload = input as typeof lastReplyPayload;
      return { reply: "mocked reply", files: mockFiles };
    });
    runtime.db.ensureSpace("g1");
    runtime.db.setRole("g1", "admin1", "admin", "test");
    // Written post-migration → literal: member has no media permissions.
    runtime.db.setSpaceConfig(
      "g1",
      "role.member.permissions",
      "prompt,prefs.get",
      "admin",
    );
  });

  afterEach(async () => {
    runtime.rateLimiter.stopCleanup();
    runtime.db.close();
  });

  test("revoked media.receive: file deleted, attachments dropped, prompt notes the block, text still answered", async () => {
    const filePath = seedInboxFile("g1", "photo.jpg");
    const res = await runtime.handleRawInput(
      {
        platform: "test",
        spaceId: "g1",
        conversationExternalId: "c1",
        callerId: "member1",
        text: "what do you see?",
        isDM: true,
        isReplyToBot: false,
        attachments: [
          { path: "inbox/photo.jpg", type: "image", mimeType: "image/jpeg" },
        ],
        hadIncomingAttachments: true,
      },
      "chat-sdk",
    );

    expect(fs.existsSync(filePath)).toBe(false);
    expect(lastReplyPayload.prompt).toContain("what do you see?");
    expect(lastReplyPayload.prompt).toContain("file receiving is disabled");
    expect(lastReplyPayload.attachments).toBeUndefined();
    // Stored user message carries no attachments
    const messages = runtime.db.getRecentTurns("g1", 10);
    const userMsg = messages.find((m) => m.role === "user");
    expect(userMsg?.attachments).toBeUndefined();
    expect(res.type).toBe("assistant");
  });

  test("revoked media.send: files withheld, reply carries notice", async () => {
    mockFiles = [
      {
        path: path.join(tempDir, "spaces", "g1", "outbox", "out.pdf"),
        filename: "out.pdf",
        mimeType: "application/pdf",
        sizeBytes: 5,
      },
    ];
    const res = await runtime.handleRawInput(
      {
        platform: "test",
        spaceId: "g1",
        conversationExternalId: "c1",
        callerId: "member1",
        text: "make me a pdf",
        isDM: true,
        isReplyToBot: false,
        attachments: [],
      },
      "chat-sdk",
    );

    expect(res.type).toBe("assistant");
    if (res.type === "assistant" && res.result) {
      expect(res.result.files).toEqual([]);
      expect(res.result.reply).toContain("mocked reply");
      expect(res.result.reply).toContain(
        "file delivery is disabled for your role",
      );
    }
  });

  test("admin in the same space is unaffected by both gates", async () => {
    const filePath = seedInboxFile("g1", "admin.jpg");
    mockFiles = [
      {
        path: path.join(tempDir, "spaces", "g1", "outbox", "a.pdf"),
        filename: "a.pdf",
        mimeType: "application/pdf",
        sizeBytes: 5,
      },
    ];
    const res = await runtime.handleRawInput(
      {
        platform: "test",
        spaceId: "g1",
        conversationExternalId: "c1",
        callerId: "admin1",
        text: "process this",
        isDM: true,
        isReplyToBot: false,
        attachments: [
          { path: "inbox/admin.jpg", type: "image", mimeType: "image/jpeg" },
        ],
        hadIncomingAttachments: true,
      },
      "chat-sdk",
    );

    expect(fs.existsSync(filePath)).toBe(true);
    expect(lastReplyPayload.prompt).not.toContain("file receiving is disabled");
    expect(res.type).toBe("assistant");
    if (res.type === "assistant" && res.result) {
      expect(res.result.files).toHaveLength(1);
      expect(res.result.reply).toBe("mocked reply");
    }
  });

  test("member with default permissions (no override) is unaffected", async () => {
    runtime.db.deleteSpaceConfig("g1", "role.member.permissions");
    const filePath = seedInboxFile("g1", "ok.jpg");
    const res = await runtime.handleRawInput(
      {
        platform: "test",
        spaceId: "g1",
        conversationExternalId: "c1",
        callerId: "member2",
        text: "look",
        isDM: true,
        isReplyToBot: false,
        attachments: [
          { path: "inbox/ok.jpg", type: "image", mimeType: "image/jpeg" },
        ],
        hadIncomingAttachments: true,
      },
      "chat-sdk",
    );

    expect(fs.existsSync(filePath)).toBe(true);
    expect(lastReplyPayload.prompt).not.toContain("file receiving is disabled");
    expect(res.type).toBe("assistant");
  });
});

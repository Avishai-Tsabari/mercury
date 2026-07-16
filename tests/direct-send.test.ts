import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Hono } from "hono";
import type { AppConfig } from "../src/config.js";
import { createApiApp, type Env } from "../src/core/api.js";
import {
  DirectSendError,
  resolveRecipientSpaceId,
} from "../src/core/direct-send.js";
import { seededSpaces } from "../src/core/permissions.js";
import { MercuryCoreRuntime } from "../src/core/runtime.js";
import { SpaceQueue } from "../src/core/space-queue.js";
import { ConfigRegistry } from "../src/extensions/config-registry.js";
import { createMercuryExtensionContext } from "../src/extensions/context.js";
import { ExtensionRegistry } from "../src/extensions/loader.js";
import { Db } from "../src/storage/db.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-direct-send-test-"));
  seededSpaces.clear();
});

afterEach(async () => {
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
});

// ─── Recipient resolution ─────────────────────────────────────────────────

describe("resolveRecipientSpaceId", () => {
  let db: Db;

  beforeEach(() => {
    db = new Db(path.join(tmpDir, "state.db"));
    db.ensureSpace("main");
    db.ensureSpace("dm-49123456789");
    db.ensureSpace("dm-123456789012");
    db.ensureSpace("dm-telegram-12345");
  });

  afterEach(() => {
    db.close();
  });

  test("exact space id resolves directly", () => {
    expect(resolveRecipientSpaceId(db, "main")).toBe("main");
    expect(resolveRecipientSpaceId(db, "dm-49123456789")).toBe(
      "dm-49123456789",
    );
  });

  test("raw WhatsApp phone JID resolves to dm space", () => {
    expect(resolveRecipientSpaceId(db, "49123456789@s.whatsapp.net")).toBe(
      "dm-49123456789",
    );
  });

  test("opaque LID resolves to dm space", () => {
    expect(resolveRecipientSpaceId(db, "123456789012@lid")).toBe(
      "dm-123456789012",
    );
  });

  test("phone with leading + resolves to dm space", () => {
    expect(resolveRecipientSpaceId(db, "+49123456789")).toBe("dm-49123456789");
  });

  test("platform-qualified id resolves to dm space", () => {
    expect(
      resolveRecipientSpaceId(db, "whatsapp:49123456789@s.whatsapp.net"),
    ).toBe("dm-49123456789");
    expect(resolveRecipientSpaceId(db, "telegram:12345")).toBe(
      "dm-telegram-12345",
    );
  });

  test("unknown recipient returns null and never creates a space", () => {
    expect(resolveRecipientSpaceId(db, "99999999999")).toBeNull();
    expect(db.getSpace("dm-99999999999")).toBeNull();
  });

  test("empty recipient returns null", () => {
    expect(resolveRecipientSpaceId(db, "   ")).toBeNull();
  });
});

// ─── Runtime sendDirect ───────────────────────────────────────────────────

describe("MercuryCoreRuntime.sendDirect", () => {
  let runtime: MercuryCoreRuntime;
  let sent: Array<{ spaceId: string; text: string }>;

  beforeEach(() => {
    runtime = new MercuryCoreRuntime({
      modelProvider: "anthropic",
      model: "claude-opus-4-8",
      triggerPatterns: "@Pi,Pi",
      triggerMatch: "mention",
      dataDir: tmpDir,
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
      dbPath: path.join(tmpDir, "state.db"),
      globalDir: path.join(tmpDir, "global"),
      spacesDir: path.join(tmpDir, "spaces"),
      whatsappAuthDir: path.join(tmpDir, "whatsapp-auth"),
    });
    runtime.db.ensureSpace("dm-49123456789");
    sent = [];
  });

  afterEach(() => {
    runtime.scheduler.stop();
    runtime.rateLimiter.stopCleanup();
    runtime.db.close();
  });

  function startSender() {
    runtime.startScheduler({
      async send(spaceId: string, text: string) {
        sent.push({ spaceId, text });
      },
    });
  }

  test("throws sender_not_ready before scheduler starts", async () => {
    expect(runtime.sendDirect("dm-49123456789", "hi")).rejects.toThrow(
      DirectSendError,
    );
    try {
      await runtime.sendDirect("dm-49123456789", "hi");
      expect.unreachable();
    } catch (err) {
      expect((err as DirectSendError).reason).toBe("sender_not_ready");
    }
  });

  test("throws invalid_text for empty text", async () => {
    startSender();
    try {
      await runtime.sendDirect("dm-49123456789", "   ");
      expect.unreachable();
    } catch (err) {
      expect((err as DirectSendError).reason).toBe("invalid_text");
    }
  });

  test("throws invalid_text for text over 4096 chars", async () => {
    startSender();
    try {
      await runtime.sendDirect("dm-49123456789", "x".repeat(4097));
      expect.unreachable();
    } catch (err) {
      expect((err as DirectSendError).reason).toBe("invalid_text");
    }
  });

  test("throws unknown_recipient for unresolvable recipient", async () => {
    startSender();
    try {
      await runtime.sendDirect("99999999999", "hello");
      expect.unreachable();
    } catch (err) {
      expect((err as DirectSendError).reason).toBe("unknown_recipient");
    }
    expect(sent).toBeArrayOfSize(0);
  });

  test("delivers to resolved space via message sender", async () => {
    startSender();
    const result = await runtime.sendDirect(
      "49123456789@s.whatsapp.net",
      "  reminder: haircut tomorrow at 10  ",
    );
    expect(result.spaceId).toBe("dm-49123456789");
    expect(sent).toEqual([
      { spaceId: "dm-49123456789", text: "reminder: haircut tomorrow at 10" },
    ]);
  });
});

// ─── Extension context ctx.send ───────────────────────────────────────────

describe("ctx.send", () => {
  let db: Db;

  beforeEach(() => {
    db = new Db(path.join(tmpDir, "state.db"));
  });

  afterEach(() => {
    db.close();
  });

  const baseOpts = () => ({
    db,
    config: {} as AppConfig,
    log: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    } as never,
  });

  test("throws sender_not_ready when context has no delivery path", async () => {
    const ctx = createMercuryExtensionContext(baseOpts());
    try {
      await ctx.send({ to: "dm-49123456789", text: "hi" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(DirectSendError);
      expect((err as DirectSendError).reason).toBe("sender_not_ready");
    }
  });

  test("delegates to bound sendDirect", async () => {
    const calls: Array<{ recipient: string; text: string }> = [];
    const ctx = createMercuryExtensionContext({
      ...baseOpts(),
      sendDirect: async (recipient, text) => {
        calls.push({ recipient, text });
        return { spaceId: "dm-49123456789" };
      },
    });
    const result = await ctx.send({ to: "+49123456789", text: "hi" });
    expect(result.spaceId).toBe("dm-49123456789");
    expect(calls).toEqual([{ recipient: "+49123456789", text: "hi" }]);
  });
});

// ─── POST /api/send ───────────────────────────────────────────────────────

describe("POST /send", () => {
  let db: Db;
  let config: AppConfig;
  let app: Hono<Env>;

  const containerRunner = {
    abort(_spaceId: string): boolean {
      return false;
    },
  };

  const scheduler = {
    async triggerTask(_taskId: number): Promise<void> {},
  };

  function createMockRuntime(overrides?: { error?: DirectSendError }) {
    return {
      sendDirect: async (_recipient: string, _text: string) => {
        if (overrides?.error) throw overrides.error;
        return { spaceId: "dm-49123456789" };
      },
    };
  }

  function buildApp(runtime?: unknown) {
    app = createApiApp({
      db,
      config,
      containerRunner: containerRunner as never,
      queue: new SpaceQueue(2),
      scheduler: scheduler as never,
      registry: new ExtensionRegistry(),
      configRegistry: new ConfigRegistry(),
      runtime: runtime as never,
    });
  }

  async function api(
    body: unknown,
    callerId = "admin1",
  ): Promise<{ status: number; data: Record<string, unknown> }> {
    const res = await app.request("/send", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mercury-caller": callerId,
        "x-mercury-space": "main",
      },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as Record<string, unknown>;
    return { status: res.status, data };
  }

  beforeEach(() => {
    db = new Db(path.join(tmpDir, "state.db"));
    config = {
      admins: "admin1",
      dataDir: tmpDir,
    } as AppConfig;
  });

  afterEach(() => {
    db.close();
  });

  test("returns 403 for non-admin caller", async () => {
    buildApp(createMockRuntime());
    const { status, data } = await api(
      { recipient: "+49123456789", text: "hi" },
      "random-user",
    );
    expect(status).toBe(403);
    expect(data.error).toContain("admin");
  });

  test("returns 503 when runtime is not set", async () => {
    buildApp(undefined);
    const { status } = await api({ recipient: "+49123456789", text: "hi" });
    expect(status).toBe(503);
  });

  test("returns 400 for missing recipient", async () => {
    buildApp(createMockRuntime());
    const { status, data } = await api({ text: "hi" });
    expect(status).toBe(400);
    expect(data.error).toContain("recipient");
  });

  test("returns 400 for invalid text", async () => {
    buildApp(
      createMockRuntime({
        error: DirectSendError.invalidText("Missing or empty text"),
      }),
    );
    const { status } = await api({ recipient: "+49123456789", text: "" });
    expect(status).toBe(400);
  });

  test("returns 404 for unknown recipient", async () => {
    buildApp(
      createMockRuntime({
        error: DirectSendError.unknownRecipient("99999999999"),
      }),
    );
    const { status, data } = await api({
      recipient: "99999999999",
      text: "hi",
    });
    expect(status).toBe(404);
    expect(data.error).toContain("99999999999");
  });

  test("returns 503 when sender is not ready", async () => {
    buildApp(createMockRuntime({ error: DirectSendError.senderNotReady() }));
    const { status } = await api({ recipient: "+49123456789", text: "hi" });
    expect(status).toBe(503);
  });

  test("delivers and returns the resolved space id", async () => {
    buildApp(createMockRuntime());
    const { status, data } = await api({
      recipient: "49123456789@s.whatsapp.net",
      text: "reminder",
    });
    expect(status).toBe(200);
    expect(data.delivered).toBe(true);
    expect(data.spaceId).toBe("dm-49123456789");
  });
});

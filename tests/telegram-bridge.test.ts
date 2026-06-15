import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Message, parseMarkdown } from "chat";
import { TelegramBridge } from "../src/bridges/telegram.js";
import { TELEGRAM_MESSAGE_LIMIT } from "../src/core/telegram-format.js";
import type { EgressFile, NormalizeContext } from "../src/types.js";

// ─── Mock Adapter ───────────────────────────────────────────────────────

function createMockAdapter() {
  const postCalls: { threadId: string; text: string }[] = [];

  return {
    adapter: {
      postMessage: async (threadId: string, message: unknown) => {
        const text = typeof message === "string" ? message : String(message);
        postCalls.push({ threadId, text });
        return { id: "mock", threadId, raw: {} };
      },
      get botUserId() {
        return "123456";
      },
    },
    postCalls,
  };
}

function makeMessage(overrides: {
  text?: string;
  isMe?: boolean;
  userId?: string;
  userName?: string;
  raw?: unknown;
  attachments?: {
    url?: string;
    name?: string;
    size?: number;
    mimeType?: string;
  }[];
}): Message {
  return new Message({
    id: "msg-1",
    threadId: "telegram:12345",
    text: overrides.text ?? "hello",
    formatted: parseMarkdown(overrides.text ?? "hello"),
    raw: overrides.raw ?? {},
    author: {
      userId: overrides.userId ?? "1400791156",
      userName: overrides.userName ?? "TestUser",
      fullName: overrides.userName ?? "TestUser",
      isBot: false,
      isMe: overrides.isMe ?? false,
    },
    metadata: { dateSent: new Date(), edited: false },
    attachments: overrides.attachments ?? [],
  });
}

const defaultCtx: NormalizeContext = {
  botUserName: "mercury",
  getWorkspace: () => null,
  media: { enabled: true, maxSizeBytes: 10 * 1024 * 1024 },
  isOverQuota: () => Promise.resolve(false),
};

// ─── Tests ──────────────────────────────────────────────────────────────

describe("TelegramBridge", () => {
  describe("parseThread", () => {
    test("parses DM chat IDs", () => {
      const { adapter } = createMockAdapter();
      const bridge = new TelegramBridge(adapter as never, "token", true);
      expect(bridge.parseThread("telegram:12345")).toEqual({
        externalId: "12345",
        isDM: true,
      });
    });

    test("parses group chat IDs", () => {
      const { adapter } = createMockAdapter();
      const bridge = new TelegramBridge(adapter as never, "token", true);
      expect(bridge.parseThread("telegram:-100123456")).toEqual({
        externalId: "-100123456",
        isDM: false,
      });
    });

    test("parses thread IDs with message_thread_id", () => {
      const { adapter } = createMockAdapter();
      const bridge = new TelegramBridge(adapter as never, "token", true);
      expect(bridge.parseThread("telegram:-100123456:789")).toEqual({
        externalId: "-100123456:789",
        isDM: false,
      });
    });
  });

  describe("normalize", () => {
    test("returns null for bot own messages", async () => {
      const { adapter } = createMockAdapter();
      const bridge = new TelegramBridge(adapter as never, "token", true);
      const msg = makeMessage({ isMe: true });
      expect(
        await bridge.normalize("telegram:123", msg, defaultCtx, "space1"),
      ).toBeNull();
    });

    test("returns null for empty messages", async () => {
      const { adapter } = createMockAdapter();
      const bridge = new TelegramBridge(adapter as never, "token", true);
      const msg = makeMessage({ text: "" });
      expect(
        await bridge.normalize("telegram:123", msg, defaultCtx, "space1"),
      ).toBeNull();
    });

    test("voice in raw without adapter attachments downloads via getFile", async () => {
      const { adapter } = createMockAdapter();
      const bridge = new TelegramBridge(adapter as never, "test-token", true);
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tg-voice-"));
      const ctx: NormalizeContext = {
        botUserName: "mercury",
        getWorkspace: () => tmp,
        media: { enabled: true, maxSizeBytes: 10 * 1024 * 1024 },
        isOverQuota: () => Promise.resolve(false),
      };
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (url: string | URL) => {
        const u = typeof url === "string" ? url : url.toString();
        if (u.includes("/getFile")) {
          return new Response(
            JSON.stringify({
              ok: true,
              result: { file_path: "voice/file.oga" },
            }),
            { status: 200 },
          );
        }
        if (u.includes("/file/bottest-token/")) {
          return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
        }
        return new Response("not mocked", { status: 404 });
      };
      try {
        const msg = makeMessage({
          text: "",
          attachments: [],
          raw: {
            voice: {
              file_id: "abc",
              mime_type: "audio/ogg",
              file_size: 4,
            },
          },
        });
        const result = await bridge.normalize(
          "telegram:123",
          msg,
          ctx,
          "space1",
        );
        expect(result).not.toBeNull();
        expect(result?.hadIncomingAttachments).toBe(true);
        expect(result?.attachments).toHaveLength(1);
        const saved = result?.attachments[0];
        expect(saved?.mimeType).toBe("audio/ogg");
        expect(saved?.path).toBeDefined();
        if (saved?.path) expect(fs.existsSync(saved.path)).toBe(true);
      } finally {
        globalThis.fetch = originalFetch;
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    test("builds correct IngressMessage", async () => {
      const { adapter } = createMockAdapter();
      const bridge = new TelegramBridge(adapter as never, "token", true);
      const msg = makeMessage({ text: "hello", userName: "Avishai" });
      const result = await bridge.normalize(
        "telegram:12345",
        msg,
        defaultCtx,
        "space1",
      );
      expect(result).not.toBeNull();
      expect(result?.platform).toBe("telegram");
      expect(result?.text).toBe("hello");
      expect(result?.authorName).toBe("Avishai");
      expect(result?.callerId).toBe("telegram:1400791156");
    });

    test("embeds reply_to_message text in IngressMessage for the model", async () => {
      const { adapter } = createMockAdapter();
      const bridge = new TelegramBridge(adapter as never, "token", true);
      const priorAssistant =
        'הנה התרגום לעברית של ההודעה הקולית שלך:\n\n---\n"תרגם לי לעברית בבקשה."\n---';
      const msg = makeMessage({
        text: "Here is the paragraph to translate to English.",
        raw: {
          reply_to_message: {
            message_id: 42,
            from: { id: 123456 },
            text: priorAssistant,
          },
        },
      });
      const result = await bridge.normalize(
        "telegram:12345",
        msg,
        defaultCtx,
        "space1",
      );
      expect(result).not.toBeNull();
      expect(result?.isReplyToBot).toBe(true);
      expect(result?.text).toContain(
        "Here is the paragraph to translate to English.",
      );
      expect(result?.text).toContain("<reply_to");
      expect(result?.text).toContain('from_bot="true"');
      expect(result?.text).toContain(priorAssistant);
      expect(result?.text).toContain("</reply_to>");
    });
  });

  describe("sendReply", () => {
    let fetchCalls: { url: string; body: string }[] = [];
    let originalFetch: typeof fetch;

    beforeEach(() => {
      fetchCalls = [];
      originalFetch = globalThis.fetch;
      globalThis.fetch = async (url: string | URL, init?: RequestInit) => {
        const u = typeof url === "string" ? url : url.toString();
        const body = init?.body ? String(init.body) : "";
        fetchCalls.push({ url: u, body });
        return new Response(
          JSON.stringify({
            ok: true,
            result: { message_id: 1, chat: { id: 123 } },
          }),
          { status: 200 },
        );
      };
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    test("formatEnabled: calls sendMessage API with HTML when formatEnabled=true", async () => {
      const { adapter, postCalls } = createMockAdapter();
      const bridge = new TelegramBridge(adapter as never, "token", true);
      await bridge.sendReply("telegram:12345", "**bold** text");

      expect(postCalls).toHaveLength(0);
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0].url).toContain("sendMessage");
      const body = JSON.parse(fetchCalls[0].body);
      expect(body.parse_mode).toBe("HTML");
      expect(body.text).toBe("<b>bold</b> text");
      expect(body.chat_id).toBe("12345");
    });

    test("formatEnabled: uses adapter.postMessage when formatEnabled=false", async () => {
      const { adapter, postCalls } = createMockAdapter();
      const bridge = new TelegramBridge(adapter as never, "token", false);
      await bridge.sendReply("telegram:12345", "**bold** text");

      expect(fetchCalls).toHaveLength(0);
      expect(postCalls).toHaveLength(1);
      // The non-formatted path normalizes to WhatsApp-style markup before
      // handing off to the adapter (no Telegram HTML conversion here).
      expect(postCalls[0].text).toBe("*bold* text");
    });

    test("truncates text to TELEGRAM_MESSAGE_LIMIT", async () => {
      const { adapter } = createMockAdapter();
      const bridge = new TelegramBridge(adapter as never, "token", true);
      const longText = "x".repeat(TELEGRAM_MESSAGE_LIMIT + 100);
      await bridge.sendReply("telegram:12345", longText);

      expect(fetchCalls).toHaveLength(1);
      const body = JSON.parse(fetchCalls[0].body);
      expect(body.text.length).toBe(TELEGRAM_MESSAGE_LIMIT);
    });

    test("no-op for empty text and no files", async () => {
      const { adapter, postCalls } = createMockAdapter();
      const bridge = new TelegramBridge(adapter as never, "token", true);
      await bridge.sendReply("telegram:12345", "");

      expect(postCalls).toHaveLength(0);
      expect(fetchCalls).toHaveLength(0);
    });

    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-bridge-test-"));
    });

    afterEach(() => {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });

    function tmpFile(name: string, content = "test"): EgressFile {
      const filePath = path.join(tmpDir, name);
      fs.writeFileSync(filePath, content);
      return {
        path: filePath,
        filename: name,
        mimeType: "application/pdf",
        sizeBytes: Buffer.byteLength(content),
      };
    }

    test("sends text first then uploads files", async () => {
      const { adapter } = createMockAdapter();
      const bridge = new TelegramBridge(adapter as never, "token", true);
      const file = tmpFile("report.pdf");

      await bridge.sendReply("telegram:12345", "here's the report", [file]);

      expect(fetchCalls.length).toBeGreaterThanOrEqual(1);
      const sendMsgCall = fetchCalls.find((c) => c.url.includes("sendMessage"));
      expect(sendMsgCall).toBeDefined();
      expect(JSON.parse(sendMsgCall?.body ?? "{}").text).toBe(
        "here's the report",
      );
    });

    test("uses sendAudio for MP3 egress (not sendDocument)", async () => {
      const { adapter } = createMockAdapter();
      const bridge = new TelegramBridge(adapter as never, "token", true);
      const filePath = path.join(tmpDir, "reply.mp3");
      fs.writeFileSync(filePath, Buffer.from([0xff, 0xfb]));
      const file: EgressFile = {
        path: filePath,
        filename: "reply.mp3",
        mimeType: "audio/mpeg",
        sizeBytes: 2,
      };

      await bridge.sendReply("telegram:12345", "", [file]);

      const audioCall = fetchCalls.find((c) => c.url.includes("/sendAudio"));
      expect(audioCall).toBeDefined();
      expect(audioCall?.url).toContain("sendAudio");
    });

    test("uses sendVoice for OGG egress", async () => {
      const { adapter } = createMockAdapter();
      const bridge = new TelegramBridge(adapter as never, "token", true);
      const filePath = path.join(tmpDir, "note.ogg");
      fs.writeFileSync(filePath, "fakeogg");
      const file: EgressFile = {
        path: filePath,
        filename: "note.ogg",
        mimeType: "audio/ogg",
        sizeBytes: 7,
      };

      await bridge.sendReply("telegram:12345", "", [file]);

      const voiceCall = fetchCalls.find((c) => c.url.includes("/sendVoice"));
      expect(voiceCall).toBeDefined();
    });
  });
});

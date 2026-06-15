import { describe, expect, test } from "bun:test";
import type { proto } from "@whiskeysockets/baileys";
import {
  detectWhatsAppMedia,
  downloadQuotedMedia,
} from "../src/adapters/whatsapp-media.js";

describe("quoted voice message detection", () => {
  test("detects voice note in quotedMessage", () => {
    const quotedMessage: proto.IMessage = {
      audioMessage: {
        mimetype: "audio/ogg",
        ptt: true,
        fileLength: 5000 as unknown as Long,
      },
    };
    const result = detectWhatsAppMedia(quotedMessage);
    expect(result).not.toBeNull();
    expect(result?.type).toBe("voice");
    expect(result?.mimeType).toBe("audio/ogg");
  });

  test("detects regular audio in quotedMessage", () => {
    const quotedMessage: proto.IMessage = {
      audioMessage: {
        mimetype: "audio/mpeg",
        ptt: false,
        fileLength: 8000 as unknown as Long,
      },
    };
    const result = detectWhatsAppMedia(quotedMessage);
    expect(result).not.toBeNull();
    expect(result?.type).toBe("audio");
    expect(result?.mimeType).toBe("audio/mpeg");
  });

  test("returns null for text-only quotedMessage", () => {
    const quotedMessage: proto.IMessage = {
      conversation: "just text",
    };
    expect(detectWhatsAppMedia(quotedMessage)).toBeNull();
  });

  test("detects image in quotedMessage (non-audio — filtered by downloadQuotedMedia)", () => {
    const quotedMessage: proto.IMessage = {
      imageMessage: {
        mimetype: "image/jpeg",
        fileLength: 12000 as unknown as Long,
      },
    };
    const result = detectWhatsAppMedia(quotedMessage);
    expect(result).not.toBeNull();
    expect(result?.type).toBe("image");
  });

  test("contextInfo with quotedMessage containing voice note provides audio metadata", () => {
    const contextInfo: proto.IContextInfo = {
      stanzaId: "msg-123",
      participant: "972541234567@s.whatsapp.net",
      quotedMessage: {
        audioMessage: {
          mimetype: "audio/ogg",
          ptt: true,
          fileLength: 15000 as unknown as Long,
        },
      },
    };

    expect(contextInfo.quotedMessage).toBeDefined();
    const media = detectWhatsAppMedia(contextInfo.quotedMessage ?? null);
    expect(media).not.toBeNull();
    expect(media?.type).toBe("voice");
  });

  test("downloadQuotedMedia returns null for non-audio quoted media", async () => {
    const contextInfo: proto.IContextInfo = {
      stanzaId: "msg-456",
      participant: "972541234567@s.whatsapp.net",
      quotedMessage: {
        imageMessage: {
          mimetype: "image/jpeg",
          fileLength: 50000 as unknown as Long,
        },
      },
    };

    // biome-ignore lint/suspicious/noExplicitAny: mock socket for test
    const result = await downloadQuotedMedia(contextInfo, {} as any, {
      maxSizeBytes: 10_000_000,
      outputDir: "/tmp/test",
    });
    expect(result).toBeNull();
  });

  test("downloadQuotedMedia returns null when no quotedMessage", async () => {
    const contextInfo: proto.IContextInfo = {
      stanzaId: "msg-789",
    };

    // biome-ignore lint/suspicious/noExplicitAny: mock socket for test
    const result = await downloadQuotedMedia(contextInfo, {} as any, {
      maxSizeBytes: 10_000_000,
      outputDir: "/tmp/test",
    });
    expect(result).toBeNull();
  });

  test("extendedTextMessage reply carries contextInfo with quoted voice", () => {
    const replyMessage: proto.IMessage = {
      extendedTextMessage: {
        text: "@mercury what did they say?",
        contextInfo: {
          stanzaId: "original-voice-msg-id",
          participant: "972541234567@s.whatsapp.net",
          quotedMessage: {
            audioMessage: {
              mimetype: "audio/ogg",
              ptt: true,
              fileLength: 20000 as unknown as Long,
            },
          },
        },
      },
    };

    const directMedia = detectWhatsAppMedia(replyMessage);
    expect(directMedia).toBeNull();

    const contextInfo = replyMessage.extendedTextMessage?.contextInfo;
    expect(contextInfo?.quotedMessage).toBeDefined();
    const quotedMedia = detectWhatsAppMedia(contextInfo?.quotedMessage ?? null);
    expect(quotedMedia).not.toBeNull();
    expect(quotedMedia?.type).toBe("voice");
  });
});

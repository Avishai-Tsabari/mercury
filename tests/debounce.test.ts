import { beforeEach, describe, expect, test } from "bun:test";
import {
  getDefaultDebounceMs,
  MessageDebouncer,
  mergeIngresses,
} from "../src/core/debounce.js";
import type { IngressMessage } from "../src/types.js";

function makeIngress(overrides: Partial<IngressMessage> = {}): IngressMessage {
  return {
    platform: "whatsapp",
    spaceId: "dm-123",
    conversationExternalId: "123@s.whatsapp.net",
    callerId: "whatsapp:123",
    authorName: "Test User",
    text: "hello",
    isDM: true,
    isReplyToBot: false,
    attachments: [],
    hadIncomingAttachments: false,
    ...overrides,
  };
}

describe("getDefaultDebounceMs", () => {
  test("returns 2000 for whatsapp", () => {
    expect(getDefaultDebounceMs("whatsapp")).toBe(2000);
  });

  test("returns 2000 for telegram", () => {
    expect(getDefaultDebounceMs("telegram")).toBe(2000);
  });

  test("returns 0 for slack", () => {
    expect(getDefaultDebounceMs("slack")).toBe(0);
  });

  test("returns 0 for discord", () => {
    expect(getDefaultDebounceMs("discord")).toBe(0);
  });

  test("returns 0 for unknown platforms", () => {
    expect(getDefaultDebounceMs("teams")).toBe(0);
  });
});

describe("mergeIngresses", () => {
  test("single message returns it unchanged", () => {
    const msg = makeIngress({ text: "hello" });
    expect(mergeIngresses([msg])).toBe(msg);
  });

  test("joins text with newlines", () => {
    const a = makeIngress({ text: "hey" });
    const b = makeIngress({ text: "book room A3" });
    const c = makeIngress({ text: "for tomorrow" });
    const merged = mergeIngresses([a, b, c]);
    expect(merged.text).toBe("hey\nbook room A3\nfor tomorrow");
  });

  test("concatenates attachments in order", () => {
    const att1 = {
      path: "/a.jpg",
      type: "image" as const,
      mimeType: "image/jpeg",
    };
    const att2 = {
      path: "/b.pdf",
      type: "document" as const,
      mimeType: "application/pdf",
    };
    const a = makeIngress({ attachments: [att1] });
    const b = makeIngress({ attachments: [att2] });
    const merged = mergeIngresses([a, b]);
    expect(merged.attachments).toEqual([att1, att2]);
  });

  test("hadIncomingAttachments is true if any message had it", () => {
    const a = makeIngress({ hadIncomingAttachments: false });
    const b = makeIngress({ hadIncomingAttachments: true });
    expect(mergeIngresses([a, b]).hadIncomingAttachments).toBe(true);
  });

  test("isReplyToBot from first message only", () => {
    const a = makeIngress({ isReplyToBot: true });
    const b = makeIngress({ isReplyToBot: false });
    expect(mergeIngresses([a, b]).isReplyToBot).toBe(true);

    const c = makeIngress({ isReplyToBot: false });
    const d = makeIngress({ isReplyToBot: true });
    expect(mergeIngresses([c, d]).isReplyToBot).toBe(false);
  });

  test("replyToPlatformMessageId from first message", () => {
    const a = makeIngress({ replyToPlatformMessageId: "msg-1" });
    const b = makeIngress({ replyToPlatformMessageId: "msg-2" });
    expect(mergeIngresses([a, b]).replyToPlatformMessageId).toBe("msg-1");
  });

  test("platformMessageId from last message", () => {
    const a = makeIngress({ platformMessageId: "msg-1" });
    const b = makeIngress({ platformMessageId: "msg-2" });
    expect(mergeIngresses([a, b]).platformMessageId).toBe("msg-2");
  });

  test("authorName from first message", () => {
    const a = makeIngress({ authorName: "Alice" });
    const b = makeIngress({ authorName: "Alice (updated)" });
    expect(mergeIngresses([a, b]).authorName).toBe("Alice");
  });

  test("invariant fields preserved from first message", () => {
    const a = makeIngress({
      platform: "whatsapp",
      spaceId: "dm-123",
      callerId: "whatsapp:123",
      isDM: true,
    });
    const b = makeIngress();
    const merged = mergeIngresses([a, b]);
    expect(merged.platform).toBe("whatsapp");
    expect(merged.spaceId).toBe("dm-123");
    expect(merged.callerId).toBe("whatsapp:123");
    expect(merged.isDM).toBe(true);
  });
});

describe("MessageDebouncer", () => {
  let debouncer: MessageDebouncer;

  beforeEach(() => {
    debouncer = new MessageDebouncer();
  });

  test("flushes after timeout with single message", async () => {
    let flushed: IngressMessage | null = null;
    const msg = makeIngress({ text: "hello" });

    debouncer.submit("key1", msg, 50, async (merged) => {
      flushed = merged;
    });

    await new Promise((r) => setTimeout(r, 100));
    expect(flushed).not.toBeNull();
    expect(flushed?.text).toBe("hello");
  });

  test("batches messages within timeout window", async () => {
    let flushed: IngressMessage | null = null;

    debouncer.submit("key1", makeIngress({ text: "hey" }), 100, async (m) => {
      flushed = m;
    });

    await new Promise((r) => setTimeout(r, 30));
    expect(flushed).toBeNull();

    debouncer.submit(
      "key1",
      makeIngress({ text: "book room" }),
      100,
      async (m) => {
        flushed = m;
      },
    );

    await new Promise((r) => setTimeout(r, 30));
    expect(flushed).toBeNull();

    debouncer.submit(
      "key1",
      makeIngress({ text: "for 3pm" }),
      100,
      async (m) => {
        flushed = m;
      },
    );

    await new Promise((r) => setTimeout(r, 150));
    expect(flushed).not.toBeNull();
    expect(flushed?.text).toBe("hey\nbook room\nfor 3pm");
  });

  test("different keys flush independently", async () => {
    const results: Record<string, string> = {};

    debouncer.submit(
      "user-a",
      makeIngress({ text: "from A" }),
      50,
      async (m) => {
        results["user-a"] = m.text;
      },
    );
    debouncer.submit(
      "user-b",
      makeIngress({ text: "from B" }),
      50,
      async (m) => {
        results["user-b"] = m.text;
      },
    );

    await new Promise((r) => setTimeout(r, 100));
    expect(results["user-a"]).toBe("from A");
    expect(results["user-b"]).toBe("from B");
  });

  test("flushKey immediately fires pending batch", async () => {
    let flushed: IngressMessage | null = null;
    const onFlush = async (m: IngressMessage) => {
      flushed = m;
    };

    debouncer.submit("key1", makeIngress({ text: "hey" }), 5000, onFlush);
    debouncer.submit("key1", makeIngress({ text: "more" }), 5000, onFlush);

    expect(flushed).toBeNull();
    debouncer.flushKey("key1", onFlush);

    await new Promise((r) => setTimeout(r, 50));
    expect(flushed).not.toBeNull();
    expect(flushed?.text).toBe("hey\nmore");
  });

  test("flushKey is a no-op when no batch exists", () => {
    expect(() =>
      debouncer.flushKey("nonexistent", async () => {}),
    ).not.toThrow();
  });

  test("in-flight guard queues messages during processing", async () => {
    const flushOrder: string[] = [];

    debouncer.submit("key1", makeIngress({ text: "first" }), 50, async (m) => {
      flushOrder.push(m.text);
      await new Promise((r) => setTimeout(r, 100));
    });

    await new Promise((r) => setTimeout(r, 70));

    debouncer.submit("key1", makeIngress({ text: "second" }), 50, async (m) => {
      flushOrder.push(m.text);
    });

    await new Promise((r) => setTimeout(r, 300));
    expect(flushOrder).toEqual(["first", "second"]);
  });

  test("in-flight guard batches multiple queued messages", async () => {
    const flushOrder: string[] = [];

    debouncer.submit("key1", makeIngress({ text: "first" }), 50, async (m) => {
      flushOrder.push(m.text);
      await new Promise((r) => setTimeout(r, 200));
    });

    await new Promise((r) => setTimeout(r, 70));

    debouncer.submit("key1", makeIngress({ text: "a" }), 50, async (m) => {
      flushOrder.push(m.text);
    });
    debouncer.submit("key1", makeIngress({ text: "b" }), 50, async (m) => {
      flushOrder.push(m.text);
    });

    await new Promise((r) => setTimeout(r, 400));
    expect(flushOrder).toEqual(["first", "a\nb"]);
  });

  test("isProcessing returns true during flush", async () => {
    expect(debouncer.isProcessing("key1")).toBe(false);

    debouncer.submit("key1", makeIngress({ text: "hi" }), 30, async () => {
      await new Promise((r) => setTimeout(r, 100));
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(debouncer.isProcessing("key1")).toBe(true);

    await new Promise((r) => setTimeout(r, 150));
    expect(debouncer.isProcessing("key1")).toBe(false);
  });

  test("flushAll fires all pending batches", async () => {
    const results: string[] = [];
    const onFlush = async (m: IngressMessage) => {
      results.push(m.text);
    };

    debouncer.submit("a", makeIngress({ text: "msg-a" }), 5000, onFlush);
    debouncer.submit("b", makeIngress({ text: "msg-b" }), 5000, onFlush);

    debouncer.flushAll(onFlush);

    await new Promise((r) => setTimeout(r, 50));
    expect(results.sort()).toEqual(["msg-a", "msg-b"]);
  });
});

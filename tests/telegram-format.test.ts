import { describe, expect, test } from "bun:test";
import {
  markdownToTelegramHtml,
  TELEGRAM_MESSAGE_LIMIT,
  truncateTelegramHtml,
} from "../src/core/telegram-format.js";

describe("telegram-format", () => {
  describe("TELEGRAM_MESSAGE_LIMIT", () => {
    test("is 4096", () => {
      expect(TELEGRAM_MESSAGE_LIMIT).toBe(4096);
    });
  });

  describe("markdownToTelegramHtml", () => {
    test("converts **bold** to <b>bold</b>", () => {
      expect(markdownToTelegramHtml("**bold**")).toBe("<b>bold</b>");
      expect(markdownToTelegramHtml("Hello **world**!")).toBe(
        "Hello <b>world</b>!",
      );
    });

    test("converts *italic* to <i>italic</i>", () => {
      expect(markdownToTelegramHtml("*italic*")).toBe("<i>italic</i>");
      expect(markdownToTelegramHtml("Say *hello* there")).toBe(
        "Say <i>hello</i> there",
      );
    });

    test("converts [text](url) to <a href>", () => {
      expect(markdownToTelegramHtml("[link](https://example.com)")).toBe(
        '<a href="https://example.com">link</a>',
      );
      expect(
        markdownToTelegramHtml(
          "[Yahoo Finance](https://finance.yahoo.com/quote/SPY)",
        ),
      ).toBe('<a href="https://finance.yahoo.com/quote/SPY">Yahoo Finance</a>');
    });

    test("converts ### header to <b>header</b>", () => {
      expect(markdownToTelegramHtml("### Key Sources:")).toBe(
        "<b>Key Sources:</b>\n",
      );
      expect(markdownToTelegramHtml("Before\n### Title\nAfter")).toBe(
        "Before\n<b>Title</b>\nAfter",
      );
    });

    test("collapses ### **title** to a single <b> (Telegram forbids nested <b>)", () => {
      expect(markdownToTelegramHtml("### **Bold section**")).toBe(
        "<b>Bold section</b>\n",
      );
    });

    test("wraps (https://...) in <a href> so closing paren is not part of URL", () => {
      expect(
        markdownToTelegramHtml(
          "label (https://www.gov.il/he/service/apply-for-passport)",
        ),
      ).toBe(
        'label (<a href="https://www.gov.il/he/service/apply-for-passport">https://www.gov.il/he/service/apply-for-passport</a>)',
      );
    });

    test("handles ### at end of string", () => {
      expect(markdownToTelegramHtml("### End")).toBe("<b>End</b>\n");
    });

    test("escapes & < > in plain text", () => {
      expect(markdownToTelegramHtml("A & B")).toBe("A &amp; B");
      expect(markdownToTelegramHtml("x < y")).toBe("x &lt; y");
      expect(markdownToTelegramHtml("a > b")).toBe("a &gt; b");
    });

    test("escapes content inside tags", () => {
      expect(markdownToTelegramHtml("**a & b**")).toBe("<b>a &amp; b</b>");
      expect(markdownToTelegramHtml("[x < y](https://a.com)")).toBe(
        '<a href="https://a.com">x &lt; y</a>',
      );
    });

    test("handles combined formatting", () => {
      const input =
        "Here's the latest **SPY** price:\n\n- **$668.78**\n- [Yahoo](https://finance.yahoo.com)";
      const expected =
        'Here\'s the latest <b>SPY</b> price:\n\n- <b>$668.78</b>\n- <a href="https://finance.yahoo.com">Yahoo</a>';
      expect(markdownToTelegramHtml(input)).toBe(expected);
    });

    test("returns original on empty or invalid input", () => {
      expect(markdownToTelegramHtml("")).toBe("");
      expect(markdownToTelegramHtml("plain")).toBe("plain");
    });

    test("does not match * inside ** for italic", () => {
      // *text* should not match when part of **text**
      expect(markdownToTelegramHtml("**bold**")).toBe("<b>bold</b>");
      expect(markdownToTelegramHtml("*only italic*")).toBe(
        "<i>only italic</i>",
      );
    });
  });

  describe("truncateTelegramHtml", () => {
    test("returns short HTML unchanged", () => {
      expect(truncateTelegramHtml("<b>hi</b>", 4096)).toBe("<b>hi</b>");
    });

    test("closes <b> when slice would cut before </b>", () => {
      const inner = "x".repeat(100);
      const html = `<b>${inner}</b>`;
      const cut = inner.length + 3;
      const out = truncateTelegramHtml(html, cut);
      expect(out.endsWith("</b>")).toBe(true);
      expect(out.length).toBeLessThanOrEqual(cut);
    });

    test("strips truncated </b> fragment and re-balances", () => {
      const html = "<b>hello</b>";
      const maxLen = "<b>hello</".length;
      const out = truncateTelegramHtml(html, maxLen);
      expect(out.endsWith("</b>")).toBe(true);
      expect(out.length).toBeLessThanOrEqual(maxLen);
      expect(out.startsWith("<b>")).toBe(true);
    });
  });
});

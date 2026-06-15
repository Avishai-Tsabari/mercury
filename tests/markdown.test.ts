import { describe, expect, test } from "bun:test";
import { normalizeChatMarkdown } from "../src/text/markdown";

describe("normalizeChatMarkdown", () => {
  test("returns empty string unchanged", () => {
    expect(normalizeChatMarkdown("")).toBe("");
  });

  test("plain text is returned unchanged", () => {
    const input = "Hello world, just a normal message.";
    expect(normalizeChatMarkdown(input)).toBe(input);
  });

  test("converts a GFM table to bullet lines", () => {
    const input = [
      "| מצב | מי עדיף |",
      "|---|---|",
      "| הקשר ארוך | SSM |",
    ].join("\n");
    const expected = ["• מצב — מי עדיף", "• הקשר ארוך — SSM"].join("\n");
    expect(normalizeChatMarkdown(input)).toBe(expected);
  });

  test("converts a multi-row table and drops the separator", () => {
    const input = ["| a | b |", "| :-- | --: |", "| 1 | 2 |", "| 3 | 4 |"].join(
      "\n",
    );
    const expected = ["• a — b", "• 1 — 2", "• 3 — 4"].join("\n");
    expect(normalizeChatMarkdown(input)).toBe(expected);
  });

  test("table embedded between prose lines", () => {
    const input = [
      "Summary:",
      "| col1 | col2 |",
      "| --- | --- |",
      "| x | y |",
      "done.",
    ].join("\n");
    const expected = ["Summary:", "• col1 — col2", "• x — y", "done."].join(
      "\n",
    );
    expect(normalizeChatMarkdown(input)).toBe(expected);
  });

  test("horizontal rule --- becomes a blank line", () => {
    const input = "above\n---\nbelow";
    expect(normalizeChatMarkdown(input)).toBe("above\n\nbelow");
  });

  test("*** and ___ rules also collapse", () => {
    expect(normalizeChatMarkdown("a\n***\nb")).toBe("a\n\nb");
    expect(normalizeChatMarkdown("a\n___\nb")).toBe("a\n\nb");
  });

  test("spaced rule '- - -' collapses", () => {
    expect(normalizeChatMarkdown("a\n- - -\nb")).toBe("a\n\nb");
  });

  test("normalizes **bold** to *bold*", () => {
    expect(normalizeChatMarkdown("this is **important** text")).toBe(
      "this is *important* text",
    );
  });

  test("normalizes __bold__ to *bold*", () => {
    expect(normalizeChatMarkdown("this is __important__ text")).toBe(
      "this is *important* text",
    );
  });

  test("leaves single *bold* untouched", () => {
    const input = "already *bold* here";
    expect(normalizeChatMarkdown(input)).toBe(input);
  });

  test("leaves single _italic_ untouched (WhatsApp italic)", () => {
    const input = "this is _italic_ here";
    expect(normalizeChatMarkdown(input)).toBe(input);
  });

  test("collapses ***bold-italic*** to *bold*", () => {
    expect(normalizeChatMarkdown("this is ***strong*** text")).toBe(
      "this is *strong* text",
    );
  });

  test("collapses ___bold-italic___ to *bold*", () => {
    expect(normalizeChatMarkdown("this is ___strong___ text")).toBe(
      "this is *strong* text",
    );
  });

  test("two **bold** spans on one line both normalize", () => {
    expect(normalizeChatMarkdown("**a** and **b**")).toBe("*a* and *b*");
  });

  test("does not touch contents of a fenced code block", () => {
    const input = [
      "```",
      "| not | a | table |",
      "| --- | --- | --- |",
      "---",
      "**keep**",
      "```",
    ].join("\n");
    // Inside a fence everything is passed through verbatim.
    expect(normalizeChatMarkdown(input)).toBe(input);
  });

  test("a lone pipe line with no separator row is left alone (not a table)", () => {
    const input = "use a | b shell pipe here";
    expect(normalizeChatMarkdown(input)).toBe(input);
  });

  test("a single dash line (not 3+) is not a rule", () => {
    const input = "a\n-\nb";
    expect(normalizeChatMarkdown(input)).toBe(input);
  });

  test("combined: table + rule + bold in one message", () => {
    const input = [
      "🔷 *סיכום*",
      "| מצב | מי עדיף |",
      "|---|---|",
      "| הקשר ארוך | SSM |",
      "---",
      "this is **bold**",
    ].join("\n");
    const expected = [
      "🔷 *סיכום*",
      "• מצב — מי עדיף",
      "• הקשר ארוך — SSM",
      "",
      "this is *bold*",
    ].join("\n");
    expect(normalizeChatMarkdown(input)).toBe(expected);
  });
});

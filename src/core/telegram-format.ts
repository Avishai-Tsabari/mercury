/**
 * Convert agent Markdown-style output to Telegram HTML for parse_mode.
 * Order: escape → [text](url) → (https://…) anchors → ### headers → **bold** → *italic* → collapse nested <b>.
 */

export const TELEGRAM_MESSAGE_LIMIT = 4096;

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Telegram HTML rejects nested identical tags (e.g. <b><b>x</b></b>). */
function collapseNestedBold(html: string): string {
  let out = html;
  let prev: string;
  do {
    prev = out;
    out = out.replace(/<b>\s*<b>/g, "<b>").replace(/<\/b>\s*<\/b>/g, "</b>");
  } while (out !== prev);
  return out;
}

function hrefAttr(url: string): string {
  return url.replace(/"/g, "&quot;");
}

/**
 * Wrap (https://...) style URLs so the closing ")" is not part of the link target
 * and Telegram gets a valid <a href>.
 */
function parentheticalUrlsToAnchors(html: string): string {
  return html.replace(
    /\((https?:\/\/[^)\s<]+)\)/g,
    (_, url: string) => `(<a href="${hrefAttr(url)}">${url}</a>)`,
  );
}

type TelegramOpenTag = "b" | "i" | "a";

/** Tags produced by markdownToTelegramHtml (Telegram HTML parse_mode). */
function collectOpenTelegramTags(s: string): TelegramOpenTag[] {
  const stack: TelegramOpenTag[] = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] !== "<") {
      i++;
      continue;
    }
    if (s.startsWith("</b>", i)) {
      if (stack[stack.length - 1] === "b") stack.pop();
      i += 4;
      continue;
    }
    if (s.startsWith("</i>", i)) {
      if (stack[stack.length - 1] === "i") stack.pop();
      i += 4;
      continue;
    }
    if (s.startsWith("</a>", i)) {
      if (stack[stack.length - 1] === "a") stack.pop();
      i += 4;
      continue;
    }
    if (s.startsWith("<b>", i)) {
      stack.push("b");
      i += 3;
      continue;
    }
    if (s.startsWith("<i>", i)) {
      stack.push("i");
      i += 3;
      continue;
    }
    if (s.startsWith('<a href="', i)) {
      const close = s.indexOf('">', i);
      if (close === -1) break;
      stack.push("a");
      i = close + 2;
      continue;
    }
    i++;
  }
  return stack;
}

function closingTagsForStack(stack: TelegramOpenTag[]): string {
  const closers: Record<TelegramOpenTag, string> = {
    b: "</b>",
    i: "</i>",
    a: "</a>",
  };
  let out = "";
  for (let k = stack.length - 1; k >= 0; k--) {
    const tag = stack[k];
    if (tag) out += closers[tag];
  }
  return out;
}

/**
 * Truncate formatted Telegram HTML without splitting tags or leaving them unclosed.
 * Avoids HTTP 400 "can't parse entities" when the raw slice cuts inside `<b>` / `</a>` etc.
 */
export function truncateTelegramHtml(html: string, maxLen: number): string {
  if (html.length <= maxLen) return html;
  if (maxLen <= 0) return "";

  let cut = html.slice(0, maxLen);
  const stripIncompleteTagTail = (s: string): string => {
    const lastLt = s.lastIndexOf("<");
    if (lastLt < 0) return s;
    if (s.indexOf(">", lastLt) === -1) {
      return s.slice(0, lastLt);
    }
    return s;
  };
  cut = stripIncompleteTagTail(cut);

  let suffix = closingTagsForStack(collectOpenTelegramTags(cut));
  while (cut.length + suffix.length > maxLen && cut.length > 0) {
    const over = cut.length + suffix.length - maxLen;
    cut = cut.slice(0, Math.max(0, cut.length - over - 1));
    cut = stripIncompleteTagTail(cut);
    suffix = closingTagsForStack(collectOpenTelegramTags(cut));
  }

  if (cut.length + suffix.length > maxLen) {
    return escapeHtml(html).slice(0, maxLen);
  }
  return cut + suffix;
}

/**
 * Convert Markdown-style text to Telegram HTML.
 * Handles: **bold**, *italic*, [text](url), ### headers, (https://...) URLs.
 * On error, returns original text.
 */
export function markdownToTelegramHtml(text: string): string {
  try {
    if (!text || typeof text !== "string") return text;

    // 1. Escape first so all content is safe; replacements use already-escaped content
    let out = escapeHtml(text);

    // 2. Links [text](url) — url already escaped; only escape " for attr
    out = out.replace(
      /\[([^\]]*)\]\(([^)]*)\)/g,
      (_, linkText, url) => `<a href="${hrefAttr(url)}">${linkText}</a>`,
    );

    // 3. Plain (https://...) after labels — avoids ")" in href when users tap links
    out = parentheticalUrlsToAnchors(out);

    // 4. ### headers — before **bold** so "### **Title**" does not yield nested <b>…</b>
    out = out.replace(
      /(^|\n)###\s+([^\n]+)(\n)?/g,
      (_, prefix, header, nl) => `${prefix}<b>${header}</b>${nl ?? "\n"}`,
    );

    // 5. Bold **text**
    out = out.replace(/\*\*([^*]+)\*\*/g, (_, content) => `<b>${content}</b>`);

    // 6. Italic *text* (not part of **)
    out = out.replace(
      /(?<!\*)\*([^*]+)\*(?!\*)/g,
      (_, content) => `<i>${content}</i>`,
    );

    out = collapseNestedBold(out);

    return out;
  } catch {
    return text;
  }
}

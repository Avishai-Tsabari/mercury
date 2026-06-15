// Outbound markdown normalization for chat platforms (WhatsApp + Telegram plain
// text). WhatsApp and Telegram-without-rich-formatting render only a restricted
// lightweight markup — GitHub-flavored markdown tables, horizontal rules, and
// `**double-star bold**` all leak through as literal characters and look broken
// on mobile. The space `AGENTS.md` bans these in prose, but a prose rule relies
// on the model complying; this turns the ban into a deterministic send-side gate
// (same pattern as `applyRtlDirection`). Apply BEFORE `applyRtlDirection` — this
// rewrites line structure (tables expand to several bullet lines, rules collapse
// to blank lines), and the RLM prefixing must run on the final lines.
//
// Send-side only. Do NOT call from inbound parsing, storage, the console UI, or
// the Telegram rich-HTML path (`markdownToTelegramHtml` owns formatting there;
// normalizing `**`→`*` before it would turn bold into italic).

// A horizontal rule: a line of only `-`, `*`, or `_` (3+), optionally space-
// separated (`---`, `***`, `___`, `- - -`). Table separator rows contain `|` so
// they never match here.
const HR_LINE = /^\s*(?:-\s*){3,}$|^\s*(?:\*\s*){3,}$|^\s*(?:_\s*){3,}$/;

// A markdown table separator row: only `|`, `-`, `:`, and whitespace, and it must
// contain both a pipe and a dash (e.g. `|---|---|`, `| :-- | --: |`).
const TABLE_SEPARATOR = /^\s*\|?[\s:|-]*-[\s:|-]*\|[\s:|-]*$/;

// A line that participates in a table: contains at least one pipe.
const TABLE_ROW = /\|/;

const FENCE = /^\s*```/;

/** Split a markdown table row into trimmed, non-empty cell strings. */
function tableCells(line: string): string[] {
  return line
    .split("|")
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

// Normalize markdown bold/bold-italic delimiters to WhatsApp's single-asterisk
// `*bold*`. Matches runs of 2–3 markers (`**x**`, `***x***`, `__x__`, `___x___`)
// so triple-star bold-italic collapses cleanly rather than leaving a stray `**`.
// The capture forbids the marker char so a match can't span across a separate
// emphasis pair. Single `*x*` / `_x_` (WhatsApp bold / italic) are left intact.
// Note: a `__identifier__` in plain prose (outside a code fence) is also rewritten
// — an acceptable trade-off, as chat replies rarely contain bare code tokens.
function normalizeBold(line: string): string {
  return line
    .replace(/\*{2,3}([^*\n]+?)\*{2,3}/g, "*$1*")
    .replace(/_{2,3}([^_\n]+?)_{2,3}/g, "*$1*");
}

/**
 * Rewrite markdown that does not render on WhatsApp / plain Telegram into the
 * supported lightweight markup:
 * - GFM tables → `•` bullet lines (one per row, cells joined with ` — `)
 * - horizontal rules (`---` / `***` / `___`) → a blank line
 * - `**bold**` / `__bold__` → `*bold*`
 *
 * Fenced code blocks (```` ``` ````) are passed through untouched — WhatsApp
 * renders them as monospace, and their contents are not markdown.
 *
 * No-op on empty input.
 */
export function normalizeChatMarkdown(text: string): string {
  if (!text) return text;

  const lines = text.split("\n");
  const out: string[] = [];
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (FENCE.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }

    // Table block: a row with a pipe immediately followed by a separator row.
    // Requiring the separator row keeps us from mangling prose/code that merely
    // contains a `|` (GFM requires a separator row for a real table).
    if (
      TABLE_ROW.test(line) &&
      i + 1 < lines.length &&
      TABLE_SEPARATOR.test(lines[i + 1])
    ) {
      // Header row → bullet.
      const header = tableCells(line);
      if (header.length > 0) out.push(`• ${header.join(" — ")}`);
      // Skip the separator row, then consume contiguous data rows.
      let j = i + 2;
      while (
        j < lines.length &&
        TABLE_ROW.test(lines[j]) &&
        !TABLE_SEPARATOR.test(lines[j])
      ) {
        const cells = tableCells(lines[j]);
        if (cells.length > 0) out.push(`• ${cells.join(" — ")}`);
        j++;
      }
      i = j - 1;
      continue;
    }

    if (HR_LINE.test(line)) {
      out.push("");
      continue;
    }

    out.push(normalizeBold(line));
  }

  return out.join("\n");
}

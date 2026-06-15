// U+200F RIGHT-TO-LEFT MARK. Invisible bidi control that forces RTL paragraph
// direction in WhatsApp, Telegram, and any client implementing the Unicode Bidi
// Algorithm. Per-line application matches the empirically-proven n8n/Telegram
// pattern: each newline-separated line is treated as its own bidi paragraph.
const RLM = "‏";

// `\p{Bidi_Class=R/AL}` is NOT supported by V8 (Bun 1.3.10 throws SyntaxError at
// parse time). `\p{Script=...}` is supported and covers every commonly-used RTL
// script including all of Arabic's extension/supplement/presentation-form blocks
// via the Unicode Script property.
const HAS_RTL =
  /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Mandaic}\p{Script=Samaritan}]/u;

// Strip leading RLM (U+200F), LRE (U+202A), and RLE (U+202B). The existing
// `whatsapp-formatting` skill prepends RLE; leaving it in place under our RLM
// would nest two bidi controls and behave unpredictably on older Android clients.
const LEADING_BIDI_CTRL = /^[‏‪‫]+/;

/**
 * Force correct RTL paragraph alignment for outbound chat messages.
 *
 * If `text` contains any RTL strong character (Hebrew, Arabic and all its blocks,
 * Syriac, Thaana, N'Ko, Mandaic, Samaritan), prefix every line with exactly one
 * U+200F. Idempotent: any pre-existing leading run of bidi controls on a line is
 * stripped first.
 *
 * No-op on purely LTR input — returned byte-identical.
 *
 * Send-side only. Do NOT call from inbound message parsing, storage, or any
 * console UI render path.
 */
export function applyRtlDirection(text: string): string {
  if (!text || !HAS_RTL.test(text)) return text;
  return text
    .split("\n")
    .map((line) => RLM + line.replace(LEADING_BIDI_CTRL, ""))
    .join("\n");
}

/** BCP-47 locales supported for default voices. */
export type TtsLanguage = "he-IL" | "en-US";

export type TtsLanguageInput = "auto" | TtsLanguage;

const HEBREW_RE = /\p{Script=Hebrew}/u;

/**
 * Resolve `auto` using Hebrew script detection; otherwise pass through.
 */
export function resolveTtsLanguageFromText(
  text: string,
  input: TtsLanguageInput | undefined,
): TtsLanguage {
  const mode = input ?? "auto";
  if (mode === "auto") {
    return HEBREW_RE.test(text) ? "he-IL" : "en-US";
  }
  return mode;
}

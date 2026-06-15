/** Escape text for XML element bodies. */
export function escapeXmlText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeXmlAttr(s: string): string {
  return escapeXmlText(s).replace(/"/g, "&quot;");
}

/** Build `<preferences>...</preferences>` block for the agent user prompt, or null if empty. */
export function formatPreferencesXml(
  preferences?: Array<{ key: string; value: string }>,
): string | null {
  if (!preferences?.length) return null;
  const lines = preferences.map(
    (p) =>
      `  <pref key="${escapeXmlAttr(p.key)}">${escapeXmlText(p.value)}</pref>`,
  );
  return ["<preferences>", ...lines, "</preferences>"].join("\n");
}

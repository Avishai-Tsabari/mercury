/**
 * Bundled extension catalog for dashboard install. Sources live under
 * `examples/extensions/<sourceDir>/` in the mercury-agent package (or repo).
 */
export type ExtensionCatalogCategory =
  | "browsing"
  | "automation"
  | "knowledge"
  | "voice"
  | "code"
  | "other";

export interface ExtensionCatalogEntry {
  /** Installed directory name under `.mercury/extensions/` */
  name: string;
  label: string;
  description: string;
  category: ExtensionCatalogCategory;
  /** Subdirectory of `examples/extensions/` to copy from */
  sourceDir: string;
  requiredEnvVars?: string[];
  requiresRestart: boolean;
}

export const EXTENSION_CATALOG: ExtensionCatalogEntry[] = [
  {
    name: "web-browser",
    label: "Web browsing & automation",
    description:
      "Web search (Brave) and interactive browser (pinchtab) for sites like Gmail, banks, and forms.",
    category: "automation",
    sourceDir: "pinchtab",
    requiredEnvVars: ["MERCURY_BRAVE_API_KEY"],
    requiresRestart: true,
  },
  {
    name: "napkin",
    label: "Knowledge vault",
    description:
      "Obsidian-style vault, napkin CLI, and optional KB distillation job.",
    category: "knowledge",
    sourceDir: "napkin",
    requiresRestart: true,
  },
  {
    name: "charts",
    label: "Charts",
    description: "Minimal charts CLI extension example.",
    category: "other",
    sourceDir: "charts",
    requiresRestart: true,
  },
  {
    name: "pdf",
    label: "PDF tools",
    description: "PDF form filling and scripts (see extension skill).",
    category: "other",
    sourceDir: "pdf",
    requiresRestart: true,
  },
  {
    name: "gws",
    label: "Google Workspace",
    description: "Google Workspace integration (see extension skill).",
    category: "other",
    sourceDir: "gws",
    requiresRestart: true,
  },
  {
    name: "voice-transcribe",
    label: "Voice transcription",
    description:
      "Transcribe voice with local Python (Transformers or Faster-Whisper) or Hugging Face Inference API.",
    category: "voice",
    sourceDir: "voice-transcribe",
    requiresRestart: true,
  },
  {
    name: "voice-synth",
    label: "Voice synthesis (TTS)",
    description:
      "Google or Azure cloud TTS for English/Hebrew; mrctl tts synthesize and optional auto voice per space. Set Azure key+region and/or Google credentials path on the host.",
    category: "voice",
    sourceDir: "voice-synth",
    requiresRestart: true,
  },
  {
    name: "tradestation",
    label: "TradeStation",
    description:
      "TradeStation API v3 (accounts, balances, positions, bars, host-gated orders via mrctl) with OAuth refresh; admin-only by default.",
    category: "other",
    sourceDir: "tradestation",
    requiredEnvVars: [
      "MERCURY_TS_CLIENT_ID",
      "MERCURY_TS_CLIENT_SECRET",
      "MERCURY_TRADESTATION_REFRESH_TOKEN",
    ],
    requiresRestart: true,
  },
  {
    name: "yahoo-mail",
    label: "Yahoo Mail",
    description:
      "Read, search, and send Yahoo Mail via IMAP/SMTP with an app-specific password.",
    category: "other",
    sourceDir: "yahoo-mail",
    requiredEnvVars: ["MERCURY_YAHOO_EMAIL", "MERCURY_YAHOO_APP_PASSWORD"],
    requiresRestart: true,
  },
];

export function getCatalogEntryByName(
  name: string,
): ExtensionCatalogEntry | undefined {
  return EXTENSION_CATALOG.find((e) => e.name === name);
}

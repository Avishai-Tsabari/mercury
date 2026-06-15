import { existsSync } from "node:fs";
import { resolveProjectPath } from "../config.js";
import { synthesizeAzure } from "./azure.js";
import { synthesizeGoogle } from "./google.js";
import {
  resolveTtsLanguageFromText,
  type TtsLanguageInput,
} from "./language.js";

export class TtsConfigError extends Error {
  readonly code: "not_configured";

  constructor(message: string) {
    super(message);
    this.name = "TtsConfigError";
    this.code = "not_configured";
  }
}

/** Subset of AppConfig used by TTS (extensions import via `mercury-ai/tts`). */
export interface MercuryTtsConfig {
  ttsProvider: "google" | "azure" | "auto";
  azureSpeechKey?: string;
  azureSpeechRegion?: string;
  googleApplicationCredentials?: string;
  ttsMaxChars: number;
}

export interface TtsSynthesizeOptions {
  text: string;
  language?: TtsLanguageInput;
  providerOverride?: "google" | "azure" | "auto";
}

export interface TtsSynthesizeResult {
  buffer: Buffer;
  mimeType: string;
  filename: string;
}

function hasGoogleCredentials(config: MercuryTtsConfig): boolean {
  const p = config.googleApplicationCredentials?.trim();
  if (!p) return false;
  try {
    return existsSync(resolveProjectPath(p));
  } catch {
    return false;
  }
}

function hasAzure(config: MercuryTtsConfig): boolean {
  return Boolean(
    config.azureSpeechKey?.trim() && config.azureSpeechRegion?.trim(),
  );
}

function resolveEffectiveBackend(
  config: MercuryTtsConfig,
  override?: "google" | "azure" | "auto",
): "google" | "azure" {
  const mode = override ?? config.ttsProvider;

  if (mode === "google") {
    if (!hasGoogleCredentials(config)) {
      throw new TtsConfigError(
        "Google TTS selected but MERCURY_GOOGLE_APPLICATION_CREDENTIALS / GOOGLE_APPLICATION_CREDENTIALS file is missing or not found",
      );
    }
    return "google";
  }
  if (mode === "azure") {
    if (!hasAzure(config)) {
      throw new TtsConfigError(
        "Azure TTS selected but MERCURY_AZURE_SPEECH_KEY or MERCURY_AZURE_SPEECH_REGION is missing",
      );
    }
    return "azure";
  }

  if (hasGoogleCredentials(config)) return "google";
  if (hasAzure(config)) return "azure";

  throw new TtsConfigError(
    "No TTS provider configured: set Google service account path or Azure key+region",
  );
}

/**
 * Synthesize speech using host credentials. Intended for `/api/tts` and voice-synth extension.
 */
export async function synthesizeSpeech(
  config: MercuryTtsConfig,
  opts: TtsSynthesizeOptions,
): Promise<TtsSynthesizeResult> {
  const trimmed = opts.text.trim();
  if (!trimmed) {
    throw new Error("TTS text is empty");
  }

  const max = Math.min(10_000, Math.max(500, config.ttsMaxChars));
  if (trimmed.length > max) {
    throw new Error(`TTS text exceeds max length (${max} characters)`);
  }

  const language = resolveTtsLanguageFromText(trimmed, opts.language);
  const backend = resolveEffectiveBackend(config, opts.providerOverride);

  let buffer: Buffer;
  if (backend === "azure") {
    buffer = await synthesizeAzure({
      key: config.azureSpeechKey as string,
      region: config.azureSpeechRegion as string,
      text: trimmed,
      language,
    });
  } else {
    const credPath = resolveProjectPath(
      config.googleApplicationCredentials?.trim() ?? "",
    );
    buffer = await synthesizeGoogle({
      credentialsPath: credPath,
      text: trimmed,
      language,
    });
  }

  return {
    buffer,
    mimeType: "audio/mpeg",
    filename:
      language === "he-IL" ? "mercury-tts-he.mp3" : "mercury-tts-en.mp3",
  };
}

import type { TtsLanguage } from "./language.js";

const AZURE_VOICES: Record<TtsLanguage, string> = {
  "he-IL": "he-IL-HilaNeural",
  "en-US": "en-US-JennyNeural",
};

/** MP3 128 kbps mono 16 kHz — widely compatible for chat attachments. */
const OUTPUT_FORMAT = "audio-16khz-128kbitrate-mono-mp3";

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export async function synthesizeAzure(opts: {
  key: string;
  region: string;
  text: string;
  language: TtsLanguage;
}): Promise<Buffer> {
  const voiceName = AZURE_VOICES[opts.language];
  const ssml = `<?xml version="1.0" encoding="UTF-8"?>
<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${opts.language}">
  <voice name="${voiceName}">${escapeXml(opts.text)}</voice>
</speak>`;

  const url = `https://${opts.region.trim()}.tts.speech.microsoft.com/cognitiveservices/v1`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/ssml+xml",
      "X-Microsoft-OutputFormat": OUTPUT_FORMAT,
      "Ocp-Apim-Subscription-Key": opts.key.trim(),
      "User-Agent": "mercury-ai-tts",
    },
    body: ssml,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(
      `Azure TTS HTTP ${res.status}: ${errText.slice(0, 500) || res.statusText}`,
    );
  }

  return Buffer.from(await res.arrayBuffer());
}

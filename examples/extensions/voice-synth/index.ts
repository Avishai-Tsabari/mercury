import { mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
  MercuryExtensionAPI,
  MercuryExtensionContext,
} from "mercury-ai/extensions/types";
import type { MercuryTtsConfig } from "mercury-ai/tts";
import { synthesizeSpeech } from "mercury-ai/tts";
import type { EgressFile } from "mercury-ai/types";

const EXT = "voice-synth";

/** Prefer `voice-synth.mode`; fall back to legacy `voice-synth.auto`. */
function readVoiceSynthMode(
  ctx: MercuryExtensionContext,
  spaceId: string,
): "on_demand" | "auto" {
  const mode = ctx.db.getSpaceConfig(spaceId, `${EXT}.mode`);
  if (mode === "auto" || mode === "on_demand") return mode;
  const legacy = ctx.db.getSpaceConfig(spaceId, `${EXT}.auto`);
  return legacy === "true" ? "auto" : "on_demand";
}

function toTtsConfig(ctx: MercuryExtensionContext): MercuryTtsConfig {
  const c = ctx.config;
  return {
    ttsProvider: c.ttsProvider,
    azureSpeechKey: c.azureSpeechKey,
    azureSpeechRegion: c.azureSpeechRegion,
    googleApplicationCredentials: c.googleApplicationCredentials,
    ttsMaxChars: c.ttsMaxChars,
  };
}

export default function setup(mercury: MercuryExtensionAPI) {
  mercury.config("mode", {
    description:
      "on_demand: TTS only when the agent runs `mrctl tts synthesize` (default). auto: attach a TTS MP3 to every assistant reply.",
    default: "on_demand",
    validate: (v) => v === "on_demand" || v === "auto",
  });

  mercury.config("auto", {
    description:
      "Legacy: prefer voice-synth.mode. Used only when mode is unset; true equals mode=auto.",
    default: "false",
    validate: (v) => v === "true" || v === "false",
  });

  mercury.skill("./skill");

  mercury.on("after_container", async (event, ctx) => {
    if (readVoiceSynthMode(ctx, event.spaceId) !== "auto") return undefined;
    if (!event.reply?.trim()) return undefined;
    if (event.error) return undefined;

    if (
      !ctx.hasCallerPermission(event.spaceId, event.callerId, "tts.synthesize")
    ) {
      ctx.log.warn("voice-synth.auto skipped: caller lacks tts.synthesize", {
        extension: EXT,
        spaceId: event.spaceId,
      });
      return undefined;
    }

    const outDir = path.join(event.workspace, "outbox");
    mkdirSync(outDir, { recursive: true });
    const filename = `tts-${Date.now()}.mp3`;
    const absPath = path.join(outDir, filename);

    try {
      const { buffer } = await synthesizeSpeech(toTtsConfig(ctx), {
        text: event.reply,
        language: "auto",
      });
      writeFileSync(absPath, buffer);
      const st = statSync(absPath);
      const file: EgressFile = {
        path: absPath,
        filename,
        mimeType: "audio/mpeg",
        sizeBytes: st.size,
      };
      return { files: [file] };
    } catch (e) {
      ctx.log.error("voice-synth TTS failed", {
        extension: EXT,
        error: e instanceof Error ? e.message : String(e),
      });
      return undefined;
    }
  });
}

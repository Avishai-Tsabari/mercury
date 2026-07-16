import { execFile as execFileCb } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

const EXT = "voice-transcribe";
const DEFAULT_MODEL = "mike249/whisper-tiny-he-2";
const DEFAULT_PROVIDER = "local";
const DEFAULT_LOCAL_ENGINE = "transformers";
/** Classic HF Inference API (serverless). */
const HF_INFERENCE_BASE = "https://api-inference.huggingface.co/models";
/** OpenAI-compatible /audio/transcriptions root; override via base_url for Groq etc. */
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
/** Sensible model when provider=openai and the configured model is not an OpenAI/Groq one. */
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini-transcribe";
const GEMINI_API_BASE =
  "https://generativelanguage.googleapis.com/v1beta/models";
/** Sensible model when provider=gemini and the configured model is not a Gemini one. */
const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
const PROVIDERS = ["local", "api", "openai", "gemini"] as const;
type Provider = (typeof PROVIDERS)[number];

const SCRIPT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "scripts",
  "transcribe.py",
);

type Attachment = { path: string; type: string; mimeType: string };

function parseTranscriptionJson(raw: string): string {
  try {
    const data = JSON.parse(raw) as unknown;
    if (typeof data === "object" && data !== null && "text" in data) {
      const t = (data as { text: unknown }).text;
      if (typeof t === "string") return t.trim();
    }
    if (Array.isArray(data) && data.length > 0) {
      const first = data[0] as { text?: string };
      if (typeof first?.text === "string") return first.text.trim();
    }
  } catch {
    /* ignore */
  }
  return "";
}

async function transcribeWithApi(
  filePath: string,
  mimeType: string,
  modelId: string,
  token: string,
): Promise<string> {
  const body = await readFile(filePath);
  const url = `${HF_INFERENCE_BASE}/${encodeURIComponent(modelId)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type":
        mimeType.split(";")[0].trim() || "application/octet-stream",
    },
    body,
  });
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`HF inference ${res.status}: ${raw.slice(0, 240)}`);
  }
  return parseTranscriptionJson(raw);
}

/**
 * OpenAI-compatible transcription (OpenAI, Groq, or any host implementing
 * `POST {base}/audio/transcriptions`).
 */
async function transcribeWithOpenAi(
  filePath: string,
  mimeType: string,
  modelId: string,
  baseUrl: string,
  language: string,
  token: string,
): Promise<string> {
  const body = await readFile(filePath);
  const form = new FormData();
  form.append(
    "file",
    new Blob([body], { type: mimeType.split(";")[0].trim() || "audio/ogg" }),
    path.basename(filePath) || "audio.ogg",
  );
  form.append("model", modelId);
  form.append("response_format", "json");
  if (language) form.append("language", language);

  const url = `${baseUrl.replace(/\/+$/, "")}/audio/transcriptions`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`OpenAI-compatible STT ${res.status}: ${raw.slice(0, 240)}`);
  }
  return parseTranscriptionJson(raw);
}

/** Gemini audio understanding via generateContent (API key, no GCP project). */
async function transcribeWithGemini(
  filePath: string,
  mimeType: string,
  modelId: string,
  language: string,
  apiKey: string,
): Promise<string> {
  const body = await readFile(filePath);
  const langHint = language ? ` The audio language is "${language}".` : "";
  const url = `${GEMINI_API_BASE}/${encodeURIComponent(modelId)}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "x-goog-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            {
              text: `Transcribe this audio verbatim.${langHint} Output only the transcript text, nothing else.`,
            },
            {
              inline_data: {
                mime_type: mimeType.split(";")[0].trim() || "audio/ogg",
                data: body.toString("base64"),
              },
            },
          ],
        },
      ],
    }),
  });
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`Gemini STT ${res.status}: ${raw.slice(0, 240)}`);
  }
  try {
    const data = JSON.parse(raw) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    return parts
      .map((p) => p.text ?? "")
      .join("")
      .trim();
  } catch {
    return "";
  }
}

function parseLastJsonLine(stdout: string): {
  text?: string;
  error?: string;
} {
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  const line = lines[lines.length - 1] ?? "";
  try {
    return JSON.parse(line) as { text?: string; error?: string };
  } catch {
    return {};
  }
}

function execFileStdout(e: unknown): string {
  if (!e || typeof e !== "object" || !("stdout" in e)) return "";
  const v = (e as { stdout?: Buffer | string }).stdout;
  return Buffer.isBuffer(v) ? v.toString("utf8") : String(v ?? "");
}

/** Best-effort parse of `execFile` failures (non-zero exit, timeout kill, etc.). */
function describeLocalTranscribeExecError(
  e: unknown,
  timeoutMs: number,
): { message: string; meta: Record<string, unknown> } {
  const fallback = e instanceof Error ? e.message : String(e);
  if (!e || typeof e !== "object") {
    return { message: fallback, meta: {} };
  }
  const o = e as Record<string, unknown>;
  const stderr = Buffer.isBuffer(o.stderr)
    ? o.stderr.toString("utf8")
    : String(o.stderr ?? "");
  const stdout = Buffer.isBuffer(o.stdout)
    ? o.stdout.toString("utf8")
    : String(o.stdout ?? "");
  const stderrTail = stderr.trim().slice(-1200);
  const stdoutTail = stdout.trim().slice(-600);
  const code =
    typeof o.code === "number"
      ? o.code
      : typeof o.code === "string"
        ? o.code
        : undefined;
  const killed = o.killed === true;
  const signal = typeof o.signal === "string" ? o.signal : undefined;
  const errno = e as NodeJS.ErrnoException;
  const errnoCode = typeof errno.code === "string" ? errno.code : undefined;
  const msgLower = fallback.toLowerCase();

  const looksTimedOut =
    killed ||
    errnoCode === "ETIMEDOUT" ||
    msgLower.includes("etimedout") ||
    msgLower.includes("timed out");

  if (looksTimedOut) {
    return {
      message: `Local transcribe exceeded timeout (${timeoutMs}ms). First run often downloads the HF model — raise MERCURY_VOICE_TRANSCRIBE_TIMEOUT_MS, warm-cache the model, or use provider=api.`,
      meta: {
        reason: "timeout",
        timeoutMs,
        signal,
        stderrTail: stderrTail || undefined,
        stdoutTail: stdoutTail || undefined,
      },
    };
  }

  return {
    message: fallback,
    meta: {
      reason: "exec_failed",
      exitCode: typeof code === "number" ? code : undefined,
      exitCodeString: typeof code === "string" ? code : undefined,
      signal,
      stderrTail: stderrTail || undefined,
      stdoutTail: stdoutTail || undefined,
    },
  };
}

async function transcribeWithLocal(
  scriptPath: string,
  audioPath: string,
  modelId: string,
  localEngine: string,
  pythonBin: string,
  timeoutMs: number,
): Promise<string> {
  const opts = {
    timeout: timeoutMs,
    maxBuffer: 50 * 1024 * 1024,
    windowsHide: true,
    env: {
      ...process.env,
      PYTHONUNBUFFERED: "1",
    },
  };
  try {
    const { stdout } = await execFile(
      pythonBin,
      [
        scriptPath,
        "--audio",
        audioPath,
        "--model",
        modelId,
        "--local-engine",
        localEngine,
      ],
      opts,
    );
    const data = parseLastJsonLine(stdout);
    if (data.error) throw new Error(data.error);
    return (data.text ?? "").trim();
  } catch (e) {
    const fromStdout = parseLastJsonLine(execFileStdout(e));
    if (fromStdout.error) throw new Error(fromStdout.error);
    if (fromStdout.text !== undefined && !fromStdout.error) {
      return (fromStdout.text ?? "").trim();
    }
    throw e;
  }
}

function resolveHostPath(workspace: string, attPath: string): string {
  return path.isAbsolute(attPath) ? attPath : path.join(workspace, attPath);
}

function defaultPython(): string {
  const fromEnv = process.env.MERCURY_VOICE_PYTHON?.trim();
  if (fromEnv) return fromEnv;
  return process.platform === "win32" ? "python" : "python3";
}

function localTimeoutMs(): number {
  const raw = process.env.MERCURY_VOICE_TRANSCRIBE_TIMEOUT_MS?.trim();
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (!Number.isNaN(n) && n > 0) return n;
  }
  return 300_000;
}

type HookCtx = {
  db: { getSpaceConfig: (spaceId: string, key: string) => string | null };
  log: {
    info: (msg: string, extra?: unknown) => void;
    warn: (msg: string, extra?: unknown) => void;
    error: (msg: string, extra?: unknown) => void;
  };
  hasCallerPermission: (
    spaceId: string,
    callerId: string,
    permission: string,
  ) => boolean;
  /** Host-resolved config (space → @global → mercury.yaml → default). Optional for older hosts. */
  getConfig?: (spaceId: string, key: string) => string | null;
};

/** Resolve a config value via ctx.getConfig when the host supports it. */
function readConfig(ctx: HookCtx, spaceId: string, key: string): string {
  const resolved = ctx.getConfig
    ? ctx.getConfig(spaceId, `${EXT}.${key}`)
    : ctx.db.getSpaceConfig(spaceId, `${EXT}.${key}`);
  return resolved?.trim() ?? "";
}

export default function (mercury: {
  permission(opts: { defaultRoles: string[] }): void;
  env(def: { from: string; hostOnly?: boolean }): void;
  config(
    key: string,
    def: {
      description: string;
      default: string;
      validate?: (v: string) => boolean;
    },
  ): void;
  skill(relativePath: string): void;
  on(
    event: "before_container",
    handler: (
      event: {
        spaceId: string;
        prompt: string;
        callerId: string;
        workspace: string;
        containerWorkspace: string;
        attachments?: Attachment[];
      },
      ctx: HookCtx,
    ) => Promise<{ promptAppend?: string } | undefined>,
  ): void;
}) {
  mercury.permission({ defaultRoles: ["admin", "member"] });
  // All STT keys are consumed host-side in before_container — never inject
  // them into agent containers (customers in DM auto-spaces hold the
  // voice-transcribe permission).
  mercury.env({ from: "MERCURY_HF_TOKEN", hostOnly: true });
  // NOTE: MERCURY_GEMINI_API_KEY (model-chain key) is intentionally not
  // reused — claiming it hostOnly would strip GEMINI_API_KEY from containers
  // whose model chain runs on Gemini.
  mercury.env({ from: "MERCURY_STT_API_KEY", hostOnly: true });
  mercury.env({ from: "MERCURY_STT_GEMINI_API_KEY", hostOnly: true });
  mercury.config("provider", {
    description:
      '"local" = Python+transformers on Mercury host (see skill); "api" = Hugging Face Inference API (MERCURY_HF_TOKEN); "openai" = OpenAI-compatible /audio/transcriptions incl. Groq (MERCURY_STT_API_KEY, see base_url); "gemini" = Google Gemini audio (MERCURY_STT_GEMINI_API_KEY)',
    default: DEFAULT_PROVIDER,
    validate: (v) => (PROVIDERS as readonly string[]).includes(v),
  });
  mercury.config("model", {
    description:
      "Model id per provider: HF id for local/api (e.g. mike249/whisper-tiny-he-2), e.g. gpt-4o-mini-transcribe or whisper-large-v3 for openai, gemini-2.5-flash for gemini",
    default: DEFAULT_MODEL,
  });
  mercury.config("local_engine", {
    description:
      'local ASR only: "transformers" (default) or "faster_whisper" (CTranslate2 / Hugging Face CT2 repos, e.g. ivrit-ai/*-ct2)',
    default: DEFAULT_LOCAL_ENGINE,
    validate: (v) => v === "transformers" || v === "faster_whisper",
  });
  mercury.config("base_url", {
    description:
      "openai provider only: API root implementing /audio/transcriptions (default OpenAI; use https://api.groq.com/openai/v1 for Groq)",
    default: DEFAULT_OPENAI_BASE_URL,
    validate: (v) => /^https:\/\//.test(v),
  });
  mercury.config("language", {
    description:
      'ISO-639-1 hint passed to cloud STT (e.g. "he"). Improves accuracy on short voice notes. Empty = auto-detect.',
    default: "",
  });
  mercury.skill("./skill");

  mercury.on("before_container", async (event, ctx) => {
    if (!ctx.hasCallerPermission(event.spaceId, event.callerId, EXT)) {
      return undefined;
    }

    const atts = event.attachments?.filter(
      (a) => a.type === "voice" || a.type === "audio",
    );
    if (!atts?.length) return undefined;

    const providerRaw = readConfig(ctx, event.spaceId, "provider");
    const provider: Provider = (PROVIDERS as readonly string[]).includes(
      providerRaw,
    )
      ? (providerRaw as Provider)
      : DEFAULT_PROVIDER;
    const model = readConfig(ctx, event.spaceId, "model") || DEFAULT_MODEL;
    const rawLocalEngine = readConfig(ctx, event.spaceId, "local_engine");
    const localEngine =
      rawLocalEngine === "faster_whisper" || rawLocalEngine === "transformers"
        ? rawLocalEngine
        : DEFAULT_LOCAL_ENGINE;
    const baseUrl =
      readConfig(ctx, event.spaceId, "base_url") || DEFAULT_OPENAI_BASE_URL;
    const language = readConfig(ctx, event.spaceId, "language");

    let token: string | undefined;
    if (provider === "api") {
      token = process.env.MERCURY_HF_TOKEN?.trim();
      if (!token) {
        ctx.log.warn(
          "MERCURY_HF_TOKEN not set; skipping voice transcription (api provider)",
          { extension: EXT },
        );
        return undefined;
      }
    } else if (provider === "openai") {
      token = process.env.MERCURY_STT_API_KEY?.trim();
      if (!token) {
        ctx.log.warn(
          "MERCURY_STT_API_KEY not set; skipping voice transcription (openai provider)",
          { extension: EXT },
        );
        return undefined;
      }
    } else if (provider === "gemini") {
      token = process.env.MERCURY_STT_GEMINI_API_KEY?.trim();
      if (!token) {
        ctx.log.warn(
          "MERCURY_STT_GEMINI_API_KEY not set; skipping voice transcription (gemini provider)",
          { extension: EXT },
        );
        return undefined;
      }
    } else if (provider === "local") {
      if (!existsSync(SCRIPT_PATH)) {
        ctx.log.error("Local transcribe script missing", {
          extension: EXT,
          scriptPath: SCRIPT_PATH,
        });
        return undefined;
      }
    }

    // The registered `model` default is an HF id for local/api. When the
    // provider is cloud and the model was never changed from that default,
    // use a provider-native model instead of sending the HF id upstream.
    const cloudModel =
      model !== DEFAULT_MODEL
        ? model
        : provider === "openai"
          ? DEFAULT_OPENAI_MODEL
          : provider === "gemini"
            ? DEFAULT_GEMINI_MODEL
            : model;

    const lines: string[] = [];
    const timeoutMs = localTimeoutMs();
    const pythonBin = defaultPython();

    for (const att of atts) {
      const hostPath = resolveHostPath(event.workspace, att.path);
      try {
        let text: string;
        if (provider === "api") {
          text = await transcribeWithApi(
            hostPath,
            att.mimeType,
            model,
            token as string,
          );
        } else if (provider === "openai") {
          text = await transcribeWithOpenAi(
            hostPath,
            att.mimeType,
            cloudModel,
            baseUrl,
            language,
            token as string,
          );
        } else if (provider === "gemini") {
          text = await transcribeWithGemini(
            hostPath,
            att.mimeType,
            cloudModel,
            language,
            token as string,
          );
        } else {
          ctx.log.info("Voice transcription starting (local)", {
            extension: EXT,
            path: hostPath,
            model,
            localEngine,
            timeoutMs,
            pythonBin,
          });
          text = await transcribeWithLocal(
            SCRIPT_PATH,
            hostPath,
            model,
            localEngine,
            pythonBin,
            timeoutMs,
          );
        }
        if (text) lines.push(text);
      } catch (e) {
        if (provider === "local") {
          const { message, meta } = describeLocalTranscribeExecError(
            e,
            timeoutMs,
          );
          ctx.log.error("Voice transcription failed", {
            extension: EXT,
            path: hostPath,
            provider,
            model,
            localEngine,
            error: message,
            ...meta,
          });
        } else {
          ctx.log.error("Voice transcription failed", {
            extension: EXT,
            path: hostPath,
            provider,
            model,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }

    if (lines.length === 0) return undefined;

    return {
      promptAppend: `[Voice transcript]\n${lines.join("\n")}`,
    };
  });
}

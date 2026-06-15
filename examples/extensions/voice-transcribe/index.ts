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

export default function (mercury: {
  permission(opts: { defaultRoles: string[] }): void;
  env(def: { from: string }): void;
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
      ctx: {
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
      },
    ) => Promise<{ promptAppend?: string } | undefined>,
  ): void;
}) {
  mercury.permission({ defaultRoles: ["admin", "member"] });
  mercury.env({ from: "MERCURY_HF_TOKEN" });
  mercury.config("provider", {
    description:
      '"local" = Python+transformers on Mercury host (see skill); "api" = Hugging Face Inference API (needs MERCURY_HF_TOKEN)',
    default: DEFAULT_PROVIDER,
    validate: (v) => v === "local" || v === "api",
  });
  mercury.config("model", {
    description:
      "Hugging Face model id (e.g. mike249/whisper-tiny-he-2 for local Hebrew; openai/whisper-large-v3 for api)",
    default: DEFAULT_MODEL,
  });
  mercury.config("local_engine", {
    description:
      'local ASR only: "transformers" (default) or "faster_whisper" (CTranslate2 / Hugging Face CT2 repos, e.g. ivrit-ai/*-ct2)',
    default: DEFAULT_LOCAL_ENGINE,
    validate: (v) => v === "transformers" || v === "faster_whisper",
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

    const provider =
      ctx.db.getSpaceConfig(event.spaceId, `${EXT}.provider`)?.trim() ||
      DEFAULT_PROVIDER;
    const model =
      ctx.db.getSpaceConfig(event.spaceId, `${EXT}.model`)?.trim() ||
      DEFAULT_MODEL;
    const rawLocalEngine = ctx.db
      .getSpaceConfig(event.spaceId, `${EXT}.local_engine`)
      ?.trim();
    const localEngine =
      rawLocalEngine === "faster_whisper" || rawLocalEngine === "transformers"
        ? rawLocalEngine
        : DEFAULT_LOCAL_ENGINE;

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
    } else if (provider === "local") {
      if (!existsSync(SCRIPT_PATH)) {
        ctx.log.error("Local transcribe script missing", {
          extension: EXT,
          scriptPath: SCRIPT_PATH,
        });
        return undefined;
      }
    }

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

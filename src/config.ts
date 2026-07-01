import path from "node:path";
import { z } from "zod";
import {
  type ModelCapabilities,
  parseModelCapabilitiesEnv,
  resolveModelChainCapabilities,
} from "./agent/model-capabilities.js";
import { mergeRawMercuryConfig } from "./config-file.js";
import { parseModelLegsArray } from "./config-model-chain.js";

/** One model leg in the ordered fallback chain (primary first). */
export type ModelLeg = { provider: string; model: string };

function parseModelChainJson(raw: string): ModelLeg[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("MERCURY_MODEL_CHAIN must be valid JSON array");
  }
  return parseModelLegsArray(parsed, "MERCURY_MODEL_CHAIN");
}

function resolveModelChain(base: {
  modelChain: string | undefined;
  modelProvider: string;
  model: string;
  modelFallbackProvider: string | undefined;
  modelFallback: string | undefined;
}): ModelLeg[] {
  const trimmed = base.modelChain?.trim();
  if (trimmed) {
    return parseModelChainJson(trimmed);
  }
  const legs: ModelLeg[] = [
    { provider: base.modelProvider, model: base.model },
  ];
  const fp = base.modelFallbackProvider?.trim();
  const fm = base.modelFallback?.trim();
  if (fp && fm) {
    legs.push({ provider: fp, model: fm });
  }
  return legs;
}

/** Parse boolean from env var strings — case-insensitive "true"/"1" → true, everything else → false */
const booleanFromEnv = z.union([z.boolean(), z.string()]).transform((val) => {
  if (typeof val === "boolean") return val;
  const lower = val.toLowerCase();
  return lower === "true" || lower === "1";
});

const schema = z.object({
  // ─── API Key Mode ───────────────────────────────────────────────────
  apiKeyMode: z.enum(["platform", "byok"]).default("platform"),

  // ─── Logging ────────────────────────────────────────────────────────
  logLevel: z
    .enum(["debug", "info", "warn", "error", "silent"])
    .default("info"),
  logFormat: z.enum(["text", "json"]).default("text"),

  // ─── AI Model ───────────────────────────────────────────────────────
  modelProvider: z.string().default("anthropic"),
  model: z.string().default("claude-opus-4-6"),
  modelFallbackProvider: z.string().optional(),
  modelFallback: z.string().optional(),
  /** JSON array of `{ provider, model }`. When set, overrides legacy primary+fallback pair. */
  modelChain: z.string().optional(),
  /** Extra attempts after the first failure on the same leg (retryable errors only). Default 2 => 3 tries max per leg. */
  modelMaxRetriesPerLeg: z.coerce.number().int().min(0).max(5).default(2),
  /** Wall-clock budget for the whole chain (ms). Clamped below container timeout. Default 120s. */
  modelChainBudgetMs: z.coerce
    .number()
    .int()
    .min(5000)
    .max(55 * 60 * 1000)
    .default(120_000),
  /**
   * Optional JSON object overriding model capabilities for all chain legs, e.g.
   * `{"tools":false,"vision":true}`. Highest priority over YAML and built-in map.
   */
  modelCapabilitiesEnv: z.string().optional(),

  // ─── Trigger Behavior ───────────────────────────────────────────────
  triggerPatterns: z.string().default("@Mercury,Mercury"),
  triggerMatch: z.string().default("mention"),

  // ─── Context Behavior ───────────────────────────────────────────────
  /** Default context mode seeded into the `main` space on first boot. */
  contextMode: z.enum(["clear", "context"]).default("context"),
  /** Default sliding-window turn count for `context` mode (1–50). Seeded into `main` on first boot. */
  contextWindowSize: z.coerce.number().int().min(1).max(50).default(10),
  /** Default reply-chain depth for `clear` mode (1–50). Seeded into `main` on first boot. */
  contextReplyChainDepth: z.coerce.number().int().min(1).max(50).default(10),

  // ─── Storage ────────────────────────────────────────────────────────
  dataDir: z.string().default(".mercury"),
  /** Max disk usage in MB for the agent's data directory. Unset = no enforcement (local/self-hosted). */
  maxDiskMb: z.coerce.number().int().min(0).optional(),

  // ─── Storage Lifecycle ─────────────────────────────────────────────
  /** Days before inbox files are auto-deleted. */
  inboxTtlDays: z.coerce.number().min(1).max(365).default(7),
  /** Days before outbox files are auto-deleted. */
  outboxTtlDays: z.coerce.number().min(1).max(365).default(3),
  /** Interval in ms between storage cleanup runs. Default 1 hour. */
  cleanupIntervalMs: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(86_400_000)
    .default(3_600_000),
  authPath: z.string().optional(),
  /** WhatsApp Baileys auth directory; default `<dataDir>/whatsapp-auth`. */
  whatsappAuthDir: z.string().optional(),

  // ─── Container / Agent ──────────────────────────────────────────────
  agentContainerImage: z
    .string()
    .default("ghcr.io/avishai-tsabari/mercury-agent:latest"),
  containerTimeoutMs: z.coerce
    .number()
    .int()
    .min(10_000)
    .max(60 * 60 * 1000)
    .default(5 * 60 * 1000), // 5 minutes
  /**
   * OCI runtime for inner (pi) containers.
   * - "runc" (default): standard Docker runtime; uses bubblewrap inside the container for sandboxing.
   * - "runsc": gVisor runtime — intercepts syscalls at a user-space kernel boundary.
   *   Stronger isolation than bwrap; restores full Docker hardening (no SYS_ADMIN relaxation needed).
   *   Requires gVisor installed on the compute node (auto-installed by cloud-init on provisioned nodes).
   */
  containerRuntime: z.enum(["runc", "runsc"]).default("runc"),
  /**
   * @deprecated Use MERCURY_CONTAINER_RUNTIME=runsc instead.
   * When true, `docker run` uses looser outer sandbox so bubblewrap can nest (e.g. Docker Desktop).
   * Ignored when containerRuntime is "runsc". See docs/container-lifecycle.md.
   */
  containerBwrapDockerCompat: booleanFromEnv.default(false),
  /**
   * Docker network to attach inner (pi) containers to. When set, inner containers join this
   * network and can reach the Mercury host container by its container name rather than via
   * host.docker.internal. Required on Linux where host.docker.internal is not available.
   * Set via MERCURY_CONTAINER_NETWORK (e.g. "mercury-net").
   */
  containerNetwork: z.string().optional(),
  /**
   * Hostname (and optional port) that inner containers use to reach the Mercury host API.
   * When set, overrides the default "host.docker.internal" in the API_URL passed to mrctl.
   * Set via MERCURY_CONTAINER_API_HOST (e.g. "mercury-agent-<uuid>").
   */
  containerApiHost: z.string().optional(),
  maxConcurrency: z.coerce.number().int().min(1).max(32).default(2),
  /**
   * When true, Mercury uses `--system-prompt` instead of `--append-system-prompt` when invoking pi,
   * making Mercury the sole author of the system prompt. The prompt includes accurate tool snippets
   * and Mercury identity without any pi-specific references.
   * Default: false (append mode, preserves existing behaviour).
   */
  overridePiSystemPrompt: booleanFromEnv.default(false),

  // ─── Rate Limiting ──────────────────────────────────────────────────
  rateLimitPerUser: z.coerce.number().int().min(1).max(1000).default(10),
  rateLimitWindowMs: z.coerce
    .number()
    .int()
    .min(1000)
    .max(60 * 60 * 1000)
    .default(60 * 1000), // 1 minute
  rateLimitDailyMember: z.coerce.number().int().min(0).max(10000).default(0),
  rateLimitDailyAdmin: z.coerce.number().int().min(0).max(10000).default(0),

  // ─── Server ─────────────────────────────────────────────────────────
  port: z.coerce.number().int().min(1).max(65535).default(8787),
  botUsername: z.string().default("mercury"),

  // ─── Discord ────────────────────────────────────────────────────────
  enableDiscord: booleanFromEnv.default(false),
  discordGatewayDurationMs: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(60 * 60 * 1000)
    .default(10 * 60 * 1000),
  discordGatewaySecret: z.string().optional(),

  // ─── Slack ──────────────────────────────────────────────────────────
  enableSlack: booleanFromEnv.default(false),

  // ─── Teams ───────────────────────────────────────────────────────────
  enableTeams: booleanFromEnv.default(false),

  // ─── WhatsApp ───────────────────────────────────────────────────────
  enableWhatsApp: booleanFromEnv.default(false),

  // ─── Telegram ───────────────────────────────────────────────────────
  enableTelegram: booleanFromEnv.default(false),
  /** When true, convert Markdown to Telegram HTML for formatted replies. */
  telegramFormatEnabled: booleanFromEnv.default(true),

  // ─── Media Handling ─────────────────────────────────────────────────
  mediaEnabled: booleanFromEnv.default(true),
  mediaMaxSizeMb: z.coerce.number().min(1).max(100).default(10),

  // ─── Permissions ────────────────────────────────────────────────────
  admins: z.string().default(""),

  // ─── Security ─────────────────────────────────────────────────────
  /** Shared secret for API authentication. Required for /api/* routes. */
  apiSecret: z.string().optional(),
  /** Optional API key for the /chat endpoint. When unset, /chat is open (for local use). */
  chatApiKey: z.string().optional(),
  /**
   * URL of the Mercury Cloud Console managing this agent (e.g. "https://console.mercury.app").
   * When set, the dashboard keys page redirects users to the Console instead of allowing
   * direct key edits — the Console is the single source of truth for API keys.
   * Env-only; not settable from mercury.yaml.
   */
  consoleUrl: z.string().url().optional(),
  /** User ID in the Mercury Cloud Console — used for per-message quota checks. Env-only. */
  consoleUserId: z.string().optional(),
  /** Shared secret for calling console internal API endpoints. Env-only. */
  consoleInternalSecret: z.string().optional(),

  // ─── Scheduling ─────────────────────────────────────────────────────
  /** IANA timezone used when a scheduled task is created without an explicit --timezone flag (e.g. "Asia/Jerusalem"). */
  defaultTimezone: z.string().optional(),

  // ─── TradeStation (host order API) ────────────────────────────────
  /**
   * When false (default), POST /api/tradestation/orders rejects non-SIM accounts.
   * Set true only when you intentionally allow live brokerage orders from the assistant flow.
   */
  tsAllowLiveOrders: booleanFromEnv.default(false),

  // ─── Cloud TTS (host-only; /api/tts, optional voice-synth extension) ───
  /** `google` | `azure` | `auto` — auto picks Google if credentials file set, else Azure if key+region set. */
  ttsProvider: z.enum(["google", "azure", "auto"]).default("auto"),
  /** Azure Speech resource key (secret; env-only). */
  azureSpeechKey: z.string().optional(),
  /** Azure region, e.g. `eastus`. */
  azureSpeechRegion: z.string().optional(),
  /**
   * Path to GCP service account JSON for Text-to-Speech.
   * Also accepts standard `GOOGLE_APPLICATION_CREDENTIALS` via mergeRawMercuryConfig.
   */
  googleApplicationCredentials: z.string().optional(),
  /** Max input characters per /api/tts request (clamped 500–10000). */
  ttsMaxChars: z.coerce.number().int().min(500).max(10_000).default(5000),

  // ─── DM Auto-Space ─────────────────────────────────────────────────
  dmAutoSpaceEnabled: booleanFromEnv.default(false),
  dmAutoSpaceAdminIds: z.string().default(""),
  dmAutoSpaceDefaultSystemPrompt: z.string().default(""),
  dmAutoSpaceDefaultMemberPermissions: z.string().default("prompt,prefs.get"),
});

export type AppConfig = z.infer<typeof schema> & {
  /** Derived paths from dataDir */
  dbPath: string;
  globalDir: string;
  spacesDir: string;
  whatsappAuthDir: string;
  /** Ordered model legs (primary first), max 20. */
  resolvedModelChain: ModelLeg[];
  /** Parsed MERCURY_MODEL_CAPABILITIES override, if valid. */
  parsedModelCapabilitiesEnv: ModelCapabilities | null;
  /** Capabilities per chain leg (same order as resolvedModelChain). */
  resolvedModelChainCapabilities: ModelCapabilities[];
  /** Effective budget after clamping to container timeout. */
  effectiveModelChainBudgetMs: number;
};

export function loadConfig(): AppConfig {
  const raw = mergeRawMercuryConfig(process.env);
  const base = schema.parse(raw);

  const dataDir = base.dataDir;

  const resolvedModelChain = resolveModelChain({
    modelChain: base.modelChain,
    modelProvider: base.modelProvider,
    model: base.model,
    modelFallbackProvider: base.modelFallbackProvider,
    modelFallback: base.modelFallback,
  });

  const dataDirAbsolute = resolveProjectPath(base.dataDir);
  const parsedModelCapabilitiesEnv = parseModelCapabilitiesEnv(
    base.modelCapabilitiesEnv,
  );
  const { chainCaps: resolvedModelChainCapabilities } =
    resolveModelChainCapabilities(
      resolvedModelChain,
      dataDirAbsolute,
      parsedModelCapabilitiesEnv,
    );

  const slackMs = 10_000;
  const effectiveModelChainBudgetMs = Math.min(
    base.modelChainBudgetMs,
    Math.max(5000, base.containerTimeoutMs - slackMs),
  );

  return {
    ...base,
    dbPath: path.join(dataDir, "state.db"),
    globalDir: path.join(dataDir, "global"),
    spacesDir: path.join(dataDir, "spaces"),
    whatsappAuthDir:
      base.whatsappAuthDir ?? path.join(dataDir, "whatsapp-auth"),
    resolvedModelChain,
    parsedModelCapabilitiesEnv,
    resolvedModelChainCapabilities,
    effectiveModelChainBudgetMs,
  };
}

export function resolveProjectPath(p: string): string {
  if (path.isAbsolute(p)) return p;
  return path.join(process.cwd(), p);
}

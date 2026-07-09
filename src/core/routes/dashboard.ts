import { existsSync } from "node:fs";
import path from "node:path";
import { getModels, type KnownProvider } from "@earendil-works/pi-ai";
import { Hono } from "hono";
import { html, raw } from "hono/html";
import { streamSSE } from "hono/streaming";
import type { AppConfig } from "../../config.js";
import {
  EXTENSION_CATALOG,
  getCatalogEntryByName,
} from "../../extensions/catalog.js";
import type { ConfigRegistry } from "../../extensions/config-registry.js";
import {
  installExtensionFromDirectory,
  removeInstalledExtension,
  resolveExamplesExtensionDir,
} from "../../extensions/installer.js";
import type { ExtensionRegistry } from "../../extensions/loader.js";
import type { MercuryExtensionContext } from "../../extensions/types.js";
import type { MessageRunMeta } from "../../types.js";
import { parseMuteDuration } from "../mute-duration.js";
import type { MercuryCoreRuntime } from "../runtime.js";
import { loadTriggerConfig } from "../trigger.js";
import {
  BUILTIN_CONFIG_DESCRIPTIONS,
  BUILTIN_CONFIG_KEYS,
  isBuiltinConfigKey,
  validateDashboardBuiltinConfig,
} from "./config-builtin.js";
import { updateDotEnv } from "./console.js";
import { validatePrefKey, validatePrefValue } from "./prefs.js";

const VOICE_TRANSCRIBE_EXT = "voice-transcribe";
const VT_KEY = {
  provider: `${VOICE_TRANSCRIBE_EXT}.provider`,
  local_engine: `${VOICE_TRANSCRIBE_EXT}.local_engine`,
  model: `${VOICE_TRANSCRIBE_EXT}.model`,
} as const;

const VOICE_SYNTH_EXT = "voice-synth";
const VS_KEY = {
  mode: `${VOICE_SYNTH_EXT}.mode`,
  auto: `${VOICE_SYNTH_EXT}.auto`,
} as const;

type VoiceTranscribePreset = {
  id: string;
  label: string;
  provider: string;
  local_engine: string;
  model: string;
};

/** Curated STT setups (must stay consistent with voice-transcribe extension skill). */
const VOICE_TRANSCRIBE_PRESETS: VoiceTranscribePreset[] = [
  {
    id: "he_tiny_tf",
    label: "Hebrew tiny (Transformers, local)",
    provider: "local",
    local_engine: "transformers",
    model: "mike249/whisper-tiny-he-2",
  },
  {
    id: "he_ivrit_fw",
    label: "Hebrew Faster-Whisper v2 d4 (local)",
    provider: "local",
    local_engine: "faster_whisper",
    model: "ivrit-ai/faster-whisper-v2-d4",
  },
  {
    id: "api_whisper_large",
    label: "Whisper Large v3 (Hugging Face Inference API)",
    provider: "api",
    local_engine: "transformers",
    model: "openai/whisper-large-v3",
  },
];

const VOICE_CUSTOM_MODEL_MAX_LEN = 200;

interface DashboardContext {
  core: MercuryCoreRuntime;
  adapters: Record<string, boolean>;
  startTime: number;
  registry?: ExtensionRegistry;
  extensionCtx?: MercuryExtensionContext;
  /** When set, enables voice-transcribe dashboard panel if extension keys are registered. */
  configRegistry?: ConfigRegistry;
  projectRoot: string;
  packageRoot: string;
}

type HealthStatus = "healthy" | "degraded" | "critical";

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function createDashboardRoutes(ctx: DashboardContext) {
  const {
    core,
    adapters,
    startTime,
    registry,
    extensionCtx,
    configRegistry,
    projectRoot,
    packageRoot,
  } = ctx;
  const app = new Hono();

  const MODEL_PROVIDERS: {
    id: string;
    label: string;
    envVar: string;
    placeholder: string;
    defaultModel: string;
  }[] = [
    {
      id: "anthropic",
      label: "Anthropic",
      envVar: "MERCURY_ANTHROPIC_API_KEY",
      placeholder: "sk-ant-...",
      defaultModel: "claude-sonnet-4-6",
    },
    {
      id: "openai",
      label: "OpenAI",
      envVar: "MERCURY_OPENAI_API_KEY",
      placeholder: "sk-...",
      defaultModel: "gpt-4o",
    },
    {
      id: "google",
      label: "Google Gemini",
      envVar: "MERCURY_GEMINI_API_KEY",
      placeholder: "AIza...",
      defaultModel: "gemini-2.5-flash",
    },
    {
      id: "deepseek",
      label: "DeepSeek",
      envVar: "MERCURY_DEEPSEEK_API_KEY",
      placeholder: "sk-...",
      defaultModel: "deepseek-v4-flash",
    },
    {
      id: "groq",
      label: "Groq",
      envVar: "MERCURY_GROQ_API_KEY",
      placeholder: "gsk_...",
      defaultModel: "llama-3.3-70b-versatile",
    },
    {
      id: "mistral",
      label: "Mistral",
      envVar: "MERCURY_MISTRAL_API_KEY",
      placeholder: "...",
      defaultModel: "mistral-large-latest",
    },
    {
      id: "openrouter",
      label: "OpenRouter",
      envVar: "MERCURY_OPENROUTER_API_KEY",
      placeholder: "sk-or-...",
      defaultModel: "meta-llama/llama-3.3-70b-instruct",
    },
    {
      id: "xai",
      label: "xAI (Grok)",
      envVar: "MERCURY_XAI_API_KEY",
      placeholder: "xai-...",
      defaultModel: "grok-2-latest",
    },
    {
      id: "cerebras",
      label: "Cerebras",
      envVar: "MERCURY_CEREBRAS_API_KEY",
      placeholder: "csk-...",
      defaultModel: "llama3.1-8b",
    },
    {
      id: "google-vertex",
      label: "Google Vertex AI",
      envVar: "MERCURY_GOOGLE_CLOUD_API_KEY",
      placeholder: "AIza...",
      defaultModel: "gemini-2.0-flash",
    },
    {
      id: "amazon-bedrock",
      label: "Amazon Bedrock",
      envVar: "MERCURY_AWS_BEARER_TOKEN_BEDROCK",
      placeholder: "...",
      defaultModel: "amazon.nova-lite-v1:0",
    },
    {
      id: "huggingface",
      label: "HuggingFace",
      envVar: "MERCURY_HF_TOKEN",
      placeholder: "hf_...",
      defaultModel: "Qwen/Qwen3-235B-A22B-Thinking-2507",
    },
    {
      id: "azure-openai-responses",
      label: "Azure OpenAI",
      envVar: "MERCURY_AZURE_OPENAI_API_KEY",
      placeholder: "...",
      defaultModel: "gpt-4o",
    },
    {
      id: "vercel-ai-gateway",
      label: "Vercel AI Gateway",
      envVar: "MERCURY_AI_GATEWAY_API_KEY",
      placeholder: "...",
      defaultModel: "alibaba/qwen-3-235b",
    },
    {
      id: "minimax",
      label: "MiniMax",
      envVar: "MERCURY_MINIMAX_API_KEY",
      placeholder: "...",
      defaultModel: "MiniMax-M2.7",
    },
    {
      id: "minimax-cn",
      label: "MiniMax (China)",
      envVar: "MERCURY_MINIMAX_CN_API_KEY",
      placeholder: "...",
      defaultModel: "MiniMax-M2.7",
    },
    {
      id: "zai",
      label: "ZAI",
      envVar: "MERCURY_ZAI_API_KEY",
      placeholder: "...",
      defaultModel: "glm-4.5",
    },
    {
      id: "kimi-coding",
      label: "Kimi (Moonshot)",
      envVar: "MERCURY_KIMI_API_KEY",
      placeholder: "...",
      defaultModel: "k2p5",
    },
    {
      id: "github-copilot",
      label: "GitHub Copilot",
      envVar: "MERCURY_GITHUB_COPILOT_OAUTH_TOKEN",
      placeholder: "",
      defaultModel: "claude-sonnet-4-6",
    },
  ];

  // ─── Helpers ────────────────────────────────────────────────────────────

  function formatUptime(seconds: number): string {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;

    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  function formatRelativeTime(timestamp: number): string {
    const now = Date.now();
    const diff = now - timestamp;
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ago`;
    if (hours > 0) return `${hours}h ago`;
    if (minutes > 0) return `${minutes}m ago`;
    if (seconds > 10) return `${seconds}s ago`;
    return "just now";
  }

  function formatFutureTime(timestamp: number): string {
    const now = Date.now();
    const diff = timestamp - now;
    if (diff < 0) return "now";

    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `in ${days}d`;
    if (hours > 0) return `in ${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `in ${minutes}m`;
    return `in ${seconds}s`;
  }

  function escapeHtml(str: string): string {
    if (!str) return "";
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatUserRunMetaHtml(meta: MessageRunMeta | undefined): string {
    if (!meta) return "";
    const parts: string[] = [];
    const a = meta.agent;
    if (a) {
      const up =
        a.inputTokens != null ? `↑${formatTokenCount(a.inputTokens)}` : "";
      const down =
        a.outputTokens != null ? `↓${formatTokenCount(a.outputTokens)}` : "";
      const tok = [up, down].filter(Boolean).join(" ");
      if (tok) {
        parts.push(`<span class="mono muted">agent ${escapeHtml(tok)}</span>`);
      }
    }
    if (parts.length === 0) return "";
    return `<div class="message-run-meta" style="font-size:11px;margin-top:6px;display:flex;flex-wrap:wrap;gap:8px;align-items:center;line-height:1.4">${parts.join("")}</div>`;
  }

  function truncate(str: string, len = 40): string {
    if (!str) return "—";
    return str.length > len ? `${str.slice(0, len)}...` : str;
  }

  const PALETTE_SIZE = 8;

  function spaceSwatchClass(
    spaceId: string,
    knownSpaceIds: Set<string>,
  ): string {
    if (!spaceId || !knownSpaceIds.has(spaceId)) return "space-badge-unknown";
    let hash = 0;
    for (let i = 0; i < spaceId.length; i++) {
      hash = (hash * 31 + spaceId.charCodeAt(i)) >>> 0;
    }
    return `space-badge-${hash % PALETTE_SIZE}`;
  }

  function renderTriggersAmbientPanel(
    spaceId: string,
    spacePageReload: string,
  ): string {
    const cfg = core.config;
    const defaultPatterns = cfg.triggerPatterns
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const tc = loadTriggerConfig(core.db, spaceId, {
      patterns: defaultPatterns,
      match: cfg.triggerMatch,
    });
    const ambientOn =
      core.db.getSpaceConfig(spaceId, "ambient.enabled") !== "false";

    const hasOverride = (key: string) =>
      core.db.getSpaceConfig(spaceId, key) !== null;

    const resetBtn = (key: string) =>
      hasOverride(key)
        ? `<button type="button" class="btn btn-sm" title="Use project default"
             hx-delete="/dashboard/api/space-config?spaceId=${encodeURIComponent(spaceId)}&key=${encodeURIComponent(key)}"
             hx-swap="none"
             hx-on::after-request="${spacePageReload}">Reset</button>`
        : "";

    const sid = escapeHtml(spaceId);

    const row = (label: string, key: string, bodyHtml: string) => {
      const desc = BUILTIN_CONFIG_DESCRIPTIONS[key];
      const titleAttr = desc ? ` title="${escapeHtml(desc)}"` : "";
      return `<div class="role-row" style="flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:10px">
      <span style="min-width:160px;font-weight:500"${titleAttr}>${escapeHtml(label)}</span>
      ${bodyHtml}
      ${resetBtn(key)}
    </div>`;
    };

    const matchForm = `
      <form style="display:flex;gap:8px;align-items:center;flex:1;flex-wrap:wrap" class="trigger-cfg-form"
            hx-post="/dashboard/api/space-config" hx-swap="none" hx-on::after-request="${spacePageReload}">
        <input type="hidden" name="spaceId" value="${sid}" />
        <input type="hidden" name="key" value="trigger.match" />
        <select name="value" class="select" required>
          <option value="mention"${tc.match === "mention" ? " selected" : ""}>mention</option>
          <option value="prefix"${tc.match === "prefix" ? " selected" : ""}>prefix</option>
          <option value="always"${tc.match === "always" ? " selected" : ""}>always</option>
        </select>
        <button type="submit" class="btn btn-sm">Save</button>
      </form>`;

    const patternsVal = escapeHtml(tc.patterns.join(", "));
    const patternsForm = `
      <form style="display:flex;gap:8px;align-items:center;flex:1;flex-wrap:wrap" class="trigger-cfg-form"
            hx-post="/dashboard/api/space-config" hx-swap="none" hx-on::after-request="${spacePageReload}">
        <input type="hidden" name="spaceId" value="${sid}" />
        <input type="hidden" name="key" value="trigger.patterns" />
        <input type="text" name="value" class="select" value="${patternsVal}" placeholder="@Name,Name" style="min-width:200px;flex:1" />
        <button type="submit" class="btn btn-sm">Save</button>
      </form>`;

    const boolSelect = (k: string, on: boolean) => `
      <form style="display:flex;gap:8px;align-items:center;flex:1;flex-wrap:wrap" class="trigger-cfg-form"
            hx-post="/dashboard/api/space-config" hx-swap="none" hx-on::after-request="${spacePageReload}">
        <input type="hidden" name="spaceId" value="${sid}" />
        <input type="hidden" name="key" value="${escapeHtml(k)}" />
        <select name="value" class="select" required>
          <option value="true"${on ? " selected" : ""}>true</option>
          <option value="false"${!on ? " selected" : ""}>false</option>
        </select>
        <button type="submit" class="btn btn-sm">Save</button>
      </form>`;

    return `
      <p class="muted" style="margin-bottom:10px;line-height:1.5">
        <strong>Project default</strong> (from env / mercury.yaml):
        <span class="mono">match=${escapeHtml(cfg.triggerMatch)}</span>,
        patterns <span class="mono">${escapeHtml(cfg.triggerPatterns)}</span>.
        Ambient context is on unless this space sets <span class="mono">ambient.enabled</span> to <span class="mono">false</span>.
      </p>
      <p class="muted" style="margin-bottom:16px;line-height:1.5;font-size:0.92em">
        <strong>Effective</strong> for this space:
        <span class="mono">match=${escapeHtml(tc.match)}</span>,
        patterns <span class="mono">${escapeHtml(tc.patterns.join(", "))}</span>,
        <span class="mono">case_sensitive=${tc.caseSensitive}</span>,
        <span class="mono">media_in_groups=${tc.mediaInGroups}</span>,
        <span class="mono">ambient=${ambientOn}</span>
      </p>
      ${row("trigger.match", "trigger.match", matchForm)}
      ${row("trigger.patterns", "trigger.patterns", patternsForm)}
      ${row("trigger.case_sensitive", "trigger.case_sensitive", boolSelect("trigger.case_sensitive", tc.caseSensitive))}
      ${row("trigger.media_in_groups", "trigger.media_in_groups", boolSelect("trigger.media_in_groups", tc.mediaInGroups))}
      ${row("ambient.enabled", "ambient.enabled", boolSelect("ambient.enabled", ambientOn))}
    `;
  }

  function renderContextPanel(
    spaceId: string,
    spacePageReload: string,
  ): string {
    const contextMode =
      core.db.getSpaceConfig(spaceId, "context.mode") ?? "clear";
    const windowSizeStr =
      core.db.getSpaceConfig(spaceId, "context.window_size") ?? "10";
    const chainDepthStr =
      core.db.getSpaceConfig(spaceId, "context.reply_chain_depth") ?? "10";

    const hasOverride = (key: string) =>
      core.db.getSpaceConfig(spaceId, key) !== null;

    const resetBtn = (key: string) =>
      hasOverride(key)
        ? `<button type="button" class="btn btn-sm" title="Use default"
             hx-delete="/dashboard/api/space-config?spaceId=${encodeURIComponent(spaceId)}&key=${encodeURIComponent(key)}"
             hx-swap="none"
             hx-on::after-request="${spacePageReload}">Reset</button>`
        : "";

    const sid = escapeHtml(spaceId);

    const row = (label: string, key: string, bodyHtml: string) => {
      const desc = BUILTIN_CONFIG_DESCRIPTIONS[key];
      const titleAttr = desc ? ` title="${escapeHtml(desc)}"` : "";
      return `<div class="role-row" style="flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:10px">
      <span style="min-width:160px;font-weight:500"${titleAttr}>${escapeHtml(label)}</span>
      ${bodyHtml}
      ${resetBtn(key)}
    </div>`;
    };

    const modeForm = `
      <form style="display:flex;gap:8px;align-items:center;flex:1;flex-wrap:wrap" class="trigger-cfg-form"
            hx-post="/dashboard/api/space-config" hx-swap="none" hx-on::after-request="${spacePageReload}">
        <input type="hidden" name="spaceId" value="${sid}" />
        <input type="hidden" name="key" value="context.mode" />
        <select name="value" class="select" required>
          <option value="clear"${contextMode === "clear" ? " selected" : ""}>clear</option>
          <option value="context"${contextMode === "context" ? " selected" : ""}>context</option>
        </select>
        <button type="submit" class="btn btn-sm">Save</button>
      </form>`;

    const windowSizeForm = `
      <form style="display:flex;gap:8px;align-items:center;flex:1;flex-wrap:wrap" class="trigger-cfg-form"
            hx-post="/dashboard/api/space-config" hx-swap="none" hx-on::after-request="${spacePageReload}">
        <input type="hidden" name="spaceId" value="${sid}" />
        <input type="hidden" name="key" value="context.window_size" />
        <input type="number" name="value" class="select" value="${escapeHtml(windowSizeStr)}" min="1" max="50" required style="width:80px" />
        <button type="submit" class="btn btn-sm">Save</button>
      </form>`;

    const depthForm = `
      <form style="display:flex;gap:8px;align-items:center;flex:1;flex-wrap:wrap" class="trigger-cfg-form"
            hx-post="/dashboard/api/space-config" hx-swap="none" hx-on::after-request="${spacePageReload}">
        <input type="hidden" name="spaceId" value="${sid}" />
        <input type="hidden" name="key" value="context.reply_chain_depth" />
        <input type="number" name="value" class="select" value="${escapeHtml(chainDepthStr)}" min="1" max="50" required style="width:80px" />
        <button type="submit" class="btn btn-sm">Save</button>
      </form>`;

    return `
      <p class="muted" style="margin-bottom:10px;line-height:1.5">
        <strong>clear</strong> = each message starts fresh; reply to bot for chain context.
        <strong>context</strong> = sliding window of recent turns.
      </p>
      <p class="muted" style="margin-bottom:16px;line-height:1.5;font-size:0.92em">
        <strong>Effective</strong> for this space:
        <span class="mono">mode=${escapeHtml(contextMode)}</span>,
        <span class="mono">window_size=${escapeHtml(windowSizeStr)}</span>,
        <span class="mono">reply_chain_depth=${escapeHtml(chainDepthStr)}</span>
      </p>
      ${row("context.mode", "context.mode", modeForm)}
      ${row("context.window_size", "context.window_size", windowSizeForm)}
      ${row("context.reply_chain_depth", "context.reply_chain_depth", depthForm)}
    `;
  }

  function renderRateLimitPanel(
    spaceId: string,
    spacePageReload: string,
  ): string {
    const cfg = core.config;
    const burstRaw = core.db.getSpaceConfig(spaceId, "rate_limit");
    const memberRaw = core.db.getSpaceConfig(spaceId, "rate_limit.member");
    const adminRaw = core.db.getSpaceConfig(spaceId, "rate_limit.admin");

    const isSeeded = (key: string) =>
      core.db.getSpaceConfig(spaceId, key) !== null &&
      core.db.getSpaceConfigUpdatedBy(spaceId, key) === "dm-auto-space";

    const effectiveBurst = burstRaw ?? String(cfg.rateLimitPerUser);
    const effectiveMember =
      memberRaw && !isSeeded("rate_limit.member")
        ? memberRaw
        : cfg.rateLimitDailyMember > 0
          ? String(cfg.rateLimitDailyMember)
          : "0";
    const effectiveAdmin =
      adminRaw && !isSeeded("rate_limit.admin")
        ? adminRaw
        : cfg.rateLimitDailyAdmin > 0
          ? String(cfg.rateLimitDailyAdmin)
          : "0";

    const hasOverride = (key: string) =>
      core.db.getSpaceConfig(spaceId, key) !== null && !isSeeded(key);

    const resetBtn = (key: string) =>
      hasOverride(key)
        ? `<button type="button" class="btn btn-sm" title="Use project default"
             hx-delete="/dashboard/api/space-config?spaceId=${encodeURIComponent(spaceId)}&key=${encodeURIComponent(key)}"
             hx-swap="none"
             hx-on::after-request="${spacePageReload}">Reset</button>`
        : "";

    const sid = escapeHtml(spaceId);

    const numRow = (label: string, key: string, value: string) => {
      const desc = BUILTIN_CONFIG_DESCRIPTIONS[key];
      const titleAttr = desc ? ` title="${escapeHtml(desc)}"` : "";
      return `<div class="role-row" style="flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:10px">
      <span style="min-width:160px;font-weight:500"${titleAttr}>${escapeHtml(label)}</span>
      <form style="display:flex;gap:8px;align-items:center;flex:1;flex-wrap:wrap" class="trigger-cfg-form"
            hx-post="/dashboard/api/space-config" hx-swap="none" hx-on::after-request="${spacePageReload}">
        <input type="hidden" name="spaceId" value="${sid}" />
        <input type="hidden" name="key" value="${escapeHtml(key)}" />
        <input type="number" name="value" class="select" value="${escapeHtml(value)}" min="0" required style="width:80px" />
        <button type="submit" class="btn btn-sm">Save</button>
      </form>
      ${resetBtn(key)}
    </div>`;
    };

    return `
      <p class="muted" style="margin-bottom:10px;line-height:1.5">
        <strong>Project default</strong> (from env / mercury.yaml):
        burst <span class="mono">${cfg.rateLimitPerUser}/min</span>,
        daily member <span class="mono">${cfg.rateLimitDailyMember === 0 ? "unlimited" : String(cfg.rateLimitDailyMember)}</span>,
        daily admin <span class="mono">${cfg.rateLimitDailyAdmin === 0 ? "unlimited" : String(cfg.rateLimitDailyAdmin)}</span>.
      </p>
      <p class="muted" style="margin-bottom:16px;line-height:1.5;font-size:0.92em">
        <strong>Effective</strong> for this space:
        burst <span class="mono">${escapeHtml(effectiveBurst)}/min</span>,
        daily member <span class="mono">${effectiveMember === "0" ? "unlimited" : escapeHtml(effectiveMember)}/day</span>,
        daily admin <span class="mono">${effectiveAdmin === "0" ? "unlimited" : escapeHtml(effectiveAdmin)}/day</span>
      </p>
      ${numRow("rate_limit", "rate_limit", effectiveBurst)}
      ${numRow("rate_limit.member", "rate_limit.member", effectiveMember)}
      ${numRow("rate_limit.admin", "rate_limit.admin", effectiveAdmin)}
    `;
  }

  function renderModelBlock(cfg: AppConfig): string {
    const legs = cfg.resolvedModelChain;
    if (legs.length === 0) {
      return '<p class="muted">No model chain configured.</p>';
    }
    return legs
      .map((leg, i) => {
        const label = i === 0 ? "Primary" : `Fallback ${i}`;
        return `<div style="margin-bottom:6px"><span class="muted">${label}:</span> <span class="mono">${escapeHtml(leg.provider)}</span> / <span class="mono">${escapeHtml(leg.model)}</span></div>`;
      })
      .join("");
  }

  function renderFeaturesToast(
    kind: "success" | "error",
    message: string,
  ): string {
    const border =
      kind === "success"
        ? "border-color: var(--color-success)"
        : "border-color: var(--color-error)";
    return `<div class="features-toast" style="padding:10px 12px;border-radius:6px;margin-bottom:12px;border:1px solid var(--border);${border}">${escapeHtml(message)}</div>`;
  }

  function getSystemHealth(): {
    status: HealthStatus;
    message: string;
    lastError: string | null;
  } {
    const adapterEntries = Object.entries(adapters);
    const disconnected = adapterEntries.filter(([, connected]) => !connected);
    const queueBacklog = core.queue.pendingCount > 10;

    // TODO: Track actual errors in the system
    const lastError = null;

    if (
      disconnected.length === adapterEntries.length &&
      adapterEntries.length > 0
    ) {
      return {
        status: "critical",
        message: "All adapters disconnected",
        lastError,
      };
    }

    if (queueBacklog) {
      return {
        status: "critical",
        message: `Queue backing up (${core.queue.pendingCount} pending)`,
        lastError,
      };
    }

    if (disconnected.length > 0) {
      return {
        status: "degraded",
        message: `${disconnected.map(([n]) => n).join(", ")} disconnected`,
        lastError,
      };
    }

    return {
      status: "healthy",
      message: "All systems operational",
      lastError,
    };
  }

  function voiceTranscribePanelHtml(spaceId: string): string {
    const reg = configRegistry;
    if (!reg?.isValidKey(VT_KEY.model)) return "";

    const defP = reg.get(VT_KEY.provider)?.default ?? "local";
    const defL = reg.get(VT_KEY.local_engine)?.default ?? "transformers";
    const defM = reg.get(VT_KEY.model)?.default ?? "";

    const effProvider =
      core.db.getSpaceConfig(spaceId, VT_KEY.provider)?.trim() ?? defP;
    const effLocalEngine =
      core.db.getSpaceConfig(spaceId, VT_KEY.local_engine)?.trim() ?? defL;
    const effModel =
      core.db.getSpaceConfig(spaceId, VT_KEY.model)?.trim() ?? defM;

    const matched = VOICE_TRANSCRIBE_PRESETS.find(
      (p) =>
        p.provider === effProvider &&
        p.local_engine === effLocalEngine &&
        p.model === effModel,
    );
    const selectedPreset = matched?.id ?? "custom";

    const presetOptions = [
      ...VOICE_TRANSCRIBE_PRESETS.map(
        (p) =>
          `<option value="${escapeHtml(p.id)}"${p.id === selectedPreset ? " selected" : ""}>${escapeHtml(p.label)}</option>`,
      ),
      `<option value="custom"${selectedPreset === "custom" ? " selected" : ""}>Custom…</option>`,
    ].join("");

    const reload = `if(event.detail.successful)htmx.ajax('GET','/dashboard/page/spaces/${encodeURIComponent(spaceId)}',{target:'#main',swap:'innerHTML',pushUrl:true})`;

    const customModelValue =
      selectedPreset === "custom" ? escapeHtml(effModel) : "";
    const selTf =
      selectedPreset === "custom" && effLocalEngine === "transformers"
        ? " selected"
        : "";
    const selFw =
      selectedPreset === "custom" && effLocalEngine === "faster_whisper"
        ? " selected"
        : "";
    const selLoc =
      selectedPreset === "custom" && effProvider === "local" ? " selected" : "";
    const selApi =
      selectedPreset === "custom" && effProvider === "api" ? " selected" : "";

    return `
      <div class="panel">
        <div class="panel-header">Voice transcription</div>
        <div class="panel-body">
          <p class="muted" style="margin-bottom:10px">Per-space STT for <span class="mono">voice-transcribe</span>. API preset requires <span class="mono">MERCURY_HF_TOKEN</span> on the Mercury host.</p>
          <div class="role-row" style="flex-wrap:wrap;gap:8px;margin-bottom:8px">
            <span class="muted" style="min-width:72px">Effective</span>
            <span style="flex:1;min-width:200px"><span class="mono">${escapeHtml(effModel)}</span> · <span class="mono">${escapeHtml(effLocalEngine)}</span> · <span class="mono">${escapeHtml(effProvider)}</span></span>
          </div>
          <form class="role-row" style="flex-wrap:wrap;gap:8px;align-items:flex-end;margin-top:12px;padding-top:12px;border-top:1px solid var(--border)"
                hx-post="/dashboard/api/voice-transcribe"
                hx-swap="none"
                hx-on::after-request="${reload}">
            <input type="hidden" name="spaceId" value="${escapeHtml(spaceId)}" />
            <label style="display:flex;flex-direction:column;gap:4px">
              <span class="muted" style="font-size:12px">Preset</span>
              <select name="preset" class="select">${presetOptions}</select>
            </label>
            <label style="display:flex;flex-direction:column;gap:4px;flex:1;min-width:180px">
              <span class="muted" style="font-size:12px">Custom model (HF id)</span>
              <input type="text" name="custom_model" class="select" value="${customModelValue}" placeholder="org/model" />
            </label>
            <label style="display:flex;flex-direction:column;gap:4px">
              <span class="muted" style="font-size:12px">Custom engine</span>
              <select name="custom_local_engine" class="select">
                <option value="transformers"${selTf}>transformers</option>
                <option value="faster_whisper"${selFw}>faster_whisper</option>
              </select>
            </label>
            <label style="display:flex;flex-direction:column;gap:4px">
              <span class="muted" style="font-size:12px">Custom provider</span>
              <select name="custom_provider" class="select">
                <option value="local"${selLoc}>local</option>
                <option value="api"${selApi}>api</option>
              </select>
            </label>
            <button type="submit" name="intent" value="apply" class="btn btn-sm">Save</button>
            <button type="submit" name="intent" value="reset" class="btn btn-sm btn-danger" hx-confirm="Clear voice-transcribe overrides and use extension defaults?">Reset</button>
          </form>
        </div>
      </div>`;
  }

  /** Matches voice-synth extension readVoiceSynthMode precedence. */
  function effectiveVoiceSynthMode(spaceId: string): "on_demand" | "auto" {
    const modeRaw = core.db.getSpaceConfig(spaceId, VS_KEY.mode)?.trim() ?? "";
    if (modeRaw === "auto" || modeRaw === "on_demand") return modeRaw;
    const legacy = core.db.getSpaceConfig(spaceId, VS_KEY.auto)?.trim() ?? "";
    return legacy === "true" ? "auto" : "on_demand";
  }

  function voiceSynthPanelHtml(spaceId: string): string {
    const reg = configRegistry;
    if (!reg?.isValidKey(VS_KEY.mode)) return "";

    const eff = effectiveVoiceSynthMode(spaceId);
    const reload = `if(event.detail.successful)htmx.ajax('GET','/dashboard/page/spaces/${encodeURIComponent(spaceId)}',{target:'#main',swap:'innerHTML',pushUrl:true})`;
    const selDemand = eff === "on_demand" ? " selected" : "";
    const selAuto = eff === "auto" ? " selected" : "";

    return `
      <div class="panel">
        <div class="panel-header">Voice synthesis</div>
        <div class="panel-body">
          <p class="muted" style="margin-bottom:10px">Per-space TTS for <span class="mono">voice-synth</span>. Host needs Azure or Google credentials (<span class="mono">MERCURY_TTS_*</span>). Callers need <span class="mono">tts.synthesize</span> for auto attachments.</p>
          <div class="role-row" style="flex-wrap:wrap;gap:8px;margin-bottom:8px">
            <span class="muted" style="min-width:72px">Effective</span>
            <span style="flex:1;min-width:200px"><span class="mono">${escapeHtml(eff)}</span></span>
          </div>
          <form class="role-row" style="flex-wrap:wrap;gap:8px;align-items:flex-end;margin-top:12px;padding-top:12px;border-top:1px solid var(--border)"
                hx-post="/dashboard/api/voice-synth"
                hx-swap="none"
                hx-on::after-request="${reload}">
            <input type="hidden" name="spaceId" value="${escapeHtml(spaceId)}" />
            <label style="display:flex;flex-direction:column;gap:4px">
              <span class="muted" style="font-size:12px">Mode</span>
              <select name="mode" class="select" required>
                <option value="on_demand"${selDemand}>on_demand — TTS only via mrctl</option>
                <option value="auto"${selAuto}>auto — MP3 on every reply</option>
              </select>
            </label>
            <button type="submit" name="intent" value="apply" class="btn btn-sm">Save</button>
            <button type="submit" name="intent" value="reset" class="btn btn-sm btn-danger" hx-confirm="Clear voice-synth overrides and use extension defaults?">Reset</button>
          </form>
        </div>
      </div>`;
  }

  function renderExtensionWidgets(): string {
    if (!registry || !extensionCtx) return "";

    const allWidgets: Array<{ extName: string; label: string; html: string }> =
      [];
    for (const ext of registry.list()) {
      for (const widget of ext.widgets) {
        try {
          const widgetHtml = widget.render(extensionCtx);
          allWidgets.push({
            extName: ext.name,
            label: widget.label,
            html: widgetHtml,
          });
        } catch {
          allWidgets.push({
            extName: ext.name,
            label: widget.label,
            html: '<p class="muted">Error rendering widget</p>',
          });
        }
      }
    }

    if (allWidgets.length === 0) return "";

    const widgetPanels = allWidgets
      .map(
        (w) => `
        <div class="panel">
          <div class="panel-header">${escapeHtml(w.label)} <span class="muted">${escapeHtml(w.extName)}</span></div>
          <div class="panel-body">${w.html}</div>
        </div>
      `,
      )
      .join("");

    return `<div class="grid-2">${widgetPanels}</div>`;
  }

  // ─── Page Routes (htmx content swapping) ────────────────────────────────

  // Middleware: redirect direct browser access to main dashboard
  app.use("/page/*", async (c, next) => {
    const isHtmx = c.req.header("HX-Request") === "true";
    if (!isHtmx) {
      // Direct browser access - redirect to dashboard with the page in hash
      const path = c.req.path.replace("/dashboard/page/", "");
      return c.redirect(`/dashboard#${path}`);
    }
    return next();
  });

  app.get("/page/overview", (c) => {
    const activeSpaces = core.containerRunner.getActiveSpaces();
    const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);

    // Active runs
    const activeRunsHtml =
      activeSpaces.length > 0
        ? activeSpaces
            .map((spaceId) => {
              const space = core.db.getSpace(spaceId);
              const linked = core.db.getSpaceConversations(spaceId);
              const platform = linked[0]?.platform ?? "space";
              const label = space?.name ?? spaceId;
              return `
              <div class="active-run">
                <span class="badge">${platform}</span>
                <span class="mono">${escapeHtml(label)}</span>
                <span class="status active">running</span>
                <button class="btn btn-sm btn-danger" 
                        hx-post="/dashboard/api/stop" 
                        hx-headers='{"X-Mercury-Space": "${escapeHtml(spaceId)}", "X-Mercury-Caller": "dashboard"}'
                        hx-swap="none">Stop</button>
              </div>
            `;
            })
            .join("")
        : '<div class="empty-small">No active runs</div>';

    // Adapters
    const adapterEntries = Object.entries(adapters);
    const adaptersHtml = adapterEntries
      .map(([name, connected]) => {
        const status = connected ? "connected" : "disconnected";
        const icon = connected ? "🟢" : "🔴";
        return `
          <div class="adapter-row">
            <span>${icon} ${name}</span>
            <span class="muted">${status}</span>
          </div>
        `;
      })
      .join("");

    // Recent activity
    const spaces = core.db.listSpaces();
    const activity: Array<{
      spaceId: string;
      spaceName: string;
      platform: string;
      role: string;
      preview: string;
      time: number;
    }> = [];

    for (const space of spaces.slice(0, 5)) {
      const msgs = core.db.getRecentMessages(space.id, 3);
      const linked = core.db.getSpaceConversations(space.id);
      const platform = linked[0]?.platform ?? "space";
      for (const m of msgs) {
        activity.push({
          spaceId: space.id,
          spaceName: space.name,
          platform,
          role: m.role,
          preview: m.content.slice(0, 60),
          time: m.createdAt,
        });
      }
    }
    activity.sort((a, b) => b.time - a.time);

    const activityHtml =
      activity.length > 0
        ? activity
            .slice(0, 8)
            .map(
              (a) => `
              <div class="activity-row" 
                   hx-get="/dashboard/page/spaces/${encodeURIComponent(a.spaceId)}" 
                   hx-target="#main" 
                   hx-push-url="true">
                <span class="time">${formatRelativeTime(a.time)}</span>
                <span class="badge">${a.platform}</span>
                <span class="mono">${escapeHtml(truncate(a.spaceName, 18))}</span>
                <span class="role ${a.role}">${a.role}</span>
                <span class="preview">${escapeHtml(a.preview)}</span>
              </div>
            `,
            )
            .join("")
        : '<div class="empty-small">No recent activity</div>';

    // Upcoming tasks
    const tasks = core.db.listTasks().filter((t) => t.active);
    const upcomingHtml =
      tasks.length > 0
        ? tasks
            .slice(0, 3)
            .map(
              (t) => `
              <div class="task-row">
                <span class="mono">#${t.id}</span>
                <span class="truncate">${escapeHtml(truncate(t.prompt, 25))}</span>
                <span class="muted">${formatFutureTime(t.nextRunAt)}</span>
                ${t.silent === 1 ? '<span class="badge muted">silent</span>' : '<span class="badge">chat</span>'}
                <button class="btn btn-sm" 
                        hx-post="/dashboard/api/tasks/${t.id}/run" 
                        hx-swap="none"
                        title="Run now">▶</button>
              </div>
            `,
            )
            .join("")
        : '<div class="empty-small">No scheduled tasks</div>';

    return c.html(html`
      <div class="grid-2">
        <div class="panel">
          <div class="panel-header">Adapters</div>
          <div class="panel-body">${raw(adaptersHtml)}</div>
        </div>
        <div class="panel">
          <div class="panel-header">
            Active Work
            <span class="badge">${activeSpaces.length}</span>
          </div>
          <div class="panel-body">${raw(activeRunsHtml)}</div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-header">
          Recent Activity
          <a href="#" hx-get="/dashboard/page/logs" hx-target="#main" hx-push-url="true" class="link">View logs →</a>
        </div>
        <div class="panel-body">${raw(activityHtml)}</div>
      </div>

      <div class="grid-2">
        <div class="panel">
          <div class="panel-header">
            Upcoming Tasks
            <a href="#" hx-get="/dashboard/page/tasks" hx-target="#main" hx-push-url="true" class="link">View all →</a>
          </div>
          <div class="panel-body">${raw(upcomingHtml)}</div>
        </div>
        <div class="panel">
          <div class="panel-header">Stats &amp; model</div>
          <div class="panel-body">
            <div class="stats">
              <div class="stat">
                <div class="stat-value">${spaces.length}</div>
                <div class="stat-label">Spaces</div>
              </div>
              <div class="stat">
                <div class="stat-value">${core.queue.pendingCount}</div>
                <div class="stat-label">Queued</div>
              </div>
              <div class="stat">
                <div class="stat-value">${formatUptime(uptimeSeconds)}</div>
                <div class="stat-label">Uptime</div>
              </div>
            </div>
            ${
              extensionCtx?.config
                ? raw(
                    `<div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border)">${renderModelBlock(extensionCtx.config)}</div>`,
                  )
                : ""
            }
          </div>
        </div>
      </div>

      ${raw(renderExtensionWidgets())}
    `);
  });

  app.get("/page/spaces", (c) => {
    const spaces = core.db
      .listSpaces()
      .map((s) => {
        const conversations = core.db.getSpaceConversations(s.id);
        const msgCount = core.db.getRecentMessages(s.id, 1000).length;
        return {
          id: s.id,
          name: s.name,
          tags: s.tags,
          conversationCount: conversations.length,
          platforms: [...new Set(conversations.map((conv) => conv.platform))],
          lastActivity: s.updatedAt,
          messageCount: msgCount,
        };
      })
      .sort((a, b) => b.lastActivity - a.lastActivity);

    const rowsHtml =
      spaces.length > 0
        ? spaces
            .map(
              (s) => `
              <tr class="clickable" 
                  hx-get="/dashboard/page/spaces/${encodeURIComponent(s.id)}" 
                  hx-target="#main" 
                  hx-push-url="true">
                <td class="mono">${escapeHtml(s.name)}</td>
                <td>${s.platforms.map((p) => `<span class="badge">${escapeHtml(p)}</span>`).join(" ") || '<span class="muted">—</span>'}</td>
                <td class="muted">${s.conversationCount}</td>
                <td class="muted">${s.messageCount}</td>
                <td class="muted">${formatRelativeTime(s.lastActivity)}</td>
              </tr>
            `,
            )
            .join("")
        : '<tr><td colspan="5" class="empty">No spaces yet</td></tr>';

    return c.html(html`
      <div class="page-header">
        <h2>Spaces</h2>
        <div class="search-box">
          <input type="text" placeholder="Search spaces..." id="space-search"
                 onkeyup="_filterTable(this, 'spaces-table')" />
        </div>
      </div>

      <div class="panel">
        <div class="table-scroll">
          <table class="table" id="spaces-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Platforms</th>
                <th>Conversations</th>
                <th>Messages</th>
                <th>Last Active</th>
              </tr>
            </thead>
            <tbody>${raw(rowsHtml)}</tbody>
          </table>
        </div>
      </div>
    `);
  });

  app.get("/page/spaces/:id", (c) => {
    const spaceId = decodeURIComponent(c.req.param("id"));
    const group = core.db.listSpaces().find((g) => g.id === spaceId);

    if (!group) {
      return c.html(html`
        <div class="page-header">
          <a href="#" hx-get="/dashboard/page/spaces" hx-target="#main" hx-push-url="true" class="back">← Back</a>
          <h2>Space not found</h2>
        </div>
        <div class="panel">
          <div class="panel-body empty">Space "${escapeHtml(spaceId)}" not found</div>
        </div>
      `);
    }

    const linkedConversations = core.db.getSpaceConversations(spaceId);
    const messages = core.db.getRecentMessages(spaceId, 50);
    const roles = core.db.listRoles(spaceId);
    const mutes = core.db.listMutes(spaceId);
    const tasks = core.db.listTasks().filter((t) => t.spaceId === spaceId);
    const configEntries = core.db.listSpaceConfig(spaceId);
    const configEntriesFiltered = configEntries.filter(
      (e) => !BUILTIN_CONFIG_KEYS.has(e.key),
    );
    const prefEntries = core.db.listSpacePreferences(spaceId);

    const messagesHtml =
      messages.length > 0
        ? messages
            .map(
              (m) => `
              <div class="message ${m.role}">
                <div class="message-meta">
                  <span class="role ${m.role}">${m.role}</span>
                  <span class="time">${formatRelativeTime(m.createdAt)}</span>
                </div>
                ${m.role === "user" ? formatUserRunMetaHtml(m.runMeta) : ""}
                <div class="message-content">${escapeHtml(m.content)}</div>
              </div>
            `,
            )
            .join("")
        : '<div class="empty-small">No messages yet</div>';

    const linkedConversationsHtml =
      linkedConversations.length > 0
        ? linkedConversations
            .map(
              (conv) => `
              <div class="role-row">
                <span><span class="badge">${escapeHtml(conv.platform)}</span> ${escapeHtml(conv.observedTitle || conv.externalId)}</span>
                <span class="badge">${escapeHtml(conv.kind)}</span>
                <button class="btn btn-sm btn-danger" 
                        hx-post="/dashboard/api/conversations/${conv.id}/unlink"
                        hx-swap="none"
                        hx-confirm="Unlink this conversation from ${escapeHtml(group.name)}?">Unlink</button>
              </div>
            `,
            )
            .join("")
        : '<div class="empty-small">No linked conversations</div>';

    const spacePageReload = `if(event.detail.successful)htmx.ajax('GET','/dashboard/page/spaces/${encodeURIComponent(spaceId)}',{target:'#main',swap:'innerHTML',pushUrl:true})`;

    const rolesHtml =
      roles.length > 0
        ? roles
            .map(
              (r) => `
              <div class="role-row">
                <span style="display:flex;flex-direction:column;gap:1px;min-width:0">${r.displayName ? `<span>${escapeHtml(r.displayName)}</span><span class="mono muted" style="font-size:0.75rem">${escapeHtml(r.platformUserId)}</span>` : `<span class="mono">${escapeHtml(r.platformUserId)}</span>`}</span>
                <span class="badge ${r.role === "admin" ? "green" : ""}">${r.role}</span>
                ${
                  r.role === "member"
                    ? `<button class="btn btn-sm" title="Promote to admin" style="margin-left:auto;min-width:78px;font-size:0.75rem;color:var(--color-success)"
                            hx-post="/dashboard/api/roles"
                            hx-vals='${JSON.stringify({ spaceId, platformUserId: r.platformUserId, role: "admin" })}'
                            hx-swap="none"
                            hx-on::after-request="${spacePageReload}">↑ admin</button>`
                    : `<button class="btn btn-sm" title="Demote to member" style="margin-left:auto;min-width:78px;font-size:0.75rem;color:var(--color-warning)"
                            hx-post="/dashboard/api/roles"
                            hx-vals='${JSON.stringify({ spaceId, platformUserId: r.platformUserId, role: "member" })}'
                            hx-swap="none"
                            hx-on::after-request="${spacePageReload}">↓ member</button>`
                }
              </div>
            `,
            )
            .join("")
        : '<div class="empty-small">No roles assigned</div>';

    const voiceTranscribeHtml = voiceTranscribePanelHtml(spaceId);
    const voiceSynthHtml = voiceSynthPanelHtml(spaceId);

    const mutesListHtml =
      mutes.length > 0
        ? mutes
            .map(
              (m) => `
              <div class="role-row">
                <span class="mono">${escapeHtml(m.platformUserId)}</span>
                <span class="badge">${escapeHtml(formatFutureTime(m.expiresAt))}</span>
                <span class="muted" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis" title="${escapeHtml(m.reason ?? "")}">${escapeHtml(m.reason ? truncate(m.reason, 48) : "—")}</span>
                <span class="mono muted">${escapeHtml(truncate(m.mutedBy, 20))}</span>
                <button type="button" class="btn btn-sm btn-danger"
                        hx-delete="/dashboard/api/mutes?spaceId=${encodeURIComponent(spaceId)}&platformUserId=${encodeURIComponent(m.platformUserId)}"
                        hx-swap="none"
                        hx-confirm="Unmute ${escapeHtml(m.platformUserId)}?"
                        hx-on::after-request="${spacePageReload}">Unmute</button>
              </div>
            `,
            )
            .join("")
        : '<div class="empty-small">No muted users</div>';

    const muteAddFormHtml = `
      <form class="role-row" style="flex-wrap:wrap;gap:8px;margin-top:12px;padding-top:12px;border-top:1px solid var(--border)"
            hx-post="/dashboard/api/mutes"
            hx-swap="none"
            hx-on::after-request="${spacePageReload}">
        <input type="hidden" name="spaceId" value="${escapeHtml(spaceId)}" />
        <input type="text" name="platformUserId" class="select" placeholder="Platform user id" required style="min-width:140px;flex:1;width:auto" />
        <input type="text" name="duration" class="select" placeholder="Duration (e.g. 1h)" required style="width:120px" />
        <input type="text" name="reason" class="select" placeholder="Reason (optional)" style="min-width:120px;flex:1;width:auto" />
        <button type="submit" class="btn btn-sm">Mute</button>
      </form>
    `;

    const tasksHtml =
      tasks.length > 0
        ? tasks
            .map(
              (t) => `
              <div class="task-row">
                <span class="mono">#${t.id}</span>
                <span>${escapeHtml(truncate(t.prompt, 30))}</span>
                <span class="badge ${t.silent === 1 ? "muted" : ""}">${t.silent === 1 ? "silent" : "chat"}</span>
                <span class="badge ${t.active ? "green" : ""}">${t.active ? "active" : "paused"}</span>
              </div>
            `,
            )
            .join("")
        : '<div class="empty-small">No tasks for this space</div>';

    const triggersAmbientHtml = renderTriggersAmbientPanel(
      spaceId,
      spacePageReload,
    );

    const contextHtml = renderContextPanel(spaceId, spacePageReload);
    const rateLimitHtml = renderRateLimitPanel(spaceId, spacePageReload);

    const configHtml =
      configEntriesFiltered.length > 0
        ? configEntriesFiltered
            .map(
              (entry) => `
              <div class="task-row">
                <span class="mono">${escapeHtml(entry.key)}</span>
                <span>${escapeHtml(entry.value)}</span>
              </div>
            `,
            )
            .join("")
        : '<div class="empty-small">No extension config overrides</div>';

    const preferencesHtml =
      prefEntries.length > 0
        ? prefEntries
            .map(
              (entry) => `
              <div class="task-row">
                <span class="mono">${escapeHtml(entry.key)}</span>
                <span style="flex:1;min-width:0;word-break:break-word">${escapeHtml(entry.value)}</span>
                <button type="button" class="btn btn-sm btn-danger"
                        hx-delete="/dashboard/api/prefs?spaceId=${encodeURIComponent(spaceId)}&key=${encodeURIComponent(entry.key)}"
                        hx-swap="none"
                        hx-confirm="Delete preference ${escapeHtml(entry.key)}?"
                        hx-on::after-request="${spacePageReload}">Delete</button>
              </div>
            `,
            )
            .join("")
        : '<div class="empty-small">No preferences yet</div>';

    const prefsAddFormHtml = `
      <form class="role-row" style="flex-wrap:wrap;gap:8px;margin-top:12px;padding-top:12px;border-top:1px solid var(--border)"
            hx-post="/dashboard/api/prefs"
            hx-swap="none"
            hx-on::after-request="${spacePageReload}">
        <input type="hidden" name="spaceId" value="${escapeHtml(spaceId)}" />
        <input type="text" name="key" class="select" placeholder="key (e.g. stock-sources)" required style="min-width:120px;width:160px" />
        <input type="text" name="value" class="select" placeholder="Value" required style="min-width:140px;flex:1;width:auto" />
        <button type="submit" class="btn btn-sm">Add</button>
      </form>
    `;

    const isPaused = core.db.getSpaceConfig(spaceId, "paused") === "true";

    return c.html(html`
      <div class="page-header">
        <a href="#" hx-get="/dashboard/page/spaces" hx-target="#main" hx-push-url="true" class="back">← Back</a>
        <h2>${escapeHtml(group.name)}${isPaused ? raw(' <span class="badge" style="background:var(--color-warning);color:var(--bg);font-size:11px;vertical-align:middle">⏸ Paused</span>') : ""}</h2>
      </div>

      <div class="grid-2">
        <div class="panel">
          <div class="panel-header">Linked Conversations</div>
          <div class="panel-body">${raw(linkedConversationsHtml)}</div>
        </div>
        <div class="panel">
          <div class="panel-header">Roles</div>
          <div class="panel-body scroll-cap">${raw(rolesHtml)}</div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-header">Muted users</div>
        <div class="panel-body">${raw(mutesListHtml)}${raw(muteAddFormHtml)}</div>
      </div>

      <div class="panel">
        <div class="panel-header">Triggers & ambient</div>
        <div class="panel-body">${raw(triggersAmbientHtml)}</div>
      </div>

      <div class="panel">
        <div class="panel-header">Context</div>
        <div class="panel-body">${raw(contextHtml)}</div>
      </div>

      <div class="panel">
        <div class="panel-header">Rate limits</div>
        <div class="panel-body">${raw(rateLimitHtml)}</div>
      </div>

      <div class="grid-2">
        <div class="panel">
          <div class="panel-header">Tasks</div>
          <div class="panel-body scroll-cap">${raw(tasksHtml)}</div>
        </div>
        <div class="panel">
          <div class="panel-header">Config</div>
          <div class="panel-body">${raw(configHtml)}</div>
        </div>
      </div>

      ${raw(voiceTranscribeHtml)}
      ${raw(voiceSynthHtml)}

      <div class="panel">
        <div class="panel-header">Preferences</div>
        <div class="panel-body">${raw(preferencesHtml)}${raw(prefsAddFormHtml)}</div>
      </div>

      <div class="panel">
        <div class="panel-header">Recent Messages</div>
        <div class="panel-body messages-list">${raw(messagesHtml)}</div>
      </div>
    `);
  });

  app.get("/page/conversations", (c) => {
    const spaces = core.db.listSpaces();
    const conversations = core.db.listConversations();

    const rowsHtml =
      conversations.length > 0
        ? conversations
            .map((conv) => {
              const title = conv.observedTitle || conv.externalId;
              const linked = conv.spaceId
                ? `<span class="badge green">${escapeHtml(conv.spaceId)}</span>`
                : `
                  <form hx-post="/dashboard/api/conversations/${conv.id}/link" hx-swap="none" style="display:flex; gap:8px; align-items:center;">
                    <select name="spaceId" class="select">
                      ${spaces
                        .map(
                          (space) =>
                            `<option value="${escapeHtml(space.id)}">${escapeHtml(space.name)}</option>`,
                        )
                        .join("")}
                    </select>
                    <button class="btn btn-sm">Link</button>
                  </form>
                `;
              const action = conv.spaceId
                ? `<button class="btn btn-sm btn-danger" hx-post="/dashboard/api/conversations/${conv.id}/unlink" hx-swap="none">Unlink</button>`
                : "";

              return `
                <tr>
                  <td><span class="badge">${escapeHtml(conv.platform)}</span></td>
                  <td>${escapeHtml(title)}</td>
                  <td><span class="badge">${escapeHtml(conv.kind)}</span></td>
                  <td>${linked}</td>
                  <td class="muted">${formatRelativeTime(conv.lastSeenAt)}</td>
                  <td>${action}</td>
                </tr>
              `;
            })
            .join("")
        : '<tr><td colspan="6" class="empty">No conversations yet</td></tr>';

    return c.html(html`
      <div class="page-header">
        <h2>Conversations</h2>
      </div>
      <div class="panel">
        <div class="table-scroll">
          <table class="table">
            <thead>
              <tr>
                <th>Platform</th>
                <th>Title</th>
                <th>Kind</th>
                <th>Linked Space</th>
                <th>Last Seen</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>${raw(rowsHtml)}</tbody>
          </table>
        </div>
      </div>
    `);
  });

  app.get("/page/tasks", (c) => {
    const tasks = core.db.listTasks();
    const spaces = core.db.listSpaces();
    const spacesById = new Map(spaces.map((s) => [s.id, s]));
    const knownSpaceIds = new Set(spacesById.keys());

    const taskSpaceIds = new Set(tasks.map((t) => t.spaceId).filter(Boolean));

    const rowsHtml =
      tasks.length > 0
        ? tasks
            .map((t) => {
              const label =
                spacesById.get(t.spaceId)?.name ?? (t.spaceId || "global");
              const swatchClass = spaceSwatchClass(t.spaceId, knownSpaceIds);
              return `
              <tr data-space-id="${escapeHtml(t.spaceId || "")}">
                <td class="mono">#${t.id}</td>
                <td><span class="space-badge ${swatchClass}">${escapeHtml(label)}</span></td>
                <td class="mono">${escapeHtml(t.cron || "one-shot")}</td>
                <td class="mono muted">${escapeHtml(t.timezone || "UTC")}</td>
                <td class="truncate" title="${escapeHtml(t.prompt)}">${escapeHtml(truncate(t.prompt, 40))}</td>
                <td class="muted">${formatFutureTime(t.nextRunAt)}</td>
                <td><span class="badge ${t.silent === 1 ? "muted" : ""}">${t.silent === 1 ? "silent" : "chat"}</span></td>
                <td><span class="badge ${t.active ? "green" : ""}">${t.active ? "active" : "paused"}</span></td>
                <td class="actions">
                  <button class="btn btn-sm" hx-post="/dashboard/api/tasks/${t.id}/run" hx-swap="none" title="Run now">▶</button>
                  ${
                    t.active
                      ? `<button class="btn btn-sm" hx-post="/dashboard/api/tasks/${t.id}/pause" hx-swap="none" title="Pause">⏸</button>`
                      : `<button class="btn btn-sm" hx-post="/dashboard/api/tasks/${t.id}/resume" hx-swap="none" title="Resume">▶️</button>`
                  }
                  <button class="btn btn-sm btn-danger" hx-delete="/dashboard/api/tasks/${t.id}" hx-swap="none" hx-confirm="Delete task #${t.id}?" title="Delete">✕</button>
                </td>
              </tr>
            `;
            })
            .join("")
        : '<tr><td colspan="9" class="empty">No scheduled tasks</td></tr>';

    let filterSelectHtml = "";
    if (taskSpaceIds.size >= 2) {
      const options: string[] = [`<option value="">All spaces</option>`];
      for (const [id, space] of spacesById) {
        if (taskSpaceIds.has(id)) {
          options.push(
            `<option value="${escapeHtml(id)}">${escapeHtml(space.name)}</option>`,
          );
        }
      }
      for (const spaceId of taskSpaceIds) {
        if (!spacesById.has(spaceId)) {
          options.push(
            `<option value="${escapeHtml(spaceId)}">${escapeHtml(spaceId || "global")} (unknown)</option>`,
          );
        }
      }
      filterSelectHtml = `<div style="padding: 12px 0 0">
        <select id="task-space-filter" class="select" onchange="_filterTasksBySpace(this)">
          ${options.join("")}
        </select>
      </div>`;
    }

    return c.html(html`
      <div class="page-header">
        <h2>Scheduled Tasks</h2>
      </div>

      <div class="panel">
        ${raw(filterSelectHtml)}
        <div class="table-scroll">
          <table class="table" id="tasks-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Space</th>
                <th>Schedule</th>
                <th>TZ</th>
                <th>Prompt</th>
                <th>Next Run</th>
                <th>Silent</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>${raw(rowsHtml)}</tbody>
          </table>
        </div>
      </div>
    `);
  });

  app.get("/page/permissions", (c) => {
    const groups = core.db.listSpaces();
    const allRoles: Array<{
      spaceId: string;
      platform: string;
      userId: string;
      displayName: string | null;
      role: string;
    }> = [];

    for (const g of groups) {
      const platform = g.id.split(":")[0];
      const groupRoles = core.db.listRoles(g.id);
      for (const r of groupRoles) {
        allRoles.push({
          spaceId: g.id,
          platform,
          userId: r.platformUserId,
          displayName: r.displayName,
          role: r.role,
        });
      }
    }

    const permPageReload = `if(event.detail.successful)htmx.ajax('GET','/dashboard/page/permissions',{target:'#main',swap:'innerHTML',pushUrl:true})`;

    const rowsHtml =
      allRoles.length > 0
        ? allRoles
            .map(
              (r) => `
              <tr>
                <td><span class="badge">${r.platform}</span></td>
                <td class="mono truncate" title="${escapeHtml(r.spaceId)}">${escapeHtml(truncate(r.spaceId, 25))}</td>
                <td>${r.displayName ? `<span>${escapeHtml(r.displayName)}</span><br><span class="mono muted" style="font-size:0.75rem">${escapeHtml(r.userId)}</span>` : `<span class="mono">${escapeHtml(r.userId)}</span>`}</td>
                <td><span class="badge ${r.role === "admin" ? "green" : ""}">${r.role}</span></td>
                <td>
                  ${
                    r.role === "member"
                      ? `<button class="btn btn-sm" title="Promote to admin" style="min-width:78px;font-size:0.75rem;color:var(--color-success)"
                              hx-post="/dashboard/api/roles"
                              hx-vals='${JSON.stringify({ spaceId: r.spaceId, platformUserId: r.userId, role: "admin" })}'
                              hx-swap="none"
                              hx-on::after-request="${permPageReload}">↑ admin</button>`
                      : `<button class="btn btn-sm" title="Demote to member" style="min-width:78px;font-size:0.75rem;color:var(--color-warning)"
                              hx-post="/dashboard/api/roles"
                              hx-vals='${JSON.stringify({ spaceId: r.spaceId, platformUserId: r.userId, role: "member" })}'
                              hx-swap="none"
                              hx-on::after-request="${permPageReload}">↓ member</button>`
                  }
                </td>
              </tr>
            `,
            )
            .join("")
        : '<tr><td colspan="5" class="empty">No roles assigned</td></tr>';

    return c.html(html`
      <div class="page-header">
        <h2>Permissions</h2>
      </div>

      <div class="panel">
        <div class="table-scroll">
          <table class="table">
            <thead>
              <tr>
                <th>Platform</th>
                <th>Space</th>
                <th>User</th>
                <th>Role</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>${raw(rowsHtml)}</tbody>
          </table>
        </div>
      </div>
    `);
  });

  app.get("/page/logs", (c) => {
    // Aggregate recent messages as "logs" for now
    // In a real system, you'd have a proper log store
    const groups = core.db.listSpaces();
    const logs: Array<{
      time: number;
      level: string;
      source: string;
      message: string;
      spaceId?: string;
    }> = [];

    // Add message events as logs
    for (const g of groups) {
      const msgs = core.db.getRecentMessages(g.id, 10);
      const platform = g.id.split(":")[0];
      for (const m of msgs) {
        logs.push({
          time: m.createdAt,
          level: "INFO",
          source: platform,
          message: `${m.role}: ${m.content.slice(0, 80)}`,
          spaceId: g.id,
        });
      }
    }

    logs.sort((a, b) => b.time - a.time);

    const logsHtml =
      logs.length > 0
        ? logs
            .slice(0, 50)
            .map(
              (l) => `
              <div class="log-row ${l.level.toLowerCase()}">
                <span class="time">${new Date(l.time).toLocaleTimeString()}</span>
                <span class="level ${l.level.toLowerCase()}">${l.level}</span>
                <span class="source">${l.source}</span>
                <span class="message">${escapeHtml(l.message)}</span>
              </div>
            `,
            )
            .join("")
        : '<div class="empty">No logs available</div>';

    return c.html(html`
      <div class="page-header">
        <h2>Logs</h2>
        <div class="filters">
          <select class="select" onchange="filterLogs(this)">
            <option value="all">All levels</option>
            <option value="error">Errors only</option>
            <option value="info">Info</option>
          </select>
        </div>
      </div>

      <div class="panel">
        <div class="panel-body logs-list">${raw(logsHtml)}</div>
      </div>
    `);
  });

  // ─── Features (extensions catalog) ───────────────────────────────────────

  app.get("/page/features", (c) => {
    const cfg = extensionCtx?.config;
    if (!cfg || !registry) {
      return c.html(html`
        <div class="page-header">
          <h2>Features</h2>
        </div>
        <p class="muted">Extension registry is not available.</p>
      `);
    }

    const installed = registry.list();
    const installedNames = new Set(installed.map((e) => e.name));

    const installedRows =
      installed.length > 0
        ? installed
            .map((ext) => {
              const cat = getCatalogEntryByName(ext.name);
              const desc =
                cat?.description ?? "Installed extension (outside catalog).";
              const feats = [
                ext.clis.length > 0 ? "cli" : null,
                ext.skillDir ? "skill" : null,
                ext.widgets.length > 0 ? "widget" : null,
              ]
                .filter(Boolean)
                .join(", ");
              const label = cat?.label ?? ext.name;
              const prereqHint = cat?.prerequisites?.length
                ? `<div class="muted" style="font-size:12px;margin-top:4px">Requires: ${escapeHtml(cat.prerequisites.join(", "))}</div>`
                : "";
              return `
              <tr>
                <td class="mono">${escapeHtml(ext.name)}</td>
                <td>${escapeHtml(label)}</td>
                <td class="muted" style="max-width:320px">${escapeHtml(desc)}${prereqHint}</td>
                <td class="muted">${escapeHtml(feats || "—")}</td>
                <td>
                  <button type="button" class="btn btn-sm btn-danger"
                    hx-delete="/dashboard/api/extensions/${encodeURIComponent(ext.name)}"
                    hx-target="#features-toast"
                    hx-swap="innerHTML"
                    hx-confirm="Remove extension &quot;${escapeHtml(ext.name)}&quot;? Restart Mercury afterward.">Remove</button>
                </td>
              </tr>`;
            })
            .join("")
        : '<tr><td colspan="5" class="empty">No extensions installed. Add one from the catalog below.</td></tr>';

    const available = EXTENSION_CATALOG.filter(
      (e) => !installedNames.has(e.name),
    );
    const availableRows =
      available.length > 0
        ? available
            .map((entry) => {
              const srcPath = resolveExamplesExtensionDir(
                packageRoot,
                entry.sourceDir,
              );
              const missing = !existsSync(srcPath);
              const envHint = entry.requiredEnvVars?.length
                ? `<div class="muted" style="font-size:12px;margin-top:4px">Env: ${escapeHtml(entry.requiredEnvVars.join(", "))}</div>`
                : "";
              const prereqHint = entry.prerequisites?.length
                ? `<div class="muted" style="font-size:12px;margin-top:4px">Requires: ${escapeHtml(entry.prerequisites.join(", "))}</div>`
                : "";
              const installBtn = missing
                ? `<button type="button" class="btn btn-sm" disabled title="examples/extensions missing in this install">Unavailable</button>`
                : `<form style="display:inline" hx-post="/dashboard/api/extensions/install" hx-target="#features-toast" hx-swap="innerHTML">
                    <input type="hidden" name="name" value="${escapeHtml(entry.name)}" />
                    <button type="submit" class="btn btn-sm">Install</button>
                  </form>`;
              return `
              <tr>
                <td class="mono">${escapeHtml(entry.name)}</td>
                <td>${escapeHtml(entry.label)}</td>
                <td class="muted" style="max-width:320px">
                  ${escapeHtml(entry.description)}
                  ${envHint}
                  ${prereqHint}
                </td>
                <td class="muted">${escapeHtml(entry.category)}</td>
                <td>${installBtn}</td>
              </tr>`;
            })
            .join("")
        : '<tr><td colspan="5" class="empty">All catalog extensions are installed.</td></tr>';

    const nAvail = available.filter((e) =>
      existsSync(resolveExamplesExtensionDir(packageRoot, e.sourceDir)),
    ).length;

    return c.html(html`
      <div class="page-header">
        <h2>Features</h2>
      </div>
      <p class="muted" style="margin: -8px 0 16px; font-size: 13px; line-height: 1.5;">
        Install optional capabilities from the bundled catalog. Third-party sites (email, banking, etc.) are typically used via the web browsing &amp; automation extension, not separate integrations.
        <strong> Restart Mercury</strong> after install or remove. Extensions with CLIs may require an agent image rebuild (<span class="mono">mercury build</span> when developing the base image).
      </p>

      <div id="features-toast"></div>

      <div class="grid-2">
        <div class="panel">
          <div class="panel-header">Model chain</div>
          <div class="panel-body">${raw(renderModelBlock(cfg))}</div>
        </div>
        <div class="panel">
          <div class="panel-header">Extension counts</div>
          <div class="panel-body stats" style="grid-template-columns: 1fr 1fr">
            <div class="stat">
              <div class="stat-value">${installed.length}</div>
              <div class="stat-label">Installed</div>
            </div>
            <div class="stat">
              <div class="stat-value">${nAvail}</div>
              <div class="stat-label">Available to add</div>
            </div>
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-header">Installed features</div>
        <div class="panel-body">
          <div class="table-scroll">
            <table class="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Label</th>
                  <th>Description</th>
                  <th>Capabilities</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                ${raw(installedRows)}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-header">Available features</div>
        <div class="panel-body">
          <div class="table-scroll">
            <table class="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Label</th>
                  <th>Description</th>
                  <th>Category</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                ${raw(availableRows)}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `);
  });

  // ─── Usage ──────────────────────────────────────────────────────────────

  function formatCost(cost: number): string {
    if (cost === 0) return "$0.00";
    if (cost < 0.01) return `$${cost.toFixed(4)}`;
    return `$${cost.toFixed(2)}`;
  }

  app.get("/page/usage", (c) => {
    const totals = core.db.getUsageTotals();
    const perSpace = core.db.getUsageSummary();

    const rowsHtml =
      perSpace.length > 0
        ? perSpace
            .map((s) => {
              return `
              <tr>
                <td class="mono">${escapeHtml(s.spaceName)}</td>
                <td>${formatTokenCount(s.totalInputTokens)}</td>
                <td>${formatTokenCount(s.totalOutputTokens)}</td>
                <td>${formatTokenCount(s.totalTokens)}</td>
                <td>${formatCost(s.totalCost)}</td>
                <td>${s.runCount}</td>
                <td class="muted">${formatRelativeTime(s.lastUsedAt)}</td>
              </tr>
            `;
            })
            .join("")
        : '<tr><td colspan="7" class="empty">No usage data yet. Token tracking starts after the next container run.</td></tr>';

    c.header("Cache-Control", "no-store");

    return c.html(html`
      <div class="page-header">
        <h2>Token Usage</h2>
      </div>
      <p class="muted" style="margin: -8px 0 16px; font-size: 13px; line-height: 1.5;">
        Figures come from the model runtime (pi JSON output). Token counts are aggregated per Mercury run; multi-step agent turns are summed. Cost is an estimate — use your provider for billing.
      </p>
      <div class=”panel”>
        <div class="panel-body stats">
          <div class="stat">
            <div class="stat-value">${formatTokenCount(totals.totalInputTokens)}</div>
            <div class="stat-label">Input Tokens</div>
          </div>
          <div class="stat">
            <div class="stat-value">${formatTokenCount(totals.totalOutputTokens)}</div>
            <div class="stat-label">Output Tokens</div>
          </div>
          <div class="stat">
            <div class="stat-value">${formatTokenCount(totals.totalTokens)}</div>
            <div class="stat-label">Total Tokens</div>
          </div>
          <div class="stat">
            <div class="stat-value">${formatCost(totals.totalCost)}</div>
            <div class="stat-label">Est. Cost</div>
          </div>
          <div class="stat">
            <div class="stat-value">${totals.runCount}</div>
            <div class="stat-label">Runs</div>
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-header">Per Space</div>
        <div class="table-scroll">
          <table class="table">
            <thead>
              <tr>
                <th>Space</th>
                <th>Input</th>
                <th>Output</th>
                <th>Total</th>
                <th>Cost</th>
                <th>Runs</th>
                <th>Last Used</th>
              </tr>
            </thead>
            <tbody>${raw(rowsHtml)}</tbody>
          </table>
        </div>
      </div>
    `);
  });

  app.get("/page/billing", (c) => {
    c.header("Cache-Control", "no-store");
    return c.html(html`
      <div class="page-header">
        <h2>Billing &amp; plan</h2>
      </div>
      <p class="muted" style="margin: -8px 0 16px; font-size: 13px; line-height: 1.5;">
        Mercury tracks <strong>estimated</strong> token usage on the Usage page. Hosted plans, add-on extensions, and invoices are managed by your
        your hosting operator when you use a managed deployment.
      </p>
      <div class="panel">
        <div class="panel-body">
          <p style="margin-bottom: 12px;">
            Self-hosted: you pay your model provider directly. Set keys in <span class="mono">.env</span> and review usage under <strong>Usage</strong>.
          </p>
          <p class="muted" style="font-size: 13px;">
            There is no in-dashboard payment method on this screen yet — it is a visibility panel for future console integration.
          </p>
        </div>
      </div>
    `);
  });

  app.get("/page/keys", (c) => {
    c.header("Cache-Control", "no-store");
    const consoleUrl = core.config.consoleUrl;

    // When managed by the Console, redirect users there for key management.
    // When self-hosted (no Console URL), keep the original key management UI.
    if (consoleUrl) {
      const keysUrl = `${consoleUrl.replace(/\/$/, "")}/dashboard/keys`;
      return c.html(html`
        <div class="page-header">
          <h2>API keys</h2>
        </div>
        <div class="panel" style="margin-top:8px">
          <div class="panel-body">
            <p style="font-size:13px;margin:0 0 12px;line-height:1.6">
              API keys for this agent are managed from the
              <strong>Mercury Console</strong>.<br />
              Changes made there are automatically applied to your agent.
            </p>
            <a href="${keysUrl}" target="_blank" rel="noopener noreferrer" class="btn btn-sm">
              Open Console → API Keys
            </a>
          </div>
        </div>
      `);
    }

    const cfg = core.config;
    const isMultiLeg = cfg.resolvedModelChain.length > 1;
    const currentProvider = cfg.resolvedModelChain[0]?.provider ?? "";
    const currentModel = cfg.resolvedModelChain[0]?.model ?? "";
    const currentProviderMeta = MODEL_PROVIDERS.find(
      (p) => p.id === currentProvider,
    );

    const modelSelectorPanel = (() => {
      if (isMultiLeg) {
        const chainFromEnv = !!process.env.MERCURY_MODEL_CHAIN;
        const chainYaml = cfg.resolvedModelChain
          .map(
            (leg) =>
              `    - provider: ${leg.provider}\n      model: ${leg.model}`,
          )
          .join("\n");
        const configSnippet = chainFromEnv
          ? `MERCURY_MODEL_CHAIN='${JSON.stringify(cfg.resolvedModelChain.map((l) => ({ provider: l.provider, model: l.model })))}'`
          : `model:\n  chain:\n${chainYaml}`;
        const sourceLabel = chainFromEnv
          ? `<span class="mono">MERCURY_MODEL_CHAIN</span> env var in <span class="mono">.env</span>`
          : `<span class="mono">model.chain</span> in <span class="mono">mercury.yaml</span>`;

        return `
          <div class="panel" style="margin-bottom:16px">
            <div class="panel-header" style="font-weight:600;font-size:13px">Active model</div>
            <div class="panel-body">
              ${renderModelBlock(cfg)}
              <p class="muted" style="font-size:12px;margin:8px 0 0">
                Configured via ${sourceLabel}. Edit that file to change.
              </p>
              <details style="margin-top:8px">
                <summary class="muted" style="font-size:12px;cursor:pointer">Copy config</summary>
                <pre style="margin:6px 0 0;padding:8px 10px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius,4px);font-size:12px;overflow-x:auto;cursor:pointer;position:relative"
                     onclick="navigator.clipboard.writeText(this.textContent.trim());var s=this.querySelector('.copy-hint');if(s){s.textContent='Copied!';setTimeout(function(){s.textContent='Click to copy'},1500)}">${escapeHtml(configSnippet)}<span class="copy-hint muted" style="position:absolute;top:4px;right:8px;font-size:11px">Click to copy</span></pre>
              </details>
            </div>
          </div>`;
      }

      const providerOptions = MODEL_PROVIDERS.map((p) => {
        const selected = p.id === currentProvider ? " selected" : "";
        const keySet = !!process.env[p.envVar];
        const suffix = keySet ? "" : " (no key)";
        return `<option value="${escapeHtml(p.id)}"${selected}>${escapeHtml(p.label)}${suffix}</option>`;
      }).join("");

      const currentInRegistry = getModels(
        currentProvider as KnownProvider,
      ).some((m) => m.id === currentModel);

      const modelOptions = getModels(currentProvider as KnownProvider);
      let modelOptionsHtml: string;
      if (modelOptions.length === 0) {
        modelOptionsHtml = `<input type="text" name="model" value="${escapeHtml(currentModel)}" required
          style="flex:1;min-width:200px;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:6px 10px;border-radius:var(--radius,4px);font-size:13px;font-family:monospace"
          placeholder="Enter model ID" />`;
      } else {
        const opts = modelOptions
          .map(
            (m) =>
              `<option value="${escapeHtml(m.id)}"${m.id === currentModel ? " selected" : ""}>${escapeHtml(m.name)}</option>`,
          )
          .join("");
        const customOpt =
          !currentInRegistry && currentModel
            ? `<option value="${escapeHtml(currentModel)}" selected>${escapeHtml(currentModel)} (not in registry)</option>`
            : "";
        modelOptionsHtml = `<select name="model" class="select" style="flex:1;min-width:200px">${customOpt}${opts}</select>`;
      }

      return `
        <div class="panel" style="margin-bottom:16px">
          <div class="panel-header" style="font-weight:600;font-size:13px">Active model</div>
          <div class="panel-body">
            <p class="muted" style="font-size:12px;margin:0 0 10px">
              Current: <span class="mono">${escapeHtml(currentProvider)}</span> / <span class="mono">${escapeHtml(currentModel)}</span>
            </p>
            <form hx-post="/dashboard/api/model/set" hx-target="#keys-feedback" hx-swap="innerHTML"
                  style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
              <select name="provider" class="select" style="min-width:160px"
                      hx-get="/dashboard/api/models" hx-trigger="change"
                      hx-target="#model-select-container" hx-swap="innerHTML">
                ${providerOptions}
              </select>
              <span id="model-select-container" style="display:flex;flex:1;min-width:200px">
                ${modelOptionsHtml}
              </span>
              <button class="btn btn-sm" type="submit">Save</button>
            </form>
            <p id="model-key-warning" class="muted" style="font-size:12px;margin:8px 0 0;${currentProviderMeta && process.env[currentProviderMeta.envVar] ? "display:none" : ""}">
              No API key set for this provider. Set one below or via <span class="mono">mercury auth login</span>.
            </p>
          </div>
        </div>`;
    })();

    const providerRows = MODEL_PROVIDERS.map((p) => {
      const isSet = !!process.env[p.envVar];
      const badge = isSet
        ? `<span class="badge" style="background:var(--color-success);color:#000;font-size:11px">SET</span>`
        : `<span class="badge" style="background:var(--border);color:var(--muted);font-size:11px">NOT SET</span>`;
      const clearBtn = isSet
        ? `<button class="btn btn-sm btn-danger" type="submit" form="clear-${p.id}" style="white-space:nowrap">Clear</button>
           <form id="clear-${p.id}" hx-post="/dashboard/api/keys/clear" hx-target="#keys-feedback" hx-swap="innerHTML" style="display:none">
             <input type="hidden" name="provider" value="${p.id}" />
           </form>`
        : "";
      return `
        <div style="display:grid;grid-template-columns:140px 60px 1fr auto auto;gap:10px;align-items:center;padding:10px 0;border-bottom:1px solid var(--border)">
          <span style="font-weight:500">${p.label}</span>
          ${badge}
          <form hx-post="/dashboard/api/keys/set" hx-target="#keys-feedback" hx-swap="innerHTML"
                style="display:flex;gap:8px;align-items:center">
            <input type="hidden" name="provider" value="${p.id}" />
            <input type="password" name="apiKey" placeholder="${p.placeholder}" autocomplete="off"
                   style="flex:1;min-width:0;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:6px 10px;border-radius:var(--radius,4px);font-size:13px;font-family:monospace" />
            <button class="btn btn-sm" type="submit">Save</button>
          </form>
          <span>${clearBtn}</span>
        </div>`;
    }).join("");

    return c.html(html`
      <div class="page-header">
        <h2>API keys</h2>
      </div>
      <p class="muted" style="margin: -8px 0 16px; font-size: 13px; line-height: 1.5;">
        Keys are written to <span class="mono">.env</span> and are <strong>never</strong> shown in plaintext.
        Mercury restarts automatically after saving.
      </p>

      <div id="keys-feedback" style="min-height:4px"></div>

      ${raw(modelSelectorPanel)}

      <div class="panel" style="margin-bottom:16px">
        <div class="panel-header" style="font-weight:600;font-size:13px">Model providers</div>
        <div class="panel-body" style="padding:0 16px">
          ${raw(providerRows)}
        </div>
      </div>

      <div class="panel">
        <div class="panel-body">
          <p class="muted" style="font-size:13px;margin:0">
            <strong>OAuth tokens</strong> (e.g. Anthropic via <span class="mono">mercury auth login</span>)
            live under <span class="mono">.mercury/global/</span> and take precedence over API keys set here.
            Use the CLI to log in with OAuth.
          </p>
        </div>
      </div>
    `);
  });

  app.post("/api/keys/set", async (c) => {
    // When managed by the Console, key editing is disabled in the dashboard.
    if (core.config.consoleUrl) {
      return c.html(
        renderFeaturesToast(
          "error",
          "Manage API keys from the Mercury Console.",
        ),
      );
    }

    const form = await c.req.parseBody();
    const provider =
      typeof form.provider === "string" ? form.provider.trim() : "";
    const apiKey = typeof form.apiKey === "string" ? form.apiKey.trim() : "";

    const meta = MODEL_PROVIDERS.find((p) => p.id === provider);
    if (!meta) {
      return c.html(renderFeaturesToast("error", "Unknown provider."));
    }
    if (!apiKey) {
      return c.html(renderFeaturesToast("error", "API key cannot be empty."));
    }

    try {
      const envPath = path.join(projectRoot, ".env");
      updateDotEnv(envPath, { [meta.envVar]: apiKey });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.html(
        renderFeaturesToast("error", `Failed to write .env: ${msg}`),
      );
    }

    setTimeout(() => process.kill(process.pid, "SIGTERM"), 500);
    return c.html(
      renderFeaturesToast("success", `${meta.label} key saved — restarting…`),
    );
  });

  app.post("/api/keys/clear", async (c) => {
    // When managed by the Console, key editing is disabled in the dashboard.
    if (core.config.consoleUrl) {
      return c.html(
        renderFeaturesToast(
          "error",
          "Manage API keys from the Mercury Console.",
        ),
      );
    }

    const form = await c.req.parseBody();
    const provider =
      typeof form.provider === "string" ? form.provider.trim() : "";

    const meta = MODEL_PROVIDERS.find((p) => p.id === provider);
    if (!meta) {
      return c.html(renderFeaturesToast("error", "Unknown provider."));
    }

    try {
      const envPath = path.join(projectRoot, ".env");
      updateDotEnv(envPath, { [meta.envVar]: null });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.html(
        renderFeaturesToast("error", `Failed to write .env: ${msg}`),
      );
    }

    setTimeout(() => process.kill(process.pid, "SIGTERM"), 500);
    return c.html(
      renderFeaturesToast("success", `${meta.label} key cleared — restarting…`),
    );
  });

  // ─── Model Selector ─────────────────────────────────────────────────────

  app.get("/api/models", (c) => {
    const provider = c.req.query("provider") ?? "";
    const meta = MODEL_PROVIDERS.find((p) => p.id === provider);
    const hasKey = meta ? !!process.env[meta.envVar] : false;
    const keyWarning = `<p id="model-key-warning" hx-swap-oob="true" class="muted" style="font-size:12px;margin:8px 0 0;${hasKey ? "display:none" : ""}">
      No API key set for this provider. Set one below or via <span class="mono">mercury auth login</span>.
    </p>`;

    const models = getModels(provider as KnownProvider);
    if (models.length === 0) {
      const placeholder = meta?.defaultModel ?? "model-id";
      return c.html(
        `<input type="text" name="model" required placeholder="${escapeHtml(placeholder)}"
          style="flex:1;min-width:200px;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:6px 10px;border-radius:var(--radius,4px);font-size:13px;font-family:monospace" />${keyWarning}`,
      );
    }
    const options = models
      .map(
        (m) =>
          `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)}</option>`,
      )
      .join("");
    return c.html(
      `<select name="model" class="select" style="flex:1;min-width:200px">${options}</select>${keyWarning}`,
    );
  });

  app.post("/api/model/set", async (c) => {
    if (core.config.consoleUrl) {
      return c.html(
        renderFeaturesToast(
          "error",
          "Model configuration is managed from the Mercury Console.",
        ),
      );
    }

    if (core.config.resolvedModelChain.length > 1) {
      return c.html(
        renderFeaturesToast(
          "error",
          "Model chain is configured — edit mercury.yaml or MERCURY_MODEL_CHAIN directly.",
        ),
      );
    }

    const form = await c.req.parseBody();
    const provider =
      typeof form.provider === "string" ? form.provider.trim() : "";
    const model = typeof form.model === "string" ? form.model.trim() : "";

    if (!provider) {
      return c.html(renderFeaturesToast("error", "Provider is required."));
    }
    if (!model) {
      return c.html(renderFeaturesToast("error", "Model is required."));
    }

    const meta = MODEL_PROVIDERS.find((p) => p.id === provider);
    const providerLabel = meta?.label ?? provider;

    try {
      const envPath = path.join(projectRoot, ".env");
      updateDotEnv(envPath, {
        MERCURY_MODEL_PROVIDER: provider,
        MERCURY_MODEL: model,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.html(
        renderFeaturesToast("error", `Failed to write .env: ${msg}`),
      );
    }

    setTimeout(() => process.kill(process.pid, "SIGTERM"), 500);
    return c.html(
      renderFeaturesToast(
        "success",
        `Model set to ${providerLabel} / ${model} — restarting…`,
      ),
    );
  });

  // ─── SSE Stream ─────────────────────────────────────────────────────────

  app.get("/events", (c) => {
    return streamSSE(c, async (stream) => {
      const sendEvent = async (event: string, data: string) => {
        await stream.writeSSE({ event, data: data.replace(/\n/g, "") });
      };

      const renderHealth = () => {
        const health = getSystemHealth();
        const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
        const icon =
          health.status === "healthy"
            ? "🟢"
            : health.status === "degraded"
              ? "🟡"
              : "🔴";
        const lastError = health.lastError
          ? `Last error: ${health.lastError}`
          : "";

        return `
          <div class="health-status ${health.status}">
            <span class="health-icon">${icon}</span>
            <span class="health-message">${health.message}</span>
          </div>
          <div class="health-meta">
            <span class="uptime">up ${formatUptime(uptimeSeconds)}</span>
            ${lastError ? `<span class="last-error">${lastError}</span>` : ""}
          </div>
        `;
      };

      const renderActiveCount = () => {
        const count = core.containerRunner.activeCount;
        return count > 0
          ? `<span class="badge pulse">${count} running</span>`
          : "";
      };

      // Send initial state
      await sendEvent("health", renderHealth());
      await sendEvent("active-count", renderActiveCount());

      // Update loop
      let running = true;
      let lastActiveCount = core.containerRunner.activeCount;

      stream.onAbort(() => {
        running = false;
      });

      while (running) {
        await stream.sleep(1000);

        // Always update health (includes uptime)
        await sendEvent("health", renderHealth());

        // Update active count only on change
        const currentActiveCount = core.containerRunner.activeCount;
        if (currentActiveCount !== lastActiveCount) {
          await sendEvent("active-count", renderActiveCount());
          lastActiveCount = currentActiveCount;
        }
      }
    });
  });

  // ─── Dashboard Actions (no auth required, admin-only UI) ────────────────

  app.post("/api/tasks/:id/run", async (c) => {
    const taskId = Number.parseInt(c.req.param("id"), 10);
    const task = core.db.listTasks().find((t) => t.id === taskId);

    if (!task) {
      return c.json({ error: "Task not found" }, 404);
    }

    const triggered = await core.scheduler.triggerTask(taskId);
    if (!triggered) {
      return c.json({ error: "Task not found or inactive" }, 400);
    }

    return c.json({ ok: true });
  });

  app.post("/api/tasks/:id/pause", (c) => {
    const taskId = Number.parseInt(c.req.param("id"), 10);
    const task = core.db.listTasks().find((t) => t.id === taskId);

    if (!task) {
      return c.json({ error: "Task not found" }, 404);
    }

    core.db.setTaskActive(taskId, false);
    return c.json({ ok: true });
  });

  app.post("/api/tasks/:id/resume", (c) => {
    const taskId = Number.parseInt(c.req.param("id"), 10);
    const task = core.db.listTasks().find((t) => t.id === taskId);

    if (!task) {
      return c.json({ error: "Task not found" }, 404);
    }

    core.db.setTaskActive(taskId, true);
    return c.json({ ok: true });
  });

  app.delete("/api/tasks/:id", (c) => {
    const taskId = Number.parseInt(c.req.param("id"), 10);
    const task = core.db.listTasks().find((t) => t.id === taskId);

    if (!task) {
      return c.json({ error: "Task not found" }, 404);
    }

    const deleted = core.db.deleteTask(taskId, task.spaceId);
    if (!deleted) {
      return c.json({ error: "Failed to delete task" }, 500);
    }

    return c.json({ ok: true });
  });

  app.post("/api/roles", async (c) => {
    const form = await c.req.parseBody();
    const spaceId = typeof form.spaceId === "string" ? form.spaceId.trim() : "";
    const platformUserId =
      typeof form.platformUserId === "string" ? form.platformUserId.trim() : "";
    const role = typeof form.role === "string" ? form.role.trim() : "";

    if (!spaceId || !platformUserId || !role) {
      return c.json({ error: "Missing spaceId, platformUserId, or role" }, 400);
    }

    core.db.setRole(spaceId, platformUserId, role, "dashboard");
    return c.json({ ok: true });
  });

  app.delete("/api/roles", (c) => {
    const spaceId = c.req.query("spaceId");
    const platformUserId = c.req.query("platformUserId");

    if (!spaceId || !platformUserId) {
      return c.json({ error: "Missing spaceId or platformUserId" }, 400);
    }

    core.db.deleteRole(spaceId, platformUserId);
    return c.json({ ok: true });
  });

  app.delete("/api/mutes", (c) => {
    const spaceId = c.req.query("spaceId");
    const platformUserId = c.req.query("platformUserId");

    if (!spaceId || !platformUserId) {
      return c.json({ error: "Missing spaceId or platformUserId" }, 400);
    }

    const removed = core.db.unmuteUser(spaceId, platformUserId);
    if (!removed) {
      return c.json({ error: "User is not muted in this space" }, 404);
    }

    return c.json({ ok: true });
  });

  app.post("/api/prefs", async (c) => {
    const form = await c.req.parseBody();
    const spaceId = typeof form.spaceId === "string" ? form.spaceId.trim() : "";
    const key = typeof form.key === "string" ? form.key.trim() : "";
    const value = typeof form.value === "string" ? form.value : "";

    if (!spaceId || !key) {
      return c.json({ error: "Missing spaceId or key" }, 400);
    }

    const keyErr = validatePrefKey(key);
    if (keyErr) return c.json({ error: keyErr }, 400);

    const valErr = validatePrefValue(value);
    if (valErr) return c.json({ error: valErr }, 400);

    if (!core.db.getSpace(spaceId)) {
      return c.json({ error: "Space not found" }, 404);
    }

    try {
      core.db.setSpacePreference(spaceId, key, value, "dashboard");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("Maximum 50")) {
        return c.json({ error: msg }, 400);
      }
      throw e;
    }

    return c.json({ ok: true });
  });

  app.post("/api/space-config", async (c) => {
    const form = await c.req.parseBody();
    const spaceId = typeof form.spaceId === "string" ? form.spaceId.trim() : "";
    const key = typeof form.key === "string" ? form.key.trim() : "";
    const value = typeof form.value === "string" ? form.value : "";

    if (!spaceId || !key) {
      return c.json({ error: "Missing spaceId or key" }, 400);
    }

    const err = validateDashboardBuiltinConfig(key, value);
    if (err) return c.json({ error: err }, 400);

    if (!core.db.getSpace(spaceId)) {
      return c.json({ error: "Space not found" }, 404);
    }

    core.db.setSpaceConfig(spaceId, key, value, "dashboard");
    return c.json({ ok: true });
  });

  app.delete("/api/space-config", (c) => {
    const spaceId = c.req.query("spaceId");
    const key = c.req.query("key");

    if (!spaceId || !key) {
      return c.json({ error: "Missing spaceId or key" }, 400);
    }

    if (!isBuiltinConfigKey(key)) {
      return c.json({ error: "Invalid config key" }, 400);
    }

    const removed = core.db.deleteSpaceConfig(spaceId, key);
    if (!removed) {
      return c.json({ error: "Config key not set" }, 404);
    }

    return c.json({ ok: true });
  });

  app.delete("/api/prefs", (c) => {
    const spaceId = c.req.query("spaceId");
    const key = c.req.query("key");

    if (!spaceId || !key) {
      return c.json({ error: "Missing spaceId or key" }, 400);
    }

    const keyErr = validatePrefKey(key);
    if (keyErr) return c.json({ error: keyErr }, 400);

    const removed = core.db.deleteSpacePreference(spaceId, key);
    if (!removed) {
      return c.json({ error: "Preference not found" }, 404);
    }

    return c.json({ ok: true });
  });

  app.post("/api/voice-transcribe", async (c) => {
    const reg = configRegistry;
    if (!reg?.isValidKey(VT_KEY.model)) {
      return c.json(
        { error: "Voice transcription extension is not loaded" },
        400,
      );
    }

    const form = await c.req.parseBody();
    const spaceId = typeof form.spaceId === "string" ? form.spaceId.trim() : "";
    const intentRaw = form.intent;
    const intent =
      typeof intentRaw === "string"
        ? intentRaw.trim()
        : Array.isArray(intentRaw)
          ? String(intentRaw[0] ?? "").trim()
          : "";

    if (!spaceId) {
      return c.json({ error: "Missing spaceId" }, 400);
    }

    if (!core.db.getSpace(spaceId)) {
      return c.json({ error: "Space not found" }, 404);
    }

    if (intent === "reset") {
      core.db.deleteSpaceConfig(spaceId, VT_KEY.provider);
      core.db.deleteSpaceConfig(spaceId, VT_KEY.local_engine);
      core.db.deleteSpaceConfig(spaceId, VT_KEY.model);
      return c.json({ ok: true });
    }

    if (intent !== "apply") {
      return c.json({ error: "Missing or invalid intent" }, 400);
    }

    const presetRaw = form.preset;
    const preset =
      typeof presetRaw === "string"
        ? presetRaw.trim()
        : Array.isArray(presetRaw)
          ? String(presetRaw[0] ?? "").trim()
          : "";

    let provider: string;
    let local_engine: string;
    let model: string;

    if (preset === "custom") {
      const cp = form.custom_provider;
      const cl = form.custom_local_engine;
      const cm = form.custom_model;
      provider =
        typeof cp === "string"
          ? cp.trim()
          : Array.isArray(cp)
            ? String(cp[0] ?? "").trim()
            : "";
      local_engine =
        typeof cl === "string"
          ? cl.trim()
          : Array.isArray(cl)
            ? String(cl[0] ?? "").trim()
            : "";
      model =
        typeof cm === "string"
          ? cm.trim()
          : Array.isArray(cm)
            ? String(cm[0] ?? "").trim()
            : "";

      if (!model) {
        return c.json({ error: "Custom model id is required" }, 400);
      }
      if (model.length > VOICE_CUSTOM_MODEL_MAX_LEN) {
        return c.json({ error: "Model id too long" }, 400);
      }
    } else {
      const pr = VOICE_TRANSCRIBE_PRESETS.find((p) => p.id === preset);
      if (!pr) {
        return c.json({ error: "Invalid preset" }, 400);
      }
      ({ provider, local_engine, model } = pr);
    }

    const triplet: [string, string][] = [
      [VT_KEY.provider, provider],
      [VT_KEY.local_engine, local_engine],
      [VT_KEY.model, model],
    ];
    for (const [key, value] of triplet) {
      if (!reg.validate(key, value)) {
        return c.json({ error: `Invalid value for ${key}` }, 400);
      }
    }

    for (const [key, value] of triplet) {
      core.db.setSpaceConfig(spaceId, key, value, "dashboard");
    }

    return c.json({ ok: true });
  });

  app.post("/api/voice-synth", async (c) => {
    const reg = configRegistry;
    if (!reg?.isValidKey(VS_KEY.mode)) {
      return c.json({ error: "Voice synthesis extension is not loaded" }, 400);
    }

    const form = await c.req.parseBody();
    const spaceId = typeof form.spaceId === "string" ? form.spaceId.trim() : "";
    const intentRaw = form.intent;
    const intent =
      typeof intentRaw === "string"
        ? intentRaw.trim()
        : Array.isArray(intentRaw)
          ? String(intentRaw[0] ?? "").trim()
          : "";

    if (!spaceId) {
      return c.json({ error: "Missing spaceId" }, 400);
    }

    if (!core.db.getSpace(spaceId)) {
      return c.json({ error: "Space not found" }, 404);
    }

    if (intent === "reset") {
      core.db.deleteSpaceConfig(spaceId, VS_KEY.mode);
      core.db.deleteSpaceConfig(spaceId, VS_KEY.auto);
      return c.json({ ok: true });
    }

    if (intent !== "apply") {
      return c.json({ error: "Missing or invalid intent" }, 400);
    }

    const modeRaw = form.mode;
    const mode =
      typeof modeRaw === "string"
        ? modeRaw.trim()
        : Array.isArray(modeRaw)
          ? String(modeRaw[0] ?? "").trim()
          : "";

    if (!reg.validate(VS_KEY.mode, mode)) {
      return c.json({ error: "Invalid mode" }, 400);
    }

    core.db.setSpaceConfig(spaceId, VS_KEY.mode, mode, "dashboard");
    core.db.deleteSpaceConfig(spaceId, VS_KEY.auto);

    return c.json({ ok: true });
  });

  app.post("/api/mutes", async (c) => {
    const form = await c.req.parseBody();
    const spaceId = typeof form.spaceId === "string" ? form.spaceId.trim() : "";
    const platformUserId =
      typeof form.platformUserId === "string" ? form.platformUserId.trim() : "";
    const duration =
      typeof form.duration === "string" ? form.duration.trim() : "";
    const reason =
      typeof form.reason === "string" && form.reason.trim()
        ? form.reason.trim()
        : undefined;

    if (!spaceId || !platformUserId || !duration) {
      return c.json(
        { error: "Missing spaceId, platformUserId, or duration" },
        400,
      );
    }

    if (!core.db.getSpace(spaceId)) {
      return c.json({ error: "Space not found" }, 404);
    }

    const durationMs = parseMuteDuration(duration);
    if (!durationMs) {
      return c.json(
        {
          error: `Invalid duration: "${duration}". Use e.g. 10m, 1h, 24h, 7d`,
        },
        400,
      );
    }

    const expiresAt = Date.now() + durationMs;
    core.db.muteUser(spaceId, platformUserId, expiresAt, "dashboard", reason);

    return c.json({
      ok: true,
      platformUserId,
      expiresAt,
      duration,
      reason: reason ?? null,
    });
  });

  app.post("/api/conversations/:id/link", async (c) => {
    const conversationId = Number.parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(conversationId) || conversationId < 1) {
      return c.json({ error: "Invalid conversation ID" }, 400);
    }

    const form = await c.req.parseBody();
    const spaceId = typeof form.spaceId === "string" ? form.spaceId : undefined;
    if (!spaceId) {
      return c.json({ error: "Missing spaceId" }, 400);
    }

    const space = core.db.getSpace(spaceId);
    if (!space) {
      return c.json({ error: "Space not found" }, 404);
    }

    const linked = core.db.linkConversation(conversationId, spaceId);
    if (!linked) {
      return c.json({ error: "Conversation not found" }, 404);
    }

    return c.json({ ok: true });
  });

  app.post("/api/conversations/:id/unlink", (c) => {
    const conversationId = Number.parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(conversationId) || conversationId < 1) {
      return c.json({ error: "Invalid conversation ID" }, 400);
    }

    const unlinked = core.db.unlinkConversation(conversationId);
    if (!unlinked) {
      return c.json({ error: "Conversation not found" }, 404);
    }

    return c.json({ ok: true });
  });

  app.post("/api/stop", (c) => {
    const spaceId = c.req.header("X-Mercury-Space");

    if (!spaceId) {
      return c.json({ error: "Missing X-Mercury-Space header" }, 400);
    }

    core.containerRunner.abort(spaceId);
    return c.json({ ok: true });
  });

  app.post("/api/extensions/install", async (c) => {
    const form = await c.req.parseBody();
    const name = typeof form.name === "string" ? form.name.trim() : "";
    if (!name) {
      return c.html(renderFeaturesToast("error", "Missing extension name."));
    }
    const entry = getCatalogEntryByName(name);
    if (!entry) {
      return c.html(renderFeaturesToast("error", "Unknown catalog extension."));
    }
    const src = resolveExamplesExtensionDir(packageRoot, entry.sourceDir);
    if (!existsSync(src)) {
      return c.html(
        renderFeaturesToast(
          "error",
          "Bundled extension source not found. Use a mercury-agent install that includes examples/, or run: mercury add <path>",
        ),
      );
    }
    const result = await installExtensionFromDirectory({
      cwd: projectRoot,
      sourceDir: src,
      destName: entry.name,
    });
    if (!result.ok) {
      return c.html(renderFeaturesToast("error", result.error));
    }
    setTimeout(() => process.kill(process.pid, "SIGTERM"), 500);
    return c.html(
      renderFeaturesToast(
        "success",
        `Extension "${entry.name}" installed — restarting…`,
      ),
    );
  });

  app.delete("/api/extensions/:name", (c) => {
    const name = c.req.param("name");
    const result = removeInstalledExtension({ cwd: projectRoot, name });
    if (!result.ok) {
      return c.html(renderFeaturesToast("error", result.error));
    }
    setTimeout(() => process.kill(process.pid, "SIGTERM"), 500);
    return c.html(
      renderFeaturesToast(
        "success",
        `Extension "${name}" removed — restarting…`,
      ),
    );
  });

  return app;
}

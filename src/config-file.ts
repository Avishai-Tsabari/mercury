import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  MAX_MODEL_CHAIN_LEGS,
  parseModelLegsArray,
} from "./config-model-chain.js";

/** Env-only: never loaded from mercury.yaml (secrets). */
const SECRET_SCHEMA_KEYS = new Set([
  "apiSecret",
  "chatApiKey",
  "consoleUrl",
  "consoleInternalSecret",
  "discordGatewaySecret",
  "azureSpeechKey",
]);

const modelLegYamlSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
});

const mercuryFileSchema = z
  .object({
    server: z
      .object({
        port: z.number().int().min(1).max(65535).optional(),
        bot_username: z.string().optional(),
      })
      .strict()
      .optional(),

    model: z
      .object({
        chain: z.array(modelLegYamlSchema).max(MAX_MODEL_CHAIN_LEGS).optional(),
        provider: z.string().optional(),
        model: z.string().optional(),
        fallback_provider: z.string().optional(),
        fallback: z.string().optional(),
        max_retries_per_leg: z.number().int().min(0).max(5).optional(),
        chain_budget_ms: z
          .number()
          .int()
          .min(5000)
          .max(55 * 60 * 1000)
          .optional(),
        capabilities: z.record(z.string(), z.unknown()).optional(),
      })
      .strict()
      .optional(),

    /** Top-level alias for `model.chain` */
    model_chain: z
      .array(modelLegYamlSchema)
      .max(MAX_MODEL_CHAIN_LEGS)
      .optional(),

    ingress: z
      .object({
        discord: z.boolean().optional(),
        slack: z.boolean().optional(),
        teams: z.boolean().optional(),
        whatsapp: z.boolean().optional(),
        telegram: z.boolean().optional(),
      })
      .strict()
      .optional(),

    runtime: z
      .object({
        data_dir: z.string().optional(),
        auth_path: z.string().optional(),
        whatsapp_auth_dir: z.string().optional(),
        max_concurrency: z.number().int().min(1).max(32).optional(),
        log_level: z
          .enum(["debug", "info", "warn", "error", "silent"])
          .optional(),
        log_format: z.enum(["text", "json"]).optional(),
        rate_limit_per_user: z.number().int().min(1).max(1000).optional(),
        rate_limit_window_ms: z
          .number()
          .int()
          .min(1000)
          .max(60 * 60 * 1000)
          .optional(),
        rate_limit_daily_member: z.number().int().min(0).max(10000).optional(),
        rate_limit_daily_admin: z.number().int().min(0).max(10000).optional(),
      })
      .strict()
      .optional(),

    scheduling: z
      .object({
        default_timezone: z.string().optional(),
      })
      .strict()
      .optional(),

    trigger: z
      .object({
        patterns: z.string().optional(),
        match: z.string().optional(),
      })
      .strict()
      .optional(),

    context: z
      .object({
        mode: z.enum(["clear", "context"]).optional(),
        window_size: z.number().int().min(1).max(50).optional(),
        reply_chain_depth: z.number().int().min(1).max(50).optional(),
      })
      .strict()
      .optional(),

    agent: z
      .object({
        image: z.string().optional(),
        container_timeout_ms: z
          .number()
          .int()
          .min(10_000)
          .max(60 * 60 * 1000)
          .optional(),
        container_bwrap_docker_compat: z.boolean().optional(),
        override_pi_system_prompt: z.boolean().optional(),
      })
      .strict()
      .optional(),

    discord: z
      .object({
        gateway_duration_ms: z
          .number()
          .int()
          .min(60_000)
          .max(60 * 60 * 1000)
          .optional(),
      })
      .strict()
      .optional(),

    telegram: z
      .object({
        format_enabled: z.boolean().optional(),
      })
      .strict()
      .optional(),

    media: z
      .object({
        enabled: z.boolean().optional(),
        max_size_mb: z.number().min(1).max(100).optional(),
      })
      .strict()
      .optional(),

    permissions: z
      .object({
        admins: z.string().optional(),
      })
      .strict()
      .optional(),

    dm_auto_space: z
      .object({
        enabled: z.boolean().optional(),
        admin_ids: z.array(z.string()).optional(),
        default_system_prompt: z.string().optional(),
        default_member_permissions: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

type MercuryFile = z.infer<typeof mercuryFileSchema>;

export type RawMercuryConfigInput = Record<string, unknown>;

function resolveConfigPath(cwd: string): string | null {
  const explicit = process.env.MERCURY_CONFIG_FILE;
  if (explicit !== undefined) {
    const t = explicit.trim();
    if (t === "" || t.toLowerCase() === "none") return null;
    return path.isAbsolute(t) ? t : path.join(cwd, t);
  }
  const yml = path.join(cwd, "mercury.yaml");
  if (existsSync(yml)) return yml;
  const yml2 = path.join(cwd, "mercury.yml");
  if (existsSync(yml2)) return yml2;
  return null;
}

function flattenMercuryFile(f: MercuryFile): RawMercuryConfigInput {
  const o: RawMercuryConfigInput = {};

  if (f.server?.port != null) o.port = f.server.port;
  if (f.server?.bot_username != null) o.botUsername = f.server.bot_username;

  const chainFromModel = f.model?.chain;
  const chainTop = f.model_chain;
  const chainRaw = chainFromModel ?? chainTop;
  if (chainRaw != null && chainRaw.length > 0) {
    const legs = parseModelLegsArray(chainRaw, "mercury.yaml model chain");
    o.modelChain = JSON.stringify(legs);
  }
  if (f.model?.provider != null) o.modelProvider = f.model.provider;
  if (f.model?.model != null) o.model = f.model.model;
  if (f.model?.fallback_provider != null) {
    o.modelFallbackProvider = f.model.fallback_provider;
  }
  if (f.model?.fallback != null) o.modelFallback = f.model.fallback;
  if (f.model?.max_retries_per_leg != null) {
    o.modelMaxRetriesPerLeg = f.model.max_retries_per_leg;
  }
  if (f.model?.chain_budget_ms != null) {
    o.modelChainBudgetMs = f.model.chain_budget_ms;
  }
  if (f.model?.capabilities != null) {
    o.modelCapabilitiesEnv = JSON.stringify(f.model.capabilities);
  }

  if (f.ingress?.discord != null) o.enableDiscord = f.ingress.discord;
  if (f.ingress?.slack != null) o.enableSlack = f.ingress.slack;
  if (f.ingress?.teams != null) o.enableTeams = f.ingress.teams;
  if (f.ingress?.whatsapp != null) o.enableWhatsApp = f.ingress.whatsapp;
  if (f.ingress?.telegram != null) o.enableTelegram = f.ingress.telegram;

  if (f.runtime?.data_dir != null) o.dataDir = f.runtime.data_dir;
  if (f.runtime?.auth_path != null) o.authPath = f.runtime.auth_path;
  if (f.runtime?.whatsapp_auth_dir != null) {
    o.whatsappAuthDir = f.runtime.whatsapp_auth_dir;
  }
  if (f.runtime?.max_concurrency != null) {
    o.maxConcurrency = f.runtime.max_concurrency;
  }
  if (f.runtime?.log_level != null) o.logLevel = f.runtime.log_level;
  if (f.runtime?.log_format != null) o.logFormat = f.runtime.log_format;
  if (f.runtime?.rate_limit_per_user != null) {
    o.rateLimitPerUser = f.runtime.rate_limit_per_user;
  }
  if (f.runtime?.rate_limit_window_ms != null) {
    o.rateLimitWindowMs = f.runtime.rate_limit_window_ms;
  }
  if (f.runtime?.rate_limit_daily_member != null) {
    o.rateLimitDailyMember = f.runtime.rate_limit_daily_member;
  }
  if (f.runtime?.rate_limit_daily_admin != null) {
    o.rateLimitDailyAdmin = f.runtime.rate_limit_daily_admin;
  }

  if (f.scheduling?.default_timezone != null) {
    o.defaultTimezone = f.scheduling.default_timezone;
  }

  if (f.trigger?.patterns != null) o.triggerPatterns = f.trigger.patterns;
  if (f.trigger?.match != null) o.triggerMatch = f.trigger.match;

  if (f.context?.mode != null) o.contextMode = f.context.mode;
  if (f.context?.window_size != null) {
    o.contextWindowSize = f.context.window_size;
  }
  if (f.context?.reply_chain_depth != null) {
    o.contextReplyChainDepth = f.context.reply_chain_depth;
  }

  if (f.agent?.image != null) o.agentContainerImage = f.agent.image;
  if (f.agent?.container_timeout_ms != null) {
    o.containerTimeoutMs = f.agent.container_timeout_ms;
  }
  if (f.agent?.container_bwrap_docker_compat != null) {
    o.containerBwrapDockerCompat = f.agent.container_bwrap_docker_compat;
  }
  if (f.agent?.override_pi_system_prompt != null) {
    o.overridePiSystemPrompt = f.agent.override_pi_system_prompt;
  }

  if (f.discord?.gateway_duration_ms != null) {
    o.discordGatewayDurationMs = f.discord.gateway_duration_ms;
  }

  if (f.telegram?.format_enabled != null) {
    o.telegramFormatEnabled = f.telegram.format_enabled;
  }

  if (f.media?.enabled != null) o.mediaEnabled = f.media.enabled;
  if (f.media?.max_size_mb != null) o.mediaMaxSizeMb = f.media.max_size_mb;

  if (f.permissions?.admins != null) o.admins = f.permissions.admins;

  if (f.dm_auto_space?.enabled != null) {
    o.dmAutoSpaceEnabled = f.dm_auto_space.enabled;
  }
  if (f.dm_auto_space?.admin_ids != null) {
    o.dmAutoSpaceAdminIds = f.dm_auto_space.admin_ids.join(",");
  }
  if (f.dm_auto_space?.default_system_prompt != null) {
    o.dmAutoSpaceDefaultSystemPrompt = f.dm_auto_space.default_system_prompt;
  }
  if (f.dm_auto_space?.default_member_permissions != null) {
    o.dmAutoSpaceDefaultMemberPermissions =
      f.dm_auto_space.default_member_permissions;
  }

  return o;
}

/** camelCase schema key → MERCURY_* env name */
const CAMEL_TO_ENV: Record<string, string> = {
  logLevel: "MERCURY_LOG_LEVEL",
  logFormat: "MERCURY_LOG_FORMAT",
  modelProvider: "MERCURY_MODEL_PROVIDER",
  model: "MERCURY_MODEL",
  modelFallbackProvider: "MERCURY_MODEL_FALLBACK_PROVIDER",
  modelFallback: "MERCURY_MODEL_FALLBACK",
  modelChain: "MERCURY_MODEL_CHAIN",
  modelMaxRetriesPerLeg: "MERCURY_MODEL_MAX_RETRIES_PER_LEG",
  modelChainBudgetMs: "MERCURY_MODEL_CHAIN_BUDGET_MS",
  modelCapabilitiesEnv: "MERCURY_MODEL_CAPABILITIES",
  triggerPatterns: "MERCURY_TRIGGER_PATTERNS",
  triggerMatch: "MERCURY_TRIGGER_MATCH",
  contextMode: "MERCURY_CONTEXT_MODE",
  contextWindowSize: "MERCURY_CONTEXT_WINDOW_SIZE",
  contextReplyChainDepth: "MERCURY_CONTEXT_REPLY_CHAIN_DEPTH",
  dataDir: "MERCURY_DATA_DIR",
  maxDiskMb: "MERCURY_MAX_DISK_MB",
  inboxTtlDays: "MERCURY_INBOX_TTL_DAYS",
  outboxTtlDays: "MERCURY_OUTBOX_TTL_DAYS",
  cleanupIntervalMs: "MERCURY_CLEANUP_INTERVAL_MS",
  authPath: "MERCURY_AUTH_PATH",
  whatsappAuthDir: "MERCURY_WHATSAPP_AUTH_DIR",
  agentContainerImage: "MERCURY_AGENT_IMAGE",
  containerTimeoutMs: "MERCURY_CONTAINER_TIMEOUT_MS",
  containerRuntime: "MERCURY_CONTAINER_RUNTIME",
  containerNetwork: "MERCURY_CONTAINER_NETWORK",
  containerApiHost: "MERCURY_CONTAINER_API_HOST",
  containerBwrapDockerCompat: "MERCURY_CONTAINER_BWRAP_DOCKER_COMPAT",
  overridePiSystemPrompt: "MERCURY_OVERRIDE_PI_SYSTEM_PROMPT",
  maxConcurrency: "MERCURY_MAX_CONCURRENCY",
  rateLimitPerUser: "MERCURY_RATE_LIMIT_PER_USER",
  rateLimitWindowMs: "MERCURY_RATE_LIMIT_WINDOW_MS",
  port: "MERCURY_PORT",
  botUsername: "MERCURY_BOT_USERNAME",
  enableDiscord: "MERCURY_ENABLE_DISCORD",
  discordGatewayDurationMs: "MERCURY_DISCORD_GATEWAY_DURATION_MS",
  discordGatewaySecret: "MERCURY_DISCORD_GATEWAY_SECRET",
  enableSlack: "MERCURY_ENABLE_SLACK",
  enableTeams: "MERCURY_ENABLE_TEAMS",
  enableWhatsApp: "MERCURY_ENABLE_WHATSAPP",
  enableTelegram: "MERCURY_ENABLE_TELEGRAM",
  telegramFormatEnabled: "MERCURY_TELEGRAM_FORMAT_ENABLED",
  mediaEnabled: "MERCURY_MEDIA_ENABLED",
  mediaMaxSizeMb: "MERCURY_MEDIA_MAX_SIZE_MB",
  admins: "MERCURY_ADMINS",
  apiSecret: "MERCURY_API_SECRET",
  chatApiKey: "MERCURY_CHAT_API_KEY",
  consoleUrl: "MERCURY_CONSOLE_URL",
  consoleUserId: "MERCURY_CONSOLE_USER_ID",
  consoleInternalSecret: "MERCURY_CONSOLE_INTERNAL_SECRET",
  tsAllowLiveOrders: "MERCURY_TS_ALLOW_LIVE_ORDERS",
  ttsProvider: "MERCURY_TTS_PROVIDER",
  azureSpeechKey: "MERCURY_AZURE_SPEECH_KEY",
  azureSpeechRegion: "MERCURY_AZURE_SPEECH_REGION",
  googleApplicationCredentials: "MERCURY_GOOGLE_APPLICATION_CREDENTIALS",
  ttsMaxChars: "MERCURY_TTS_MAX_CHARS",
  defaultTimezone: "MERCURY_DEFAULT_TIMEZONE",
  rateLimitDailyMember: "MERCURY_RATE_LIMIT_DAILY_MEMBER",
  rateLimitDailyAdmin: "MERCURY_RATE_LIMIT_DAILY_ADMIN",
  dmAutoSpaceEnabled: "MERCURY_DM_AUTO_SPACE_ENABLED",
  dmAutoSpaceAdminIds: "MERCURY_DM_AUTO_SPACE_ADMIN_IDS",
  dmAutoSpaceDefaultSystemPrompt: "MERCURY_DM_AUTO_SPACE_DEFAULT_SYSTEM_PROMPT",
  dmAutoSpaceDefaultMemberPermissions:
    "MERCURY_DM_AUTO_SPACE_DEFAULT_MEMBER_PERMISSIONS",
};

function envValueForSchema(
  env: NodeJS.ProcessEnv,
  envKey: string,
): string | undefined {
  if (!Object.hasOwn(env, envKey)) return undefined;
  return env[envKey];
}

/**
 * Merge optional mercury.yaml with process.env. Env wins whenever the MERCURY_*
 * key is present (even if empty). File values are ignored for secret keys.
 */
export function mergeRawMercuryConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): RawMercuryConfigInput {
  const configPath = resolveConfigPath(cwd);
  let fromFile: RawMercuryConfigInput = {};

  if (configPath) {
    let rawYaml: unknown;
    try {
      rawYaml = parseYaml(readFileSync(configPath, "utf-8"));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Failed to read mercury config ${configPath}: ${msg}`);
    }
    if (rawYaml == null) rawYaml = {};
    const parsed = mercuryFileSchema.safeParse(rawYaml);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      throw new Error(`Invalid mercury.yaml at ${configPath}: ${issues}`);
    }
    fromFile = flattenMercuryFile(parsed.data);
    for (const secretKey of SECRET_SCHEMA_KEYS) {
      delete fromFile[secretKey];
    }
  }

  const merged: RawMercuryConfigInput = { ...fromFile };

  for (const [camel, envKey] of Object.entries(CAMEL_TO_ENV)) {
    if (envValueForSchema(env, envKey) !== undefined) {
      merged[camel] = env[envKey];
    }
  }

  // Standard GCP env (when MERCURY_GOOGLE_APPLICATION_CREDENTIALS not set)
  if (
    merged.googleApplicationCredentials == null &&
    envValueForSchema(env, "GOOGLE_APPLICATION_CREDENTIALS") !== undefined
  ) {
    merged.googleApplicationCredentials = env.GOOGLE_APPLICATION_CREDENTIALS;
  }

  return merged;
}

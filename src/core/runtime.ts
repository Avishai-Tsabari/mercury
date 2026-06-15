import { ContainerError } from "../agent/container-error.js";
import { AgentContainerRunner } from "../agent/container-runner.js";
import {
  classifyUserError,
  friendlyErrorMessage,
} from "../agent/user-error-messages.js";
import { type AppConfig, resolveProjectPath } from "../config.js";
import { createMercuryExtensionContext } from "../extensions/context.js";
import { HookDispatcher } from "../extensions/hooks.js";
import type { ExtensionRegistry } from "../extensions/loader.js";
import type { MercuryExtensionContext } from "../extensions/types.js";
import { logger } from "../logger.js";
import { Db } from "../storage/db.js";
import {
  ensurePiResourceDir,
  ensureSpaceWorkspace,
} from "../storage/memory.js";
import type {
  ContainerResult,
  IngressMessage,
  MessageAttachment,
  MessageRunMeta,
  MessageSender,
  TokenUsage,
} from "../types.js";
import { formatCategoryHelp, formatHelp } from "./commands.js";
import { hasPermission, resolveRole } from "./permissions.js";
import { RateLimiter } from "./rate-limiter.js";
import { type RouteResult, routeInput } from "./router.js";
import { SpaceQueue } from "./space-queue.js";
import { TaskScheduler } from "./task-scheduler.js";

export type InputSource = "cli" | "scheduler" | "chat-sdk";

export type ShutdownHook = () => Promise<void> | void;

function agentMetaFromUsage(
  usage: TokenUsage | undefined,
): MessageRunMeta["agent"] {
  if (!usage) return undefined;
  const a: NonNullable<MessageRunMeta["agent"]> = {};
  if (usage.inputTokens != null) a.inputTokens = usage.inputTokens;
  if (usage.outputTokens != null) a.outputTokens = usage.outputTokens;
  if (usage.totalTokens != null) a.totalTokens = usage.totalTokens;
  if (usage.cacheReadTokens != null) a.cacheReadTokens = usage.cacheReadTokens;
  if (usage.cacheWriteTokens != null)
    a.cacheWriteTokens = usage.cacheWriteTokens;
  if (usage.cost != null) a.cost = usage.cost;
  if (usage.model != null) a.model = usage.model;
  if (usage.provider != null) a.provider = usage.provider;
  if (Object.keys(a).length === 0) return undefined;
  return a;
}

function userTurnRunMeta(agentUsage?: TokenUsage): MessageRunMeta {
  const meta: MessageRunMeta = {};
  const agent = agentMetaFromUsage(agentUsage);
  if (agent) meta.agent = agent;
  return meta;
}

export class MercuryCoreRuntime {
  readonly db: Db;
  readonly scheduler: TaskScheduler;
  readonly queue: SpaceQueue;
  readonly containerRunner: AgentContainerRunner;
  readonly rateLimiter: RateLimiter;
  hooks: HookDispatcher | null = null;
  private extensionCtx: MercuryExtensionContext | null = null;
  private extensionRegistry: ExtensionRegistry | null = null;
  private readonly shutdownHooks: ShutdownHook[] = [];
  private shuttingDown = false;
  private signalHandlersInstalled = false;

  constructor(readonly config: AppConfig) {
    this.db = new Db(resolveProjectPath(config.dbPath));
    this.queue = new SpaceQueue(config.maxConcurrency);
    this.scheduler = new TaskScheduler(this.db);
    this.containerRunner = new AgentContainerRunner(config);
    this.rateLimiter = new RateLimiter(
      config.rateLimitPerUser,
      config.rateLimitWindowMs,
    );

    // Scaffold global (pi agent dir) and "main" (default space)
    ensurePiResourceDir(resolveProjectPath(config.globalDir));
    ensureSpaceWorkspace(resolveProjectPath(config.spacesDir), "main");
    this.db.ensureSpace("main");

    // Seed context defaults for main space from AppConfig (idempotent per key).
    // YAML/env values feed the seeded defaults; existing rows are never overwritten.
    // Literal fallbacks mirror the Zod defaults in src/config.ts — tests that
    // build AppConfig via `as AppConfig` cast (bypassing Zod) would otherwise
    // pass undefined here and fail the NOT NULL constraint on space_config.value.
    if (this.db.getSpaceConfig("main", "context.mode") === null) {
      this.db.setSpaceConfig(
        "main",
        "context.mode",
        config.contextMode ?? "context",
        "system",
      );
    }
    if (this.db.getSpaceConfig("main", "context.window_size") === null) {
      this.db.setSpaceConfig(
        "main",
        "context.window_size",
        String(config.contextWindowSize ?? 10),
        "system",
      );
    }
    if (this.db.getSpaceConfig("main", "context.reply_chain_depth") === null) {
      this.db.setSpaceConfig(
        "main",
        "context.reply_chain_depth",
        String(config.contextReplyChainDepth ?? 10),
        "system",
      );
    }
  }

  /**
   * Initialize the runtime — must be called before accepting work.
   * Cleans up any orphaned containers from previous runs.
   */
  async initialize(): Promise<void> {
    await this.containerRunner.cleanupOrphans();
    this.rateLimiter.startCleanup();
  }

  /**
   * Wire extension system into the runtime.
   * Must be called after extensions are loaded and before accepting messages.
   */
  initExtensions(registry: ExtensionRegistry): void {
    this.hooks = new HookDispatcher(registry, logger);
    this.extensionRegistry = registry;
    this.extensionCtx = createMercuryExtensionContext({
      db: this.db,
      config: this.config,
      log: logger,
    });
    this.warnUncoveredSensitiveSpaces();
  }

  /**
   * Returns a comma-joined display name of active sensitive connections,
   * or null if none are active. Active means: credential env var set (for
   * env-var-based connections) or any extension state stored (for OAuth connections).
   */
  private getActiveSensitiveConnectionName(): string | null {
    if (!this.extensionRegistry) return null;
    const names: string[] = [];
    for (const ext of this.extensionRegistry.list()) {
      if (!ext.connection?.sensitive) continue;
      const conn = ext.connection;
      let active = false;
      if (conn.credentialEnvVar) {
        active = !!process.env[conn.credentialEnvVar];
      } else if (conn.statusCheck) {
        // Proxy: if any state has been stored, the OAuth flow was completed.
        active = this.db.hasAnyExtensionState(ext.name);
      }
      if (active) names.push(conn.displayName);
    }
    return names.length > 0 ? names.join(", ") : null;
  }

  /**
   * Sensitive connection guard — fires before the container for assistant turns.
   * Returns { action: "proceed" } (proceed, optionally replaying a stored prompt)
   * or { action: "block", reason } (send reason as reply, skip container).
   */
  private async checkSensitiveConnectionGuard(
    spaceId: string,
    prompt: string,
  ): Promise<
    | { action: "proceed"; replayPrompt?: string }
    | { action: "block"; reason: string }
  > {
    // No registry = no extensions loaded = no sensitive connections possible
    if (!this.extensionRegistry) return { action: "proceed" };

    if (!this.db.hasGroupLinkedConversation(spaceId)) {
      return { action: "proceed" };
    }

    const sensitiveName = this.getActiveSensitiveConnectionName();
    if (!sensitiveName) return { action: "proceed" };

    const allowed = this.db.getSpaceConfig(
      spaceId,
      "security.sensitive_connections_allowed",
    );
    if (allowed !== "true") {
      return {
        action: "block",
        reason: `⛔ Sensitive integrations (${sensitiveName}) are disabled for this group space. A space admin must enable them first with: mrctl config set security.sensitive_connections_allowed true`,
      };
    }

    const pendingAt = this.db.getSpaceConfig(
      spaceId,
      "security.pending_sensitive_at",
    );
    if (pendingAt) {
      const ageMs = Date.now() - new Date(pendingAt).getTime();
      const expired = Number.isNaN(ageMs) || ageMs > 5 * 60 * 1000;
      const text = prompt.trim().toLowerCase();

      if (expired || text === "no") {
        this.db.deleteSpaceConfig(spaceId, "security.pending_sensitive_prompt");
        this.db.deleteSpaceConfig(spaceId, "security.pending_sensitive_at");
        if (expired) {
          // Treat next message as fresh — fall through to new warning below
        } else {
          return { action: "block", reason: "Cancelled." };
        }
      } else if (text === "yes") {
        const storedPrompt = this.db.getSpaceConfig(
          spaceId,
          "security.pending_sensitive_prompt",
        );
        this.db.deleteSpaceConfig(spaceId, "security.pending_sensitive_prompt");
        this.db.deleteSpaceConfig(spaceId, "security.pending_sensitive_at");
        return { action: "proceed", replayPrompt: storedPrompt ?? undefined };
      } else {
        // New message arrived mid-confirmation — replace pending with new prompt
        // fall through to emit new warning below
      }
    }

    // Emit warning and store the original prompt for replay on confirmation
    this.db.setSpaceConfig(
      spaceId,
      "security.pending_sensitive_prompt",
      prompt,
      "system",
    );
    this.db.setSpaceConfig(
      spaceId,
      "security.pending_sensitive_at",
      new Date().toISOString(),
      "system",
    );
    return {
      action: "block",
      reason: `⚠️ This response may contain data from ${sensitiveName} and will be visible to all members of this group. Reply *yes* to proceed or *no* to cancel.`,
    };
  }

  /** Log a startup warning for group spaces with active sensitive connections but no admin enable. */
  private warnUncoveredSensitiveSpaces(): void {
    const sensitiveName = this.getActiveSensitiveConnectionName();
    if (!sensitiveName) return;

    const affected: string[] = [];
    for (const space of this.db.listSpaces()) {
      if (!this.db.hasGroupLinkedConversation(space.id)) continue;
      const allowed = this.db.getSpaceConfig(
        space.id,
        "security.sensitive_connections_allowed",
      );
      if (allowed !== "true") affected.push(space.id);
    }

    if (affected.length > 0) {
      logger.warn(
        "Sensitive connections active but not admin-enabled for group spaces — messages will be blocked until enabled",
        { spaces: affected, connections: sensitiveName },
      );
    }
  }

  startScheduler(sender?: MessageSender): void {
    this.scheduler.start(async (task) => {
      const result = await this.executePrompt(
        task.spaceId,
        task.prompt,
        "scheduler",
        task.createdBy,
      );
      if (!task.silent && sender) {
        await sender.send(task.spaceId, result.reply, result.files);
      }
      if (!task.silent && result.reply) {
        this.deliverTaskOutput(task.spaceId, result.reply);
      }
    });
  }

  private deliverTaskOutput(spaceId: string, text: string): void {
    const consoleUrl = process.env.MERCURY_CONSOLE_URL;
    const secret = process.env.MERCURY_CONSOLE_INTERNAL_SECRET;
    if (!consoleUrl || !secret) return;
    const url = `${consoleUrl}/api/internal/whatsapp/deliver`;

    fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({
        agentId: process.env.MERCURY_AGENT_ID ?? "unknown",
        spaceId,
        text,
      }),
    }).catch((err) => {
      const cause = (err as Error & { cause?: Error }).cause;
      logger.warn("Task output delivery failed", {
        error: err instanceof Error ? err.message : String(err),
        cause: cause?.message,
      });
    });
  }

  stopScheduler(): void {
    this.scheduler.stop();
  }

  async handleRawInput(
    message: IngressMessage,
    source: Exclude<InputSource, "scheduler">,
  ): Promise<RouteResult & { result?: ContainerResult }> {
    const route = routeInput({
      text: message.text,
      spaceId: message.spaceId,
      callerId: message.callerId,
      isDM: message.isDM,
      isReplyToBot: message.isReplyToBot,
      db: this.db,
      config: this.config,
      attachments: message.attachments,
      hadIncomingAttachments: message.hadIncomingAttachments,
      authorName: message.authorName,
    });

    if (route.type === "command") {
      const reply = await this.executeCommand(
        message.spaceId,
        route.command,
        route.callerId,
        route.verb,
        route.arg,
      );
      return { ...route, result: { reply, files: [] } };
    }

    // Check mute — silently drop messages from muted users
    if (
      route.type === "assistant" &&
      this.db.isMuted(message.spaceId, message.callerId)
    ) {
      return { type: "ignore" };
    }

    // Check rate limit for assistant requests (not commands, not ignored messages)
    if (route.type === "assistant") {
      // Check per-group override first
      const groupLimit = this.db.getSpaceConfig(message.spaceId, "rate_limit");
      const effectiveLimit = groupLimit
        ? Number.parseInt(groupLimit, 10)
        : this.config.rateLimitPerUser;

      if (
        effectiveLimit > 0 &&
        !this.checkRateLimit(message.spaceId, message.callerId, effectiveLimit)
      ) {
        return {
          type: "denied",
          reason: "Rate limit exceeded. Try again shortly.",
        };
      }
    }

    if (route.type !== "assistant") {
      // Store ambient messages in group chats (non-triggered, non-DM)
      // Default: enabled. Set ambient.enabled=false for tag-only mode.
      const ambientEnabled =
        this.db.getSpaceConfig(message.spaceId, "ambient.enabled") !== "false";
      if (
        route.type === "ignore" &&
        source === "chat-sdk" &&
        !message.isDM &&
        ambientEnabled
      ) {
        const ambientText = message.authorName
          ? `${message.authorName}: ${message.text.trim()}`
          : message.text.trim();

        if (ambientText) {
          this.db.ensureSpace(message.spaceId);
          this.db.addMessage(message.spaceId, "ambient", ambientText);
        }
      }

      return route;
    }

    const noPromptText = !message.text.trim();
    const noSavedFiles = (message.attachments?.length ?? 0) === 0;
    if (
      noPromptText &&
      noSavedFiles &&
      (message.hadIncomingAttachments ?? false)
    ) {
      return {
        type: "denied",
        reason:
          "Could not use your attachment (media disabled, over the size limit, or download failed). Check MERCURY_MEDIA_ENABLED and logs.",
      };
    }

    const guardResult = await this.checkSensitiveConnectionGuard(
      message.spaceId,
      route.prompt,
    );
    if (guardResult.action === "block") {
      return { type: "denied", reason: guardResult.reason };
    }
    const effectivePrompt = guardResult.replayPrompt ?? route.prompt;

    try {
      const result = await this.executePrompt(
        message.spaceId,
        effectivePrompt,
        source,
        message.callerId,
        message.attachments,
        message.authorName,
        {
          platform: message.platform,
          conversationExternalId: message.conversationExternalId,
          replyToPlatformMessageId: message.replyToPlatformMessageId,
          platformMessageId: message.platformMessageId,
        },
        { isReplyToBot: route.isReplyToBot, isDM: route.isDM },
      );
      return { ...route, result };
    } catch (error) {
      if (error instanceof ContainerError) {
        switch (error.reason) {
          case "aborted":
            return { type: "denied", reason: "Stopped current run." };
          case "timeout":
            return { type: "denied", reason: "Container timed out." };
          case "oom":
            return {
              type: "denied",
              reason: "Container was killed (possibly out of memory).",
            };
          case "error": {
            logger.error(
              "Container error",
              error instanceof Error ? error : undefined,
            );
            const category = classifyUserError(error.message);
            const reason = friendlyErrorMessage(
              category,
              this.config.apiKeyMode,
              this.config.consoleUrl,
            );
            return { type: "denied", reason };
          }
        }
      }
      throw error;
    }
  }

  /**
   * Check if a request is allowed under rate limiting.
   * Uses per-group override if set, otherwise uses the default limit.
   */
  private checkRateLimit(
    spaceId: string,
    userId: string,
    effectiveLimit: number,
  ): boolean {
    return this.rateLimiter.isAllowed(spaceId, userId, effectiveLimit);
  }

  private async executeCommand(
    spaceId: string,
    command: string,
    callerId: string,
    verb?: string,
    arg?: string,
  ): Promise<string> {
    switch (command) {
      case "stop": {
        const stopped = this.containerRunner.abort(spaceId);
        const dropped = this.queue.cancelPending(spaceId);
        if (stopped)
          return `Stopped.${dropped > 0 ? ` Dropped ${dropped} queued request(s).` : ""}`;
        if (dropped > 0) return `Dropped ${dropped} queued request(s).`;
        return "No active run.";
      }
      case "compact": {
        this.db.setSessionBoundaryToLatest(spaceId);
        return "Compacted.";
      }
      case "clear": {
        this.db.setClearBoundary(spaceId);
        return "Cleared.";
      }
      case "help": {
        if (verb) {
          return (
            formatCategoryHelp(verb) ?? `No help available for '/${verb}'.`
          );
        }
        return formatHelp();
      }
      case "model":
        return this.executeModelsCommand(spaceId, callerId, verb, arg);
      default:
        return `Unknown command: ${command}`;
    }
  }

  private executeModelsCommand(
    spaceId: string,
    callerId: string,
    verb?: string,
    arg?: string,
  ): string {
    const chain = this.config.resolvedModelChain;

    if (!verb) {
      return formatCategoryHelp("model") ?? "/model — model management";
    }

    switch (verb) {
      case "list": {
        if (chain.length === 0) return "No models configured.";
        const activeRaw = this.db.getSpaceConfig(spaceId, "model.active");
        const activeFound = activeRaw
          ? chain.some((l) => `${l.provider}:${l.model}` === activeRaw)
          : false;
        const lines = ["Configured models:"];
        for (let i = 0; i < chain.length; i++) {
          const leg = chain[i];
          const isActive = activeFound
            ? activeRaw === `${leg.provider}:${leg.model}`
            : i === 0;
          lines.push(
            `  [${i + 1}] ${leg.provider} / ${leg.model}${isActive ? "   ← active" : ""}`,
          );
        }
        return lines.join("\n");
      }

      case "active": {
        const activeRaw = this.db.getSpaceConfig(spaceId, "model.active");
        const leg =
          (activeRaw
            ? chain.find((l) => `${l.provider}:${l.model}` === activeRaw)
            : undefined) ?? chain[0];
        if (!leg) return "No models configured.";
        return `Active model: ${leg.provider} / ${leg.model}`;
      }

      case "switch": {
        if (!arg)
          return "Usage: /model switch <N|MODEL_ID>. Use /model list to see options.";
        if (chain.length === 0) return "No models configured.";

        let leg: (typeof chain)[number] | undefined;
        const num = Number.parseInt(arg, 10);
        if (!Number.isNaN(num) && num >= 1 && num <= chain.length) {
          leg = chain[num - 1];
        } else {
          leg = chain.find(
            (l) => l.model === arg || `${l.provider}:${l.model}` === arg,
          );
        }

        if (!leg)
          return "Model not found. Use /model list to see your options.";

        this.db.setSpaceConfig(
          spaceId,
          "model.active",
          `${leg.provider}:${leg.model}`,
          callerId,
        );
        return `Switched to ${leg.provider} / ${leg.model}.`;
      }

      default:
        return `/model: unknown verb '${verb}'. Use /model for help.`;
    }
  }

  onShutdown(hook: ShutdownHook): void {
    this.shutdownHooks.push(hook);
  }

  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  installSignalHandlers(): void {
    if (this.signalHandlersInstalled) return;
    this.signalHandlersInstalled = true;

    let forceCount = 0;

    const handler = (signal: string) => {
      if (this.shuttingDown) {
        forceCount++;
        if (forceCount >= 1) {
          logger.warn("Second signal received, forcing exit");
          process.exit(1);
        }
        return;
      }
      logger.info("Received signal, starting graceful shutdown", { signal });
      void this.shutdown().then(
        () => process.exit(0),
        (err) => {
          logger.error(
            "Shutdown failed",
            err instanceof Error ? err : undefined,
          );
          process.exit(1);
        },
      );
    };

    process.on("SIGTERM", () => handler("SIGTERM"));
    process.on("SIGINT", () => handler("SIGINT"));
  }

  async shutdown(timeoutMs = 10_000): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    const forceTimer = setTimeout(() => {
      logger.error("Shutdown timed out, forcing exit");
      process.exit(1);
    }, timeoutMs);
    // Don't keep the process alive just for this timer
    if (forceTimer.unref) forceTimer.unref();

    try {
      // 1. Stop schedulers
      logger.info("Shutdown: stopping task scheduler");
      this.scheduler.stop();

      // 2. Drain queue — cancel pending, wait for active
      logger.info("Shutdown: draining group queue");
      const dropped = this.queue.cancelAll();
      if (dropped > 0)
        logger.info("Shutdown: cancelled pending queue entries", {
          count: dropped,
        });

      // 3. Kill running containers
      logger.info("Shutdown: stopping running containers");
      this.containerRunner.killAll();

      // 4. Wait for active work to finish (with a shorter timeout)
      const drainTimeout = Math.max(timeoutMs - 2000, 1000);
      const drained = await this.queue.waitForActive(drainTimeout);
      if (!drained) {
        logger.warn("Shutdown: active work did not finish in time");
      }

      // 5. Emit extension shutdown hooks
      if (this.hooks && this.extensionCtx) {
        logger.info("Shutdown: notifying extensions");
        await this.hooks.emit("shutdown", {}, this.extensionCtx);
      }

      // 6. Run registered shutdown hooks (adapters, server, etc.)
      for (const hook of this.shutdownHooks) {
        try {
          await hook();
        } catch (err) {
          logger.error(
            "Shutdown hook failed",
            err instanceof Error ? err : undefined,
          );
        }
      }

      // 6. Stop rate limiter cleanup
      this.rateLimiter.stopCleanup();

      // 7. Close database
      logger.info("Shutdown: closing database");
      this.db.close();

      logger.info("Shutdown: complete");
    } finally {
      clearTimeout(forceTimer);
    }
  }

  private async executePrompt(
    spaceId: string,
    prompt: string,
    _source: InputSource,
    callerId: string,
    attachments?: MessageAttachment[],
    authorName?: string,
    replyMeta?: {
      platform?: string;
      conversationExternalId?: string;
      replyToPlatformMessageId?: string;
      platformMessageId?: string;
    },
    replyFlags?: { isReplyToBot: boolean; isDM: boolean },
  ): Promise<ContainerResult> {
    this.db.ensureSpace(spaceId);

    return this.queue.enqueue(spaceId, async () => {
      // ── Daily message quota check ────────────────────────────────────────
      // Calls the console API to record the message and verify the user hasn't
      // exceeded their plan's daily limit. Fails open: if the API is unreachable,
      // the message is allowed through (billing is best-effort, not a hard gate).
      if (this.config.consoleUrl && this.config.consoleUserId) {
        try {
          const quotaRes = await fetch(
            `${this.config.consoleUrl}/api/user/billing/message-used`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                ...(this.config.consoleInternalSecret
                  ? {
                      Authorization: `Bearer ${this.config.consoleInternalSecret}`,
                    }
                  : {}),
              },
              body: JSON.stringify({
                userId: this.config.consoleUserId,
                agentId: process.env.MERCURY_AGENT_ID ?? spaceId,
                isByok: false,
              }),
              signal: AbortSignal.timeout(5000),
            },
          );
          if (quotaRes.ok) {
            const quotaData = (await quotaRes.json()) as {
              allowed: boolean;
              remaining: number | null;
            };
            if (!quotaData.allowed) {
              return {
                reply:
                  "You've reached your daily message limit. Upgrade your plan at the Mercury Console to continue chatting.",
                files: [],
              };
            }
          }
          // Non-OK response → fail open (log but don't block)
          else {
            logger.warn(
              "Quota check returned non-OK status — allowing message",
              { status: quotaRes.status },
            );
          }
        } catch (err) {
          logger.warn("Quota check failed (unreachable?) — allowing message", {
            err,
          });
        }
      }
      // ────────────────────────────────────────────────────────────────────

      const workspace = ensureSpaceWorkspace(
        resolveProjectPath(this.config.spacesDir),
        spaceId,
      );

      // Container-relative workspace path
      const containerWorkspace = `/spaces/${spaceId}`;

      // ── Reply-chain isolation ──────────────────────────────────────────
      // Strip quoted bot output from unprivileged group replies-to-bot
      // BEFORE hooks see the prompt (defense in depth).
      let replyIsolated = false;
      let finalPrompt = prompt;
      if (replyFlags?.isReplyToBot && !replyFlags.isDM) {
        const seededAdmins = this.config.admins
          ? this.config.admins
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : [];
        const earlyRole = resolveRole(this.db, spaceId, callerId, seededAdmins);
        if (earlyRole !== "admin" && earlyRole !== "system") {
          replyIsolated = true;
          finalPrompt = finalPrompt.replace(
            /\n*<reply_to[^>]*>[\s\S]*?<\/reply_to>/g,
            "",
          );
        }
      }
      // ────────────────────────────────────────────────────────────────────

      // Emit workspace_init hook (extensions should be idempotent)
      if (this.hooks && this.extensionCtx) {
        await this.hooks.emit(
          "workspace_init",
          { spaceId, workspace, containerWorkspace },
          this.extensionCtx,
        );
      }

      // Emit before_container hook
      let extraEnv: Record<string, string> | undefined;
      if (this.hooks && this.extensionCtx) {
        const result = await this.hooks.emitBeforeContainer(
          {
            spaceId,
            prompt: finalPrompt,
            callerId,
            workspace,
            containerWorkspace,
            attachments,
          },
          this.extensionCtx,
        );
        if (result?.block) {
          return { reply: result.block.reason, files: [] };
        }
        if (result) {
          if (result.env) {
            extraEnv = { ...extraEnv, ...result.env };
          }
          if (result.systemPrompt) {
            extraEnv = {
              ...extraEnv,
              MERCURY_EXT_SYSTEM_PROMPT: result.systemPrompt,
            };
          }
          if (result.promptAppend) {
            finalPrompt = [finalPrompt, result.promptAppend]
              .filter(Boolean)
              .join("\n\n");
          }
        }
      }

      // Inject per-space system prompt (set via console Spaces settings or at provision time).
      const spacePrompt = this.db.getSpaceConfig(spaceId, "system_prompt");
      if (spacePrompt) {
        const existing = extraEnv?.MERCURY_EXT_SYSTEM_PROMPT;
        extraEnv = {
          ...extraEnv,
          MERCURY_EXT_SYSTEM_PROMPT: existing
            ? `${existing}\n\n${spacePrompt}`
            : spacePrompt,
        };
      }

      // Fetch prior turns based on context mode.
      // When reply-isolated, skip all history to prevent context leakage.
      let history: import("../types.js").StoredMessage[];
      if (replyIsolated) {
        history = [];
        extraEnv = { ...extraEnv, MERCURY_REPLY_ISOLATED: "1" };
      } else {
        const contextMode =
          this.db.getSpaceConfig(spaceId, "context.mode") ?? "clear";

        if (contextMode === "context") {
          const windowSizeStr = this.db.getSpaceConfig(
            spaceId,
            "context.window_size",
          );
          const windowSize = windowSizeStr
            ? Number.parseInt(windowSizeStr, 10)
            : (this.config.contextWindowSize ?? 10);
          history = this.db.getRecentTurns(spaceId, windowSize);
          // One-shot clear: reset temporary boundary immediately after reading history.
          this.db.resetClearBoundary(spaceId);
        } else {
          // Clear mode: only include reply chain if this message is a reply
          if (
            replyMeta?.replyToPlatformMessageId &&
            replyMeta.platform &&
            replyMeta.conversationExternalId
          ) {
            const mercuryMsgId = this.db.lookupMercuryMessageId(
              replyMeta.platform,
              replyMeta.conversationExternalId,
              replyMeta.replyToPlatformMessageId,
            );
            if (mercuryMsgId !== null) {
              const depthStr = this.db.getSpaceConfig(
                spaceId,
                "context.reply_chain_depth",
              );
              const depth = depthStr ? Number.parseInt(depthStr, 10) : 10;
              history = this.db.getReplyChain(mercuryMsgId, depth);
            } else {
              history = []; // Message predates feature — no chain available
            }
          } else {
            history = []; // New independent message — no prior context
          }
        }
      }

      // Resolve the Mercury message ID being replied to (if any)
      let userReplyToId: number | undefined;
      if (
        replyMeta?.replyToPlatformMessageId &&
        replyMeta.platform &&
        replyMeta.conversationExternalId
      ) {
        const resolved = this.db.lookupMercuryMessageId(
          replyMeta.platform,
          replyMeta.conversationExternalId,
          replyMeta.replyToPlatformMessageId,
        );
        if (resolved !== null) userReplyToId = resolved;
      }

      const userMessageId = this.db.addMessage(
        spaceId,
        "user",
        finalPrompt,
        attachments,
        userReplyToId,
      );

      // Record platform message ID mapping for the inbound user message
      if (
        replyMeta?.platformMessageId &&
        replyMeta.platform &&
        replyMeta.conversationExternalId
      ) {
        this.db.addPlatformMessageId(
          userMessageId,
          replyMeta.platform,
          replyMeta.conversationExternalId,
          replyMeta.platformMessageId,
        );
      }

      // Compute caller role, denied CLIs, and permitted env vars
      let callerRole = "member";
      if (this.extensionRegistry) {
        const seededAdmins = this.config.admins
          ? this.config.admins
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : [];
        callerRole = resolveRole(this.db, spaceId, callerId, seededAdmins);

        const cliExtensions = this.extensionRegistry.getCliExtensions();
        if (cliExtensions.length > 0) {
          const denied = cliExtensions
            .filter(
              (ext) =>
                ext.clis.length > 0 &&
                !hasPermission(this.db, spaceId, callerRole, ext.name),
            )
            .flatMap((ext) => ext.clis.map((c) => c.name));
          if (denied.length > 0) {
            extraEnv = {
              ...extraEnv,
              MERCURY_DENIED_CLIS: denied.join(","),
            };
          }
        }

        // Inject extension env vars only when caller has permission
        for (const ext of this.extensionRegistry.list()) {
          if (ext.envVars.length === 0) continue;
          if (
            ext.permission &&
            !hasPermission(this.db, spaceId, callerRole, ext.name)
          )
            continue;
          for (const envDef of ext.envVars) {
            const value = process.env[envDef.from];
            if (value) {
              const containerKey =
                envDef.as ?? envDef.from.replace(/^MERCURY_/, "");
              extraEnv = { ...extraEnv, [containerKey]: value };
            }
          }
        }
      }

      // Inject active model as single-leg override (eliminates automatic fallback)
      const activeModelRaw = this.db.getSpaceConfig(spaceId, "model.active");
      if (activeModelRaw) {
        const colonIdx = activeModelRaw.indexOf(":");
        if (colonIdx > 0) {
          const provider = activeModelRaw.slice(0, colonIdx);
          const model = activeModelRaw.slice(colonIdx + 1);
          const legIdx = this.config.resolvedModelChain.findIndex(
            (l) => l.provider === provider && l.model === model,
          );
          if (legIdx >= 0) {
            extraEnv = {
              ...extraEnv,
              MODEL_CHAIN: JSON.stringify([
                this.config.resolvedModelChain[legIdx],
              ]),
              MODEL_CHAIN_CAPABILITIES: JSON.stringify([
                this.config.resolvedModelChainCapabilities[legIdx],
              ]),
            };
          } else {
            logger.warn(
              "model.active references unknown leg, ignoring override",
              {
                spaceId,
                activeModelRaw,
              },
            );
          }
        }
      }

      const startTime = Date.now();

      const preferences = this.db.listSpacePreferences(spaceId).map((p) => ({
        key: p.key,
        value: p.value,
      }));

      let containerResult: ContainerResult;
      try {
        containerResult = await this.containerRunner.replyWithRetry({
          spaceId,
          spaceWorkspace: workspace,
          messages: history,
          prompt: finalPrompt,
          callerId,
          callerRole,
          authorName,
          attachments,
          preferences,
          extraEnv,
          claimedEnvSources: this.extensionRegistry?.getClaimedEnvSources(),
        });
      } catch (err) {
        this.db.updateMessageRunMeta(userMessageId, userTurnRunMeta(undefined));
        throw err;
      }

      const durationMs = Date.now() - startTime;

      // Emit after_container hook
      if (this.hooks && this.extensionCtx) {
        const hookResult = await this.hooks.emitAfterContainer(
          {
            spaceId,
            workspace,
            callerId,
            prompt: finalPrompt,
            reply: containerResult.reply,
            durationMs,
          },
          this.extensionCtx,
        );
        if (hookResult?.suppress) {
          this.db.updateMessageRunMeta(
            userMessageId,
            userTurnRunMeta(containerResult.usage),
          );
          return { reply: "", files: [] };
        }
        if (hookResult?.reply !== undefined) {
          containerResult.reply = hookResult.reply;
        }
        if (hookResult?.files?.length) {
          containerResult.files = [
            ...containerResult.files,
            ...hookResult.files,
          ];
        }
      }

      const assistantMessageId = this.db.addMessage(
        spaceId,
        "assistant",
        containerResult.reply,
        undefined,
        userMessageId, // reply chain: assistant replies to user message
      );

      if (containerResult.usage) {
        this.db.recordUsage(spaceId, containerResult.usage);
      } else {
        logger.debug(
          "Container run finished without token usage (old agent image, non-JSON pi output, or zero reported usage)",
          { spaceId },
        );
      }

      this.db.updateMessageRunMeta(
        userMessageId,
        userTurnRunMeta(containerResult.usage),
      );

      containerResult.assistantMessageId = assistantMessageId;
      return containerResult;
    });
  }

  /**
   * Record the platform message ID for an outbound assistant message.
   * Called by the handler after sendReply() returns the platform ID.
   */
  recordOutboundPlatformId(
    assistantMessageId: number,
    platform: string,
    conversationExternalId: string,
    platformMessageId: string,
  ): void {
    this.db.addPlatformMessageId(
      assistantMessageId,
      platform,
      conversationExternalId,
      platformMessageId,
    );
  }
}

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Suppress noisy Bun WebSocket warnings from Baileys
const originalWarn = console.warn;
console.warn = (...args: unknown[]) => {
  const msg = typeof args[0] === "string" ? args[0] : "";
  if (msg.includes("ws.WebSocket") && msg.includes("not implemented in bun"))
    return;
  originalWarn(...args);
};

import type { Adapter, Message } from "chat";
import type { DiscordNativeAdapter } from "./adapters/discord-native.js";
import { setupAdapters } from "./adapters/setup.js";
import type { WhatsAppBaileysAdapter } from "./adapters/whatsapp.js";
import {
  apiSocketDir,
  apiSocketName,
  apiSocketPath,
  sweepOrphanApiSockets,
} from "./agent/api-socket.js";
import {
  logExtensionCapabilityMismatches,
  logUnknownModelCapabilityWarnings,
} from "./agent/model-capabilities.js";
import { DiscordBridge } from "./bridges/discord.js";
import { SlackBridge } from "./bridges/slack.js";
import { TeamsBridge } from "./bridges/teams.js";
import { TelegramBridge } from "./bridges/telegram.js";
import { WhatsAppBridge } from "./bridges/whatsapp.js";
import { createChatShim } from "./chat-shim.js";
import { loadConfig, resolveProjectPath } from "./config.js";
import { createMessageHandler } from "./core/handler.js";
import { setActiveProfileMemberPermissions } from "./core/permissions.js";
import { loadActiveProfile, setActiveProfilePrompt } from "./core/profiles.js";
import { MercuryCoreRuntime } from "./core/runtime.js";
import { runStorageCleanup } from "./core/storage-cleanup.js";
import { isOverQuota } from "./core/storage-guard.js";
import { EXTENSION_CATALOG } from "./extensions/catalog.js";
import { ConfigRegistry } from "./extensions/config-registry.js";
import { createMercuryExtensionContext } from "./extensions/context.js";
import { ExtImageBuildState } from "./extensions/image-builder.js";
import { syncBundledCatalogExtensions } from "./extensions/installer.js";
import { JobRunner } from "./extensions/jobs.js";
import { ExtensionRegistry } from "./extensions/loader.js";
import {
  installBuiltinSkills,
  installExtensionSkills,
} from "./extensions/skills.js";
import { configureLogger, logger } from "./logger.js";
import { createApp } from "./server.js";
import { ensureSpaceWorkspace } from "./storage/memory.js";
import type { NormalizeContext, PlatformBridge } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(__dirname, "..");
const startTime = Date.now();

async function main() {
  const config = loadConfig();

  configureLogger({
    level: config.logLevel,
    format: config.logFormat,
  });

  logUnknownModelCapabilityWarnings(
    config.resolvedModelChain,
    resolveProjectPath(config.dataDir),
    config.parsedModelCapabilitiesEnv,
    logger,
  );

  if (!!config.containerNetwork !== !!config.containerApiHost) {
    logger.warn(
      "MERCURY_CONTAINER_NETWORK and MERCURY_CONTAINER_API_HOST should be set together; mrctl may fail to connect",
      {
        containerNetwork: config.containerNetwork ?? "(unset)",
        containerApiHost: config.containerApiHost ?? "(unset)",
      },
    );
  }

  // ─── Normalize data dir ownership ───────────────────────────────────────
  // Host base image's default user has drifted historically; if the volume
  // was written by a previous uid, SQLite can't reopen state.db for writes.
  // Idempotent on matching ownership.
  if (process.platform === "linux" && process.getuid?.() === 0) {
    const dataDirPath = resolveProjectPath(config.dataDir);
    if (existsSync(dataDirPath)) {
      try {
        execFileSync("chown", ["-R", "0:0", dataDirPath]);
      } catch (err) {
        logger.warn(
          "Startup chown of data dir failed (CAP_CHOWN may be absent)",
          {
            dataDir: dataDirPath,
            error: err instanceof Error ? err.message : String(err),
          },
        );
      }
    }
  }

  // ─── Early HTTP Server (warming mode) ──────────────────────────────────
  // Start serving /health immediately so the readiness probe responds during
  // the derived-image build (~3-4 min for heavy extensions like Playwright).
  // All other paths return 503 until the full Hono app is wired in below.
  type FetchHandler = (req: Request) => Response | Promise<Response>;
  let fetchHandler: FetchHandler = (req) => {
    if (new URL(req.url).pathname === "/health") {
      return Response.json({
        status: "warming",
        uptime: Math.floor((Date.now() - startTime) / 1000),
      });
    }
    return new Response("Starting…", { status: 503 });
  };

  const server = Bun.serve({
    port: config.port,
    fetch: (req) => fetchHandler(req),
  });
  logger.info("HTTP server listening (warming — full app initializing)", {
    port: config.port,
  });

  // ─── Inner-container API unix socket (gVisor only) ─────────────────────
  // In runsc mode the outer container leaves docker0, so inner containers can no
  // longer reach the API over TCP. They reach it via a per-container unix socket
  // in the per-agent data volume — visible to host-sibling inner containers
  // through MERCURY_HOST_DATA_DIR. The socket name is per-container-unique
  // (api-<hostname>.sock) because canonical + -next share one volume during a
  // blue-green deploy. Requires the daemon to register runsc with --host-uds=open
  // (see node-cloud-init.ts). Shares the same fetchHandler as the TCP listener,
  // so it swaps from warming → full app in lockstep.
  let unixServer: ReturnType<typeof Bun.serve> | undefined;
  if (config.containerRuntime === "runsc") {
    const dataDirPath = resolveProjectPath(config.dataDir);
    const runDir = apiSocketDir(dataDirPath);
    const socketPath = apiSocketPath(dataDirPath);
    try {
      mkdirSync(runDir, { recursive: true });
      // Remove our own stale socket inode (left by a crash/redeploy) before bind.
      rmSync(socketPath, { force: true });
      // Outer runs as root (uid 0); inner connects as uid 1000. Drop the umask
      // around bind so the socket inode is world-RW from birth — closes the
      // window between bind and the chmod below in which uid 1000 could be
      // refused. Restored immediately so no other file creation is affected.
      const prevUmask = process.umask(0o000);
      try {
        unixServer = Bun.serve({
          unix: socketPath,
          fetch: (req) => fetchHandler(req),
        });
      } finally {
        process.umask(prevUmask);
      }
      // Belt-and-suspenders: ensure 0666 even if Bun applied its own mode to the
      // socket. See the global-dir chown debug note — wrap in try/catch so a
      // chmod failure logs, not crashes.
      try {
        chmodSync(socketPath, 0o666);
      } catch (err) {
        logger.warn(
          "chmod of API socket failed; inner containers may be unable to connect",
          {
            socket: socketPath,
            error: err instanceof Error ? err.message : String(err),
          },
        );
      }
      logger.info("Inner-container API unix socket listening", {
        socket: socketPath,
      });
      // Clean up orphan sockets from prior deploys (connect-test-and-unlink).
      void sweepOrphanApiSockets(dataDirPath, apiSocketName(), logger);
    } catch (err) {
      logger.error(
        "Failed to start inner-container API unix socket",
        err instanceof Error ? err : undefined,
      );
    }
  }

  // ─── Initialize Core ────────────────────────────────────────────────────

  const core = new MercuryCoreRuntime(config);
  await core.initialize();

  // ─── Load Extensions ────────────────────────────────────────────────────

  const extensionsDir = resolveProjectPath(`${config.dataDir}/extensions`);
  const globalDir = resolveProjectPath(config.globalDir);

  // Sync installed catalog extensions against the bundled source. When a new
  // image ships a patched extension (e.g. MERCURY_BROWSER_SESSIONS fix), agents
  // with stale installed copies on their data volume are updated automatically
  // on the next restart — no manual reinstall needed.
  await syncBundledCatalogExtensions({
    packageRoot: PACKAGE_ROOT,
    extensionsDir,
    globalDir,
    catalog: EXTENSION_CATALOG,
    logger,
  });

  const registry = new ExtensionRegistry();
  const configRegistry = new ConfigRegistry();
  const builtinExtDir = join(PACKAGE_ROOT, "resources/extensions");
  await registry.loadAll(extensionsDir, core.db, logger, configRegistry, [
    builtinExtDir,
  ]);
  logger.info("Extensions loaded", { count: registry.size });

  // Activate the applicative profile (project-wide member permission scoping).
  // Done after extensions load so extension-registered permissions (e.g. a
  // profile's own CLI permission) are recognized as valid.
  const activeProfile = loadActiveProfile(resolveProjectPath(config.dataDir));
  if (activeProfile) {
    setActiveProfileMemberPermissions(activeProfile.memberPermissions ?? null);
    setActiveProfilePrompt(activeProfile.profilePrompt ?? null);
    logger.info("Applicative profile active", {
      profile: activeProfile.name,
      memberPermissions:
        activeProfile.memberPermissions?.join(",") ?? "(unscoped)",
    });
  }

  logExtensionCapabilityMismatches(
    registry.list(),
    config.resolvedModelChainCapabilities,
    logger,
  );

  // Wire extensions into runtime (hooks, context)
  core.initExtensions(registry, configRegistry);

  // Install skills (extension + built-in)
  installExtensionSkills(
    registry.list(),
    globalDir,
    logger,
    config.resolvedModelChainCapabilities,
  );
  installBuiltinSkills(
    join(PACKAGE_ROOT, "resources/skills"),
    globalDir,
    logger,
    config.resolvedModelChainCapabilities,
  );

  // Ensure base image is available (auto-pull if missing)
  await core.containerRunner.ensureImage();

  // Start derived image build in the background — does not block warming→ready.
  // Inner container spawns use the base image until the ext image is ready.
  const buildState = new ExtImageBuildState(
    config.agentContainerImage,
    registry.list(),
    logger,
    process.env.MERCURY_AGENT_ID,
  );
  core.containerRunner.setBuildState(buildState);

  // ─── Setup Adapters ─────────────────────────────────────────────────────

  const adapters = setupAdapters(config);

  // ─── Platform Bridges ─────────────────────────────────────────────────

  const bridges: Record<string, PlatformBridge> = {};

  if (adapters.whatsapp) {
    bridges.whatsapp = new WhatsAppBridge(
      adapters.whatsapp as WhatsAppBaileysAdapter,
    );
    (adapters.whatsapp as WhatsAppBaileysAdapter).onGroupRemoval = (
      chatJid,
    ) => {
      try {
        const externalId = `${chatJid}:${chatJid}`;
        const conv = core.db.findConversation("whatsapp", externalId);
        if (!conv?.spaceId) return;
        core.db.addMessage(
          conv.spaceId,
          "ambient",
          "[System] Agent was removed from this WhatsApp group. Conversation unlinked from its space.",
        );
        core.db.unlinkConversation(conv.id);
        logger.info("WhatsApp: unlinked conversation on group removal", {
          chatJid,
          conversationId: conv.id,
          spaceId: conv.spaceId,
        });
      } catch (err) {
        logger.error(
          "WhatsApp: failed to unlink conversation on group removal",
          {
            chatJid,
            error: err instanceof Error ? err.message : String(err),
          },
        );
      }
    };
  }
  if (adapters.discord) {
    bridges.discord = new DiscordBridge(
      adapters.discord as DiscordNativeAdapter,
    );
  }
  if (adapters.slack) {
    const slackBotToken = process.env.MERCURY_SLACK_BOT_TOKEN;
    if (!slackBotToken) {
      throw new Error("Slack enabled but MERCURY_SLACK_BOT_TOKEN is missing");
    }
    bridges.slack = new SlackBridge(adapters.slack, slackBotToken);
  }
  if (adapters.teams) {
    bridges.teams = new TeamsBridge(adapters.teams);
  }
  if (adapters.telegram) {
    const telegramBotToken = process.env.MERCURY_TELEGRAM_BOT_TOKEN;
    if (!telegramBotToken) {
      throw new Error(
        "Telegram enabled but MERCURY_TELEGRAM_BOT_TOKEN is missing",
      );
    }
    bridges.telegram = new TelegramBridge(
      adapters.telegram,
      telegramBotToken,
      config.telegramFormatEnabled,
    );
  }

  const normalizeCtx: NormalizeContext = {
    botUserName: config.botUsername,
    getWorkspace: (spaceId) =>
      ensureSpaceWorkspace(resolveProjectPath(config.spacesDir), spaceId),
    media: {
      enabled: config.mediaEnabled,
      maxSizeBytes: config.mediaMaxSizeMb * 1024 * 1024,
    },
    isOverQuota: () => isOverQuota(config),
  };

  const handlers = new Map<string, ReturnType<typeof createMessageHandler>>();
  for (const [name, bridge] of Object.entries(bridges)) {
    handlers.set(
      name,
      createMessageHandler({ bridge, core, config, ctx: normalizeCtx }),
    );
  }

  // ─── Message Dispatch ───────────────────────────────────────────────────

  const onMessage = (adapter: Adapter, threadId: string, message: Message) => {
    const handler = handlers.get(adapter.name);
    if (handler) {
      void handler(adapter, threadId, message).catch((error) =>
        logger.error(
          "Message handler failed",
          error instanceof Error ? error : undefined,
        ),
      );
    } else {
      logger.warn("No bridge for adapter", { adapter: adapter.name });
    }
  };

  // Chat shim satisfies Chat SDK adapter interface (initialize, webhooks)
  // without the full Chat routing pipeline (subscriptions, mention routing, locks).
  // Mercury handles its own routing via conversation resolution + trigger matching.
  const chatShim = createChatShim(onMessage);

  // ─── Message Sender (for scheduled tasks) ───────────────────────────────
  // Tasks use spaceId (e.g. "my-space") which must be resolved to platform
  // thread IDs (e.g. "telegram:12345") via linked conversations.

  const messageSender: import("./types.js").MessageSender = {
    async send(spaceOrThreadId, text, files) {
      const threadIds: string[] = [];

      if (spaceOrThreadId.includes(":")) {
        // Already a platform thread ID (e.g. "telegram:12345")
        threadIds.push(spaceOrThreadId);
      } else {
        // Space ID (e.g. "my-space") — resolve to linked conversations
        const conversations = core.db.getSpaceConversations(spaceOrThreadId);
        for (const conv of conversations) {
          threadIds.push(`${conv.platform}:${conv.externalId}`);
        }
        if (threadIds.length === 0) {
          logger.warn("Message dropped — no linked conversations for space", {
            spaceId: spaceOrThreadId,
          });
          return;
        }
        logger.info("Task result: resolved space to conversations", {
          spaceId: spaceOrThreadId,
          threadIds,
        });
      }

      for (const threadId of threadIds) {
        const [platform] = threadId.split(":");
        const bridge = bridges[platform];
        if (!bridge) {
          logger.warn("Message dropped — no bridge for platform", {
            threadId,
            platform,
          });
          continue;
        }
        logger.info("Task result: sending to platform", {
          threadId,
          platform,
          textLength: text?.length ?? 0,
        });
        await bridge.sendReply(threadId, text, files);
      }
    },
  };

  // ─── Start Services ─────────────────────────────────────────────────────

  core.startScheduler(messageSender);

  // Start extension background jobs
  const jobRunner = new JobRunner();
  jobRunner.start(
    registry.list(),
    createMercuryExtensionContext({
      db: core.db,
      config,
      log: logger,
      configRegistry,
    }),
  );
  core.onShutdown(() => jobRunner.stop());

  // Start built-in storage cleanup job
  const cleanupLog = logger.child({ job: "_builtin:storage-cleanup" });
  const runCleanup = () =>
    runStorageCleanup({
      config,
      db: core.db,
      log: cleanupLog,
      isSpaceActive: (spaceId) => core.queue.isActive(spaceId),
    }).catch((err) =>
      cleanupLog.error(
        "Storage cleanup failed",
        err instanceof Error ? err : undefined,
      ),
    );
  void runCleanup();
  const cleanupTimer = setInterval(runCleanup, config.cleanupIntervalMs);
  core.onShutdown(() => clearInterval(cleanupTimer));

  // Initialize adapters via shim (calls adapter.initialize(chatShim))
  for (const [name, adapter] of Object.entries(adapters)) {
    logger.info("Initializing adapter", { adapter: name });
    await adapter.initialize(chatShim);
  }

  // ─── Create HTTP Server ─────────────────────────────────────────────────

  // Build webhook handlers — each adapter's handleWebhook is called directly
  const webhooks: Record<
    string,
    (
      request: Request,
      options?: { waitUntil?: (task: Promise<unknown>) => void },
    ) => Promise<Response>
  > = {};

  for (const [name, adapter] of Object.entries(adapters)) {
    webhooks[name] = (request, options) =>
      adapter.handleWebhook(request, options);
  }

  // Intercept Telegram my_chat_member updates to auto-unlink conversations
  // when the bot is removed from or leaves a group.
  if (webhooks.telegram) {
    const rawTelegramWebhook = webhooks.telegram;
    webhooks.telegram = async (req, opts) => {
      try {
        const update = (await req.clone().json()) as Record<string, unknown>;
        const myChatMember = update.my_chat_member as
          | { chat: { id: number }; new_chat_member: { status: string } }
          | undefined;
        const status = myChatMember?.new_chat_member?.status;
        if (status === "kicked" || status === "left") {
          const chatId = String(myChatMember?.chat.id);
          const convs = core.db.findConversationsByPlatformPrefix(
            "telegram",
            chatId,
          );
          for (const conv of convs) {
            if (!conv.spaceId) continue;
            core.db.addMessage(
              conv.spaceId,
              "ambient",
              "[System] Agent was removed from this Telegram group. Conversation unlinked from its space.",
            );
            core.db.unlinkConversation(conv.id);
            logger.info("Telegram: unlinked conversation on group removal", {
              chatId,
              conversationId: conv.id,
              spaceId: conv.spaceId,
            });
          }
        }
      } catch {
        // Non-JSON body or missing fields — not a my_chat_member update; proceed normally
      }
      return rawTelegramWebhook(req, opts);
    };
  }

  const app = createApp({
    core,
    config,
    adapters,
    webhooks,
    startTime,
    registry,
    configRegistry,
    projectRoot: process.cwd(),
    packageRoot: PACKAGE_ROOT,
  });

  // Swap warming handler for the full Hono app now that initialization is complete
  fetchHandler = (req) => app.fetch(req);

  // ─── Shutdown Hooks ─────────────────────────────────────────────────────

  core.onShutdown(async () => {
    logger.info("Shutdown: closing chat adapters");
    for (const [name, adapter] of Object.entries(adapters)) {
      try {
        if ("shutdown" in adapter && typeof adapter.shutdown === "function") {
          await (adapter as { shutdown: () => Promise<void> }).shutdown();
          logger.info("Shutdown: adapter disconnected", { adapter: name });
        }
      } catch (err) {
        logger.error("Shutdown: failed to disconnect adapter", {
          adapter: name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  });

  core.onShutdown(async () => {
    logger.info("Shutdown: stopping HTTP server");
    server.stop(true);
    if (unixServer) {
      logger.info("Shutdown: stopping API unix socket");
      unixServer.stop(true);
      // Remove our socket inode on clean shutdown so it doesn't linger as an
      // orphan; startup sweep is the backstop for unclean exits.
      try {
        rmSync(apiSocketPath(resolveProjectPath(config.dataDir)), {
          force: true,
        });
      } catch {
        // Best-effort cleanup — the next startup sweep will reap it.
      }
    }
  });

  core.installSignalHandlers();

  // ─── Startup Logs ───────────────────────────────────────────────────────

  logger.info("Server started", {
    port: server.port,
    image: config.agentContainerImage,
    adapters: Object.keys(adapters).join(", ") || "none (chat-only mode)",
  });
  logger.info("Webhook path pattern: POST /webhooks/:platform");
  logger.info("Internal API: /api/*");

  if (adapters.discord) {
    logger.info("Discord enabled (native adapter with persistent connection)");
  }
  if (adapters.teams) {
    logger.info("Teams enabled (webhook via Azure Bot Service)");
  }
  if (adapters.whatsapp) {
    logger.info("WhatsApp enabled", {
      authDir: resolveProjectPath(config.whatsappAuthDir),
    });
  }
  if (adapters.telegram) {
    logger.info("Telegram enabled (webhook or polling)");
  }
}

main().catch((error) => {
  logger.error("Startup failed", error instanceof Error ? error : undefined);
  process.exit(1);
});

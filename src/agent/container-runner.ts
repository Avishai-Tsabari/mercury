import { execFileSync, execSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { type AppConfig, resolveProjectPath } from "../config.js";
import { scanOutbox } from "../core/outbox.js";
import type { ExtImageBuildState } from "../extensions/image-builder.js";
import { type Logger, logger } from "../logger.js";
import { getApiKeyFromPiAuthFile } from "../storage/pi-auth.js";
import type {
  ContainerResult,
  MessageAttachment,
  StoredMessage,
  TokenUsage,
} from "../types.js";
import {
  apiSocketDir,
  INNER_RUN_DIR,
  innerApiSocketPath,
} from "./api-socket.js";
import { ContainerError } from "./container-error.js";

/**
 * In-container mountpoint for the per-message IO dir. The host passes the request
 * payload as `input.json` and the inner container writes its reply as `result.json`
 * here. This is the reply channel that replaces the inner-container attach stream:
 * launching the inner container detached (`docker create` + `docker start`, no
 * attach) is the only pattern that works through the Bun `fetch()`-based body-proxy
 * the cloud agent lane goes through — the proxy cannot carry Docker's hijacked
 * attach connection, so an attached run hangs to its idleTimeout (see
 * docs/debug/major/2026-05-25-agent-lane-docker-run-wait-hang-no-chat-response.md).
 */
const INNER_IO_DIR = "/run/mercury-io";

/** Poll interval (ms) while waiting for the inner container's result file. */
const RESULT_POLL_MS = 150;
/** Run a `docker inspect` liveness probe every Nth poll (~2s) to fail fast on crash. */
const LIVENESS_EVERY = 14;
/** Default timeout for short Docker CLI commands (create, start, inspect, kill). */
const EXEC_DOCKER_TIMEOUT_MS = 20_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run a short, non-streaming `docker` command and capture its result. Used for
 * `create` / `start` / `inspect` / `kill` — all plain request/response Docker API
 * calls (no `/wait`, no attach), which the body-proxy forwards cleanly. Never
 * rejects: a spawn error is surfaced as a non-zero `code` so callers branch on one
 * shape. The timeout guards against a wedged daemon/proxy connection.
 */
function execDocker(
  args: string[],
  timeoutMs = EXEC_DOCKER_TIMEOUT_MS,
): Promise<{
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}> {
  return new Promise((resolve) => {
    const proc = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let killed = false;
    let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      killed = true;
      try {
        proc.kill("SIGKILL");
      } catch {
        // already exited
      }
    }, timeoutMs);
    const done = (code: number, errOverride?: string) => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      resolve({
        code,
        stdout,
        stderr: errOverride ?? stderr,
        timedOut: killed,
      });
    };
    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    proc.on("error", (error) => done(1, stderr || String(error)));
    proc.on("close", (code) => done(code ?? 1));
  });
}

// Anthropic OAuth constants — duplicated from console/src/lib/oauth.ts to avoid cross-package imports.
const ANTHROPIC_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const ANTHROPIC_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

type AnthropicOAuthCreds = { access: string; refresh: string; expires: number };

// Prevents hammering the OAuth token refresh endpoint on 429 responses — at most
// one refresh attempt per minute across all spawns in this process lifetime.
let lastOAuthRefreshAttemptAt = 0;
const OAUTH_REFRESH_COOLDOWN_MS = 60_000;

/**
 * Persist a freshly refreshed Anthropic OAuth token back to the console DB so
 * the next rolling deploy starts with a valid credential.
 * Failures are logged but never throw — caller awaits this so the failure is
 * known before continuing, but spawn is never blocked indefinitely.
 */
async function pushOAuthTokenToConsole(
  consoleUrl: string,
  internalSecret: string,
  agentId: string,
  creds: AnthropicOAuthCreds,
): Promise<void> {
  try {
    const res = await fetch(`${consoleUrl}/api/agent/oauth-token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${internalSecret}`,
      },
      body: JSON.stringify({
        agentId,
        provider: "anthropic",
        access: creds.access,
        refresh: creds.refresh,
        expires: creds.expires,
      }),
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn("OAuth token write-back to console failed", {
        status: res.status,
        body: body.slice(0, 200),
      });
    } else {
      logger.debug("OAuth token written back to console DB");
    }
  } catch (err) {
    logger.warn(
      "OAuth token write-back to console failed (network error)",
      err instanceof Error ? err : undefined,
    );
  }
}

/**
 * Fetch the current Anthropic OAuth credential blob from the console DB.
 * Called after an invalid_grant failure — the user may have already reconnected
 * in the console, so the DB may hold a fresh token the container doesn't know about.
 * Returns null on any error (network, auth, not configured).
 */
async function fetchOAuthTokenFromConsole(
  consoleUrl: string,
  internalSecret: string,
  agentId: string,
): Promise<AnthropicOAuthCreds | null> {
  try {
    const url = new URL(`${consoleUrl}/api/agent/oauth-token`);
    url.searchParams.set("agentId", agentId);
    url.searchParams.set("provider", "anthropic");
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${internalSecret}` },
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      access?: unknown;
      refresh?: unknown;
      expires?: unknown;
    };
    if (
      typeof data.access === "string" &&
      data.access &&
      typeof data.refresh === "string" &&
      data.refresh &&
      typeof data.expires === "number"
    ) {
      return {
        access: data.access,
        refresh: data.refresh,
        expires: data.expires,
      };
    }
    return null;
  } catch {
    return null;
  }
}

async function refreshAnthropicOAuth(
  creds: AnthropicOAuthCreds,
): Promise<AnthropicOAuthCreds> {
  const res = await fetch(ANTHROPIC_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: creds.refresh,
      client_id: ANTHROPIC_CLIENT_ID,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Anthropic OAuth refresh failed (${res.status}): ${body}`);
  }
  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!data.access_token)
    throw new Error("Anthropic refresh response missing access_token");
  return {
    access: data.access_token,
    refresh: data.refresh_token ?? creds.refresh,
    expires: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
}

/** External calls used by {@link resolveOAuthCredentialForSpawn}; injectable for tests. */
export type OAuthSpawnDeps = {
  refresh: (creds: AnthropicOAuthCreds) => Promise<AnthropicOAuthCreds>;
  pushToConsole: (
    consoleUrl: string,
    internalSecret: string,
    agentId: string,
    creds: AnthropicOAuthCreds,
  ) => Promise<void>;
  fetchFromConsole: (
    consoleUrl: string,
    internalSecret: string,
    agentId: string,
  ) => Promise<AnthropicOAuthCreds | null>;
  now: () => number;
};

const defaultOAuthSpawnDeps: OAuthSpawnDeps = {
  refresh: refreshAnthropicOAuth,
  pushToConsole: pushOAuthTokenToConsole,
  fetchFromConsole: fetchOAuthTokenFromConsole,
  now: Date.now,
};

export type OAuthSpawnResolution = {
  /** Bare access token to inject as ANTHROPIC_OAUTH_TOKEN into the inner container. */
  access: string;
  /** New full credential blob for the in-process env, or null if unchanged. */
  updatedBlob: string | null;
};

/**
 * Resolve an Anthropic OAuth credential blob into a fresh bare access token at
 * container-spawn time. This is the single chokepoint for the OAuth credential
 * lifecycle in mercury-fork — it embeds all three container-side steps:
 *   1. refresh the access token when it is within the 60s expiry lookahead,
 *   2. write the refreshed blob back to the console DB,
 *   4. on `invalid_grant`, pull the current blob from the console DB.
 *
 * Throws only when the credential is genuinely unrecoverable and the user must
 * reconnect. Transient failures (network, 429, cooldown) fall back to the
 * current access token so the spawn is never blocked.
 */
export async function resolveOAuthCredentialForSpawn(
  parsedCreds: AnthropicOAuthCreds,
  opts: {
    consoleUrl?: string;
    consoleInternalSecret?: string;
    agentId?: string;
  },
  deps: OAuthSpawnDeps = defaultOAuthSpawnDeps,
): Promise<OAuthSpawnResolution> {
  let freshAccess = parsedCreds.access;
  let updatedBlob: string | null = null;

  const needsRefresh = deps.now() + 60_000 > parsedCreds.expires;
  const canRetry =
    deps.now() - lastOAuthRefreshAttemptAt > OAUTH_REFRESH_COOLDOWN_MS;

  if (needsRefresh && canRetry) {
    try {
      lastOAuthRefreshAttemptAt = deps.now();
      const refreshed = await deps.refresh(parsedCreds);
      updatedBlob = JSON.stringify(refreshed);
      freshAccess = refreshed.access;
      // Persist to console DB so the next rolling deploy reads a valid token.
      if (opts.consoleUrl && opts.consoleInternalSecret && opts.agentId) {
        await deps.pushToConsole(
          opts.consoleUrl,
          opts.consoleInternalSecret,
          opts.agentId,
          refreshed,
        );
      } else if (opts.consoleUrl && !opts.consoleInternalSecret) {
        logger.warn(
          "Anthropic OAuth token refreshed but write-back to console is disabled — MERCURY_CONSOLE_INTERNAL_SECRET is not set; refreshed token will be lost on next container restart",
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isInvalidGrant = msg.includes("invalid_grant");
      if (isInvalidGrant && opts.consoleUrl && opts.consoleInternalSecret) {
        // The refresh token has been invalidated (user likely reconnected in the
        // console). Try to pull the current credential blob from the DB — the
        // console may already have fresh tokens that this container doesn't know about.
        if (opts.agentId) {
          const consoleCreds = await deps.fetchFromConsole(
            opts.consoleUrl,
            opts.consoleInternalSecret,
            opts.agentId,
          );
          if (consoleCreds && consoleCreds.refresh !== parsedCreds.refresh) {
            // Console has a different (newer) refresh token — user already reconnected.
            updatedBlob = JSON.stringify(consoleCreds);
            freshAccess = consoleCreds.access;
            logger.info(
              "Anthropic OAuth invalid_grant recovered from console DB — using fresh token",
            );
          } else if (consoleCreds === null) {
            // Console was unreachable — cannot determine if the user has reconnected.
            logger.error(
              "Anthropic OAuth refresh failed with invalid_grant and console credential fetch failed — please reconnect or check connectivity",
              { agentId: opts.agentId },
            );
            throw new Error(
              "Anthropic OAuth token is invalid (invalid_grant) and fresh credentials could not be fetched from the console. Please reconnect your Anthropic account or check the console is reachable.",
            );
          } else {
            // Same token in console — user has not reconnected yet.
            logger.error(
              "Anthropic OAuth refresh failed with invalid_grant and no fresh token is available — user must reconnect in the console",
              { agentId: opts.agentId },
            );
            throw new Error(
              "Anthropic OAuth token is invalid (invalid_grant). Please reconnect your Anthropic account in the console.",
            );
          }
        } else {
          logger.error(
            "Anthropic OAuth refresh failed with invalid_grant; no MERCURY_AGENT_ID set for console fetch",
          );
          throw new Error(
            "Anthropic OAuth token is invalid (invalid_grant). Please reconnect your Anthropic account in the console.",
          );
        }
      } else if (isInvalidGrant) {
        // No console configured — cannot recover; surface the failure.
        logger.error(
          "Anthropic OAuth refresh failed with invalid_grant; re-authentication required",
        );
        throw new Error(
          "Anthropic OAuth token is invalid (invalid_grant). Please reconnect your Anthropic account.",
        );
      } else {
        // Transient error (network, 429, etc.) — current access token may still be valid.
        logger.warn(
          "Anthropic OAuth refresh failed at spawn time; using current access token",
          err instanceof Error ? err : undefined,
        );
      }
    }
  } else if (needsRefresh) {
    logger.warn(
      "Anthropic OAuth token expired; skipping refresh (rate-limit cooldown active)",
    );
  }

  return { access: freshAccess, updatedBlob };
}

const CONTAINER_LABEL = "mercury.managed=true";
const AGENT_ID_LABEL_KEY = "mercury.agent-id";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.join(__dirname, "../..");

/** Exit code 137 = SIGKILL (128 + 9), typically from OOM killer */
const OOM_EXIT_CODE = 137;

export class AgentContainerRunner {
  // Inner containers now run detached (no long-lived `docker` child process to
  // hold a handle to), so we track only the container name — termination is by
  // `docker kill <name>`, and the per-message poll loop owns cleanup.
  private readonly runningBySpace = new Map<
    string,
    { containerName: string }
  >();
  private readonly abortedSpaces = new Set<string>();
  private readonly timedOutSpaces = new Set<string>();
  private containerCounter = 0;
  private buildState: ExtImageBuildState | undefined = undefined;
  private readonly resolvedApiHost: string;

  constructor(private readonly config: AppConfig) {
    this.validateImage();
    this.resolvedApiHost = this.resolveApiHost();
  }

  /**
   * Resolve the API host that inner containers will use to reach us.
   *
   * gVisor (runsc) cannot use Docker's embedded DNS (127.0.0.11 is unreachable
   * from the gVisor network sandbox), so container-name hostnames don't resolve.
   * Previously the outer container joined the shared default bridge (docker0) and
   * handed inner containers its bridge IP — but that left the outer reachable by
   * any neighbor on docker0, undercutting per-agent network isolation.
   *
   * Now inner containers reach the API over a per-agent unix socket (see
   * api-socket.ts), so the outer no longer joins docker0. API_URL becomes a dummy
   * (`http://localhost:<port>`) that mrctl ignores once API_SOCKET is set; we keep
   * it non-empty only so mrctl's presence assertion passes. runc/local are
   * unchanged and keep using the real hostname.
   */
  private resolveApiHost(): string {
    const configured = this.config.containerApiHost;
    if (!configured) return "host.docker.internal";
    if (this.config.containerRuntime !== "runsc") return configured;
    // gVisor: dummy host — the real transport is the unix socket (API_SOCKET).
    return "localhost";
  }

  /** Set a background build state — currentImage() is resolved at each spawn. */
  setBuildState(state: ExtImageBuildState): void {
    this.buildState = state;
  }

  /** The image to use for container spawns. */
  get image(): string {
    if (this.buildState) return this.buildState.currentImage();
    return this.config.agentContainerImage;
  }

  /**
   * Warn if using a custom image that might be missing required tools.
   * Known presets (mercury-agent:*) are assumed to be valid.
   */
  private validateImage(): void {
    const image = this.config.agentContainerImage;

    // Skip validation for known presets
    if (
      image.startsWith("mercury-agent:") ||
      image.includes("/mercury-agent:")
    ) {
      return;
    }

    // For custom images, log a warning about requirements
    logger.warn("Using custom agent image", {
      image,
      note: `Ensure image has: bun, pi, mrctl${this.config.containerRuntime === "runsc" ? "" : ", bubblewrap (runc mode)"}`,
      docs: "See docs/container-lifecycle.md for custom image requirements",
    });
  }

  /**
   * Ensure the agent image is available locally, pulling it if needed.
   * Should be called on startup before accepting work.
   */
  async ensureImage(): Promise<void> {
    const image = this.image;
    try {
      execSync(`docker image inspect ${image}`, {
        stdio: "ignore",
        timeout: 10_000,
      });
      logger.debug("Agent image found locally", { image });
    } catch {
      logger.info("Agent image not found locally, pulling...", { image });
      try {
        execSync(`docker pull ${image}`, {
          stdio: "inherit",
          timeout: 300_000,
        });
        logger.info("Agent image pulled successfully", { image });
      } catch {
        throw new Error(
          `Failed to pull agent image: ${image}\nRun manually: docker pull ${image}`,
        );
      }
    }
  }

  isRunning(spaceId: string): boolean {
    return this.runningBySpace.has(spaceId);
  }

  /**
   * Clean up any orphaned containers from previous runs.
   * Should be called on startup before accepting new work.
   */
  async cleanupOrphans(): Promise<number> {
    try {
      const agentId = process.env.MERCURY_AGENT_ID;
      const filter = agentId
        ? `--filter "label=${CONTAINER_LABEL}" --filter "label=${AGENT_ID_LABEL_KEY}=${agentId}"`
        : `--filter "label=${CONTAINER_LABEL}"`;
      // Find containers with our labels (running or stopped)
      const result = execSync(`docker ps -a ${filter} --format "{{.ID}}"`, {
        encoding: "utf8",
        timeout: 10_000,
      }).trim();

      if (!result) return 0;

      const containerIds = result.split("\n").filter(Boolean);
      if (containerIds.length === 0) return 0;

      logger.info("Found orphaned containers, cleaning up", {
        count: containerIds.length,
      });

      // Force remove all orphaned containers
      execSync(`docker rm -f ${containerIds.join(" ")}`, {
        encoding: "utf8",
        timeout: 30_000,
      });

      logger.info("Cleaned up orphaned containers", {
        count: containerIds.length,
      });
      return containerIds.length;
    } catch (error) {
      // If docker command fails (e.g., docker not installed), log and continue
      if (error instanceof Error && error.message.includes("ENOENT")) {
        logger.warn("Docker not found, skipping orphan cleanup");
      } else {
        logger.warn(
          "Failed to cleanup orphaned containers",
          error instanceof Error ? error : undefined,
        );
      }
      return 0;
    }
  }

  /**
   * Kill all running containers using docker kill for reliable termination.
   * Note: runningBySpace entries are cleaned up by each reply()'s poll loop.
   * During shutdown the loop may not run before exit, but that's fine —
   * Docker cleans up --rm containers regardless once killed.
   */
  killAll(): void {
    for (const [spaceId, { containerName }] of this.runningBySpace) {
      this.abortedSpaces.add(spaceId);
      try {
        execSync(`docker kill ${containerName}`, { timeout: 5000 });
      } catch {
        // docker kill can fail (container already exited/reaped) — the poll loop
        // observes abortedSpaces and unwinds either way.
      }
    }
  }

  get activeCount(): number {
    return this.runningBySpace.size;
  }

  getActiveSpaces(): string[] {
    return [...this.runningBySpace.keys()];
  }

  abort(spaceId: string): boolean {
    const entry = this.runningBySpace.get(spaceId);
    if (!entry) return false;

    this.abortedSpaces.add(spaceId);

    // Use docker kill for reliable container termination; the poll loop observes
    // abortedSpaces and rejects the in-flight reply().
    try {
      execSync(`docker kill ${entry.containerName}`, { timeout: 5000 });
    } catch {
      // docker kill can fail (container already exited/reaped) — abortedSpaces
      // still unwinds the poll loop.
    }
    return true;
  }

  private generateContainerName(): string {
    const id = ++this.containerCounter;
    const timestamp = Date.now();
    const agentId = process.env.MERCURY_AGENT_ID;
    return agentId
      ? `mercury-${agentId}-${timestamp}-${id}`
      : `mercury-${timestamp}-${id}`;
  }

  async reply(input: {
    spaceId: string;
    spaceWorkspace: string;
    messages: StoredMessage[];
    anchorMessages?: StoredMessage[];
    prompt: string;
    callerId: string;
    callerRole?: string;
    authorName?: string;
    attachments?: MessageAttachment[];
    preferences?: Array<{ key: string; value: string }>;
    extraEnv?: Record<string, string>;
    claimedEnvSources?: Set<string>;
  }): Promise<ContainerResult> {
    const globalDir = path.resolve(this.config.globalDir);
    const spacesRoot = path.resolve(this.config.spacesDir);

    fs.mkdirSync(globalDir, { recursive: true });
    fs.mkdirSync(spacesRoot, { recursive: true });
    try {
      execFileSync("chown", ["-R", "1000:1000", globalDir], { stdio: "pipe" });
    } catch {
      // CAP_CHOWN may be unavailable (--cap-drop=ALL without --cap-add=CHOWN).
      // Skills are installed world-readable, so the inner container (uid 1000)
      // can still read them. New containers should have --cap-add=CHOWN.
      logger.warn(
        "chown globalDir failed (CAP_CHOWN unavailable), continuing",
        { globalDir },
      );
    }

    const authFromPi = await getApiKeyFromPiAuthFile({
      provider: this.config.modelProvider,
      authPath: this.config.authPath ?? path.join(globalDir, "auth.json"),
    });

    // Env vars that should never be passed to containers
    const BLOCKED_ENV_VARS = new Set([
      "MERCURY_API_SECRET",
      // Host-only: the inner→outer API socket path is set by code per spawn;
      // never let an agent override which socket mrctl targets.
      "MERCURY_API_SOCKET",
      "MERCURY_CHAT_API_KEY",
      "MERCURY_ADMINS",
      // Host-only: affects `docker run` flags, not the agent process inside the container
      "MERCURY_CONTAINER_BWRAP_DOCKER_COMPAT",
      // Host-only: selects the OCI runtime for `docker run --runtime`; not meaningful inside the container
      "MERCURY_CONTAINER_RUNTIME",
      // Host-only: resolved volume mountpoint on the host; inner containers don't need it
      "MERCURY_HOST_DATA_DIR",
      "MERCURY_SLACK_BOT_TOKEN",
      "MERCURY_SLACK_SIGNING_SECRET",
      "MERCURY_DISCORD_BOT_TOKEN",
      "MERCURY_DISCORD_GATEWAY_SECRET",
      "MERCURY_TELEGRAM_BOT_TOKEN",
      "MERCURY_TELEGRAM_WEBHOOK_SECRET_TOKEN",
      "MERCURY_TEAMS_APP_ID",
      "MERCURY_TEAMS_APP_PASSWORD",
      "MERCURY_WHATSAPP_AUTH_DIR",
    ]);

    // Pass MERCURY_* vars to container with prefix stripped, excluding blocked vars
    const claimed = input.claimedEnvSources;
    const passthroughEnvPairs = Object.entries(process.env)
      .filter(
        (entry): entry is [string, string] =>
          entry[0].startsWith("MERCURY_") &&
          entry[1] !== undefined &&
          !BLOCKED_ENV_VARS.has(entry[0]) &&
          !claimed?.has(entry[0]),
      )
      .map(([key, value]) => ({
        key: key.replace("MERCURY_", ""),
        value: value,
      }));

    // Legacy path: older console versions stored the OAuth credential blob in
    // MERCURY_ANTHROPIC_API_KEY instead of MERCURY_ANTHROPIC_OAUTH_TOKEN.
    // Current console uses MERCURY_ANTHROPIC_OAUTH_TOKEN (handled below), but
    // keep this guard so agents provisioned before the migration don't break.
    const anthApiKeyIdx = passthroughEnvPairs.findIndex(
      (p) =>
        p.key === "ANTHROPIC_API_KEY" && p.value.trimStart().startsWith("{"),
    );
    if (anthApiKeyIdx !== -1) {
      try {
        const raw = passthroughEnvPairs[anthApiKeyIdx]?.value ?? "";
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const access =
          typeof parsed.access === "string" ? parsed.access : undefined;
        if (access) {
          passthroughEnvPairs.splice(anthApiKeyIdx, 1);
          passthroughEnvPairs.push({
            key: "ANTHROPIC_OAUTH_TOKEN",
            value: access,
          });
        }
      } catch {
        // Not valid JSON — leave as-is and let pi handle/reject it
      }
    }

    // MERCURY_ANTHROPIC_OAUTH_TOKEN now carries a full credential blob
    // ({"access":"...","refresh":"...","expires":...}) so the fork can refresh
    // the access token at each spawn instead of relying on the frozen value
    // injected when the outer container started. Remove the blob unconditionally
    // to ensure raw JSON never leaks into the inner container, then push a fresh
    // bare token (or the current token if refresh fails / is rate-limited).
    const anthOauthIdx = passthroughEnvPairs.findIndex(
      (p) =>
        p.key === "ANTHROPIC_OAUTH_TOKEN" &&
        p.value.trimStart().startsWith("{"),
    );
    if (anthOauthIdx !== -1) {
      const raw = passthroughEnvPairs[anthOauthIdx]?.value ?? "";
      passthroughEnvPairs.splice(anthOauthIdx, 1);
      let parsedCreds: AnthropicOAuthCreds | undefined;
      try {
        parsedCreds = JSON.parse(raw) as AnthropicOAuthCreds;
      } catch {
        logger.warn("Anthropic OAuth blob corrupt; skipping token injection");
      }
      if (parsedCreds) {
        const { access, updatedBlob } = await resolveOAuthCredentialForSpawn(
          parsedCreds,
          {
            consoleUrl: this.config.consoleUrl,
            consoleInternalSecret: this.config.consoleInternalSecret,
            agentId: process.env.MERCURY_AGENT_ID,
          },
        );
        // Update outer container's in-process env so subsequent spawns within
        // this process lifetime start with the fresh blob (avoids re-refreshing
        // a token that was just fetched). Not persisted across process restarts.
        if (updatedBlob) {
          process.env.MERCURY_ANTHROPIC_OAUTH_TOKEN = updatedBlob;
        }
        passthroughEnvPairs.push({
          key: "ANTHROPIC_OAUTH_TOKEN",
          value: access,
        });
      }
    }

    // Check for pi auth file fallback for Anthropic
    const hasAnthropicKey = passthroughEnvPairs.some(
      (p) => p.key === "ANTHROPIC_API_KEY" || p.key === "ANTHROPIC_OAUTH_TOKEN",
    );
    if (
      !hasAnthropicKey &&
      this.config.modelProvider === "anthropic" &&
      authFromPi
    ) {
      passthroughEnvPairs.push({
        key: "ANTHROPIC_OAUTH_TOKEN",
        value: authFromPi,
      });
    }

    const envPairs = [
      // Internal vars (set by code, not from env)
      { key: "HOME", value: "/home/mercury" },
      {
        key: "PATH",
        value:
          "/home/mercury/.local/bin:/home/mercury/.bun/bin:/usr/local/go/bin:/usr/local/bin:/usr/bin:/bin",
      },
      { key: "PI_CODING_AGENT_DIR", value: "/home/mercury/.pi/agent" },
      { key: "CALLER_ID", value: input.callerId },
      { key: "SPACE_ID", value: input.spaceId },
      {
        key: "API_URL",
        value: `http://${this.resolvedApiHost}:${this.config.port}`,
      },
      // API secret for mrctl auth from inside containers
      { key: "API_SECRET", value: this.config.apiSecret ?? "" },
      // gVisor: inner containers reach the API over a per-agent unix socket
      // (the outer is off docker0). mrctl uses this transport when set; API_URL
      // host/port above are then ignored. Absent for runc/local.
      ...(this.config.containerRuntime === "runsc"
        ? [{ key: "API_SOCKET", value: innerApiSocketPath() }]
        : []),
      // Passthrough vars (MERCURY_* with prefix stripped)
      ...passthroughEnvPairs,
      // Host-resolved model chain (overrides any stale MODEL_CHAIN from passthrough)
      {
        key: "MODEL_CHAIN",
        value: JSON.stringify(this.config.resolvedModelChain),
      },
      {
        key: "MODEL_RETRY_MAX_PER_LEG",
        value: String(this.config.modelMaxRetriesPerLeg),
      },
      {
        key: "MODEL_CHAIN_BUDGET_MS",
        value: String(this.config.effectiveModelChainBudgetMs),
      },
      {
        key: "MODEL_CHAIN_CAPABILITIES",
        value: JSON.stringify(this.config.resolvedModelChainCapabilities),
      },
      {
        key: "OVERRIDE_PI_SYSTEM_PROMPT",
        value: this.config.overridePiSystemPrompt ? "true" : "false",
      },
    ].filter((x): x is { key: string; value: string } => Boolean(x.value));

    const containerName = this.generateContainerName();

    // Resolve docs paths for self-documenting agent
    const docsDir = path.resolve(PACKAGE_ROOT, "docs");
    const readmePath = path.resolve(PACKAGE_ROOT, "README.md");

    // In cloud deployments the outer container runs with a Docker named volume at
    // config.globalDir / config.spacesDir. When those paths are passed as bind-mount
    // sources to the host Docker daemon (via the Docker socket), the daemon treats them
    // as HOST filesystem paths — a different directory from the volume. Setting
    // MERCURY_HOST_DATA_DIR to the volume's actual host-side mountpoint
    // (/var/lib/docker/volumes/<name>/_data) lets inner containers mount the same data
    // the outer container reads and writes. Falls back to config paths for local dev
    // where no named volume is in use.
    const hostDataDir = process.env.MERCURY_HOST_DATA_DIR;
    const innerGlobalDir = hostDataDir
      ? path.join(hostDataDir, "global")
      : globalDir;
    const innerSpacesRoot = hostDataDir
      ? path.join(hostDataDir, "spaces")
      : spacesRoot;

    // Mount only the specific space directory for isolation
    const spaceDir = path.resolve(spacesRoot, input.spaceId);
    const innerSpaceDir = path.join(innerSpacesRoot, input.spaceId);
    fs.mkdirSync(spaceDir, { recursive: true });
    try {
      execFileSync("chown", ["-R", "1000:1000", spaceDir], { stdio: "pipe" });
    } catch {
      logger.warn(
        "chown spaceDir failed (CAP_CHOWN unavailable), falling back to chmod 777",
        { spaceDir },
      );
      try {
        fs.chmodSync(spaceDir, 0o777);
      } catch {
        logger.warn(
          "chmod spaceDir also failed, inner container may lack write access",
          { spaceDir },
        );
      }
    }

    const agentId = process.env.MERCURY_AGENT_ID;
    // `docker create` (not `run`) and no `-i`: the container is started detached
    // and communicates over the mounted IO dir, never the attach stream. This is
    // the only launch shape that survives the Bun body-proxy on the cloud agent
    // lane (it cannot proxy Docker's hijacked attach connection).
    const args = [
      "create",
      "--rm",
      "--name",
      containerName,
      "--label",
      CONTAINER_LABEL,
      ...(agentId ? ["--label", `${AGENT_ID_LABEL_KEY}=${agentId}`] : []),
    ];

    if (
      this.config.containerNetwork &&
      this.config.containerRuntime !== "runsc"
    ) {
      // runc: join the shared network so inner containers can resolve the
      // outer container by DNS name and reach external APIs.
      args.push("--network", this.config.containerNetwork);
    } else {
      // Default bridge (no --network flag). gVisor always lands here because
      // user-defined Docker networks break gVisor's outbound DNS (Docker's
      // embedded resolver at 127.0.0.11 is unreachable from gVisor). Inner
      // containers keep docker0 for outbound DNS/HTTPS; the inner→outer API
      // callback rides the per-agent unix socket (API_SOCKET), not docker0.
      args.push("--add-host", "host.docker.internal:host-gateway");
    }

    // Per-message IO dir — the detached reply channel. Mirrors the global/spaces
    // host-path translation: the host bind source must live under the agent's own
    // data volume (`hostDataDir`) so it satisfies the body-proxy's RW-bind
    // allowlist (`/var/lib/docker/volumes/mercury-<agentId>-data/...`). The outer
    // writes input.json here; the inner writes result.json back.
    const ioLocalDir = path.join(
      resolveProjectPath(this.config.dataDir),
      "io",
      containerName,
    );
    const ioHostDir = hostDataDir
      ? path.join(hostDataDir, "io", containerName)
      : ioLocalDir;

    args.push(
      "-v",
      `${innerSpaceDir}:/spaces/${input.spaceId}`,
      "-v",
      `${innerGlobalDir}:/home/mercury/.pi/agent`,
      "-v",
      `${readmePath}:/docs/mercury/README.md:ro`,
      "-v",
      `${docsDir}:/docs/mercury/docs:ro`,
      "-v",
      `${ioHostDir}:${INNER_IO_DIR}`,
      "-e",
      `IO_DIR=${INNER_IO_DIR}`,
    );

    if (this.config.containerRuntime === "runsc") {
      // Mount the per-agent run dir so the inner container can reach the outer's
      // API unix socket (api-<hostname>.sock, created in main.ts). Mirrors the
      // global/spaces host-path translation: the host-side source is the data
      // volume's run dir, exposed at /run/mercury inside the inner container.
      // Resolve dataDir with the same helper main.ts uses to create the socket,
      // so the bind source and the listener never disagree on the run-dir path.
      const localRunDir = apiSocketDir(resolveProjectPath(this.config.dataDir));
      const innerRunDir = hostDataDir ? apiSocketDir(hostDataDir) : localRunDir;
      // Ensure the host bind source exists (main.ts created it at startup; this
      // guards against config drift). Created in the in-container data dir, which
      // is the same volume the host path resolves to.
      fs.mkdirSync(localRunDir, { recursive: true });
      args.push("-v", `${innerRunDir}:${INNER_RUN_DIR}`);
      // gVisor: intercepts all syscalls at a user-space kernel boundary — no bwrap needed.
      // Restores full Docker hardening (SYS_ADMIN relaxation not required).
      // CONTAINER_RUNTIME=runsc is passed explicitly (stripped prefix) so container-entry
      // skips the bwrap spawn path.
      args.push(
        "--runtime=runsc",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--memory=2g",
        "--cpus=2",
        "--pids-limit=512",
        "-e",
        "CONTAINER_RUNTIME=runsc",
      );
    } else if (this.config.containerBwrapDockerCompat) {
      // runc + bwrap: bubblewrap needs extra namespace syscalls that Docker's default
      // seccomp/caps/AppArmor block. seccomp=unconfined allows unshare; apparmor=unconfined
      // allows mount(MS_SLAVE); SYS_ADMIN grants the mount capability. Bwrap remains active
      // inside the container; only the outer Docker layer is relaxed.
      args.push(
        "--security-opt",
        "seccomp=unconfined",
        "--security-opt",
        "apparmor=unconfined",
        "--cap-add",
        "SYS_ADMIN",
      );
    }

    for (const { key, value } of envPairs) {
      args.push("-e", `${key}=${value}`);
    }

    // Extension env vars from before_container hooks
    if (input.extraEnv) {
      for (const [key, value] of Object.entries(input.extraEnv)) {
        args.push("-e", `${key}=${value}`);
      }
    }

    const buildingNow = this.buildState?.building ?? false;
    const spawnImage = this.image;
    if (buildingNow) {
      logger.info("Ext image still building, spawning with base image", {
        image: spawnImage,
      });
    }
    args.push(spawnImage);

    // Per-run nonce — retained in the payload for the inner container's legacy
    // stdout-marker fallback (used only for direct/manual attach against a real
    // daemon; the detached cloud path reads result.json instead).
    const nonce = randomBytes(8).toString("hex");

    const payload = {
      ...input,
      messages: input.messages,
      anchorMessages: input.anchorMessages,
      spaceWorkspace: input.spaceWorkspace
        .replace(spacesRoot, "/spaces")
        .replaceAll("\\", "/"),
      callerRole: input.callerRole ?? "member",
      authorName: input.authorName,
      nonce,
    };

    // Create child logger with context for this container run
    const log: Logger = logger.child({
      spaceId: input.spaceId,
      container: containerName,
    });

    const startTime = Date.now();

    // Stage the request payload where the inner container will read it, and make
    // the dir writable by the inner uid (1000) so it can drop result.json back.
    fs.mkdirSync(ioLocalDir, { recursive: true });
    fs.writeFileSync(
      path.join(ioLocalDir, "input.json"),
      JSON.stringify(payload),
    );
    try {
      execFileSync("chown", ["-R", "1000:1000", ioLocalDir], { stdio: "pipe" });
    } catch {
      try {
        fs.chmodSync(ioLocalDir, 0o777);
      } catch {
        logger.warn("chown/chmod ioDir failed; inner may not write result", {
          ioLocalDir,
        });
      }
    }

    const resultPath = path.join(ioLocalDir, "result.json");
    const cleanupIo = () => {
      try {
        fs.rmSync(ioLocalDir, { recursive: true, force: true });
      } catch {
        // best effort — orphaned IO dirs are harmless and small
      }
    };

    // Create the container (detached). `docker create` is where a pruned/missing
    // image surfaces (exit 125, "No such image"/"Unable to find image"), so this
    // error shape feeds replyWithRetry's rebuild-and-retry path unchanged.
    const created = await execDocker(args);
    if (created.code !== 0) {
      cleanupIo();
      const output = created.timedOut
        ? `docker create timed out after ${Math.round(EXEC_DOCKER_TIMEOUT_MS / 1000)}s — Docker daemon may be unresponsive`
        : created.stderr ||
          created.stdout ||
          `docker create exited with code ${created.code} (no output)`;
      log.error("docker create failed", {
        exitCode: created.code,
        timedOut: created.timedOut,
        output,
      });
      throw ContainerError.error(created.code, output);
    }

    this.runningBySpace.set(input.spaceId, { containerName });
    const deadline = startTime + this.config.containerTimeoutMs;

    try {
      // Start detached — no `-a`/attach, so the body-proxy only sees
      // POST /containers/<id>/start (plain request/response). Returns immediately.
      const started = await execDocker(["start", containerName]);
      if (started.code !== 0) {
        const output = started.timedOut
          ? `docker start timed out after ${Math.round(EXEC_DOCKER_TIMEOUT_MS / 1000)}s — Docker daemon may be unresponsive`
          : started.stderr ||
            started.stdout ||
            `docker start exited with code ${started.code} (no output)`;
        log.error("docker start failed", {
          exitCode: started.code,
          timedOut: started.timedOut,
          containerName,
          output,
        });
        throw ContainerError.error(started.code, output);
      }
      log.info("Container started", { event: "container.start" });

      // Poll the mounted result file. The inner container writes result.json
      // atomically (tmp + rename) on every outcome, so its presence means a
      // complete payload. A periodic `docker inspect` fails fast if the container
      // died without writing one (hard crash / OOM) instead of waiting out the
      // full timeout.
      let iter = 0;
      while (true) {
        if (fs.existsSync(resultPath)) {
          return this.consumeResult(resultPath, input, startTime, log);
        }

        if (this.timedOutSpaces.has(input.spaceId) || Date.now() >= deadline) {
          this.timedOutSpaces.delete(input.spaceId);
          await execDocker(["kill", containerName]);
          // The kill loses the race against a just-written result occasionally.
          if (fs.existsSync(resultPath)) {
            return this.consumeResult(resultPath, input, startTime, log);
          }
          log.warn("Container exited", {
            event: "container.end",
            durationMs: Date.now() - startTime,
            reason: "timeout",
          });
          throw ContainerError.timeout(input.spaceId);
        }

        if (this.abortedSpaces.has(input.spaceId)) {
          this.abortedSpaces.delete(input.spaceId);
          await execDocker(["kill", containerName]);
          log.info("Container exited", {
            event: "container.end",
            durationMs: Date.now() - startTime,
            reason: "aborted",
          });
          throw ContainerError.aborted(input.spaceId);
        }

        if (++iter % LIVENESS_EVERY === 0) {
          const crash = await this.detectCrash(
            containerName,
            resultPath,
            input.spaceId,
          );
          if (crash) {
            log.error("Container exited", {
              event: "container.end",
              exitCode: crash.exitCode,
              durationMs: Date.now() - startTime,
              reason: crash.reason,
            });
            throw crash;
          }
          // detectCrash may have observed result.json appear during its grace wait
          if (fs.existsSync(resultPath)) {
            return this.consumeResult(resultPath, input, startTime, log);
          }
        }

        await sleep(RESULT_POLL_MS);
      }
    } finally {
      this.runningBySpace.delete(input.spaceId);
      cleanupIo();
    }
  }

  /**
   * Parse the inner container's result file and build the ContainerResult.
   * `{ ok: false }` means the container caught its own failure and reported it;
   * surface it as an error so callers see the real message rather than a generic
   * crash.
   */
  private consumeResult(
    resultPath: string,
    input: { spaceId: string; spaceWorkspace: string },
    startTime: number,
    log: Logger,
  ): ContainerResult {
    let parsed: {
      ok?: boolean;
      reply?: string;
      usage?: TokenUsage;
      error?: string;
    };
    try {
      parsed = JSON.parse(fs.readFileSync(resultPath, "utf8"));
    } catch (e) {
      throw new Error(
        `Malformed container result: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    if (parsed.ok === false) {
      throw ContainerError.error(
        1,
        parsed.error ?? "container reported failure",
      );
    }

    log.info("Container exited", {
      event: "container.end",
      exitCode: 0,
      durationMs: Date.now() - startTime,
    });

    const replyText = parsed.reply ?? "Done.";
    const files = scanOutbox(input.spaceWorkspace, startTime);
    return { reply: replyText, files, usage: parsed.usage };
  }

  /**
   * Liveness probe used while polling for the result file. Returns a
   * ContainerError when the inner container is gone/exited without producing a
   * result (a hard crash the container couldn't catch — e.g. OOM kill, gVisor
   * panic), or `null` if it's still running. Grants a short grace so the
   * exit→result-write→--rm-reap race resolves in favour of a real result.
   */
  private async detectCrash(
    containerName: string,
    resultPath: string,
    spaceId: string,
  ): Promise<ContainerError | null> {
    const insp = await execDocker([
      "inspect",
      "-f",
      "{{.State.Status}}|{{.State.ExitCode}}|{{.State.OOMKilled}}",
      containerName,
    ]);

    // Container still present and running — no crash.
    if (insp.code === 0 && insp.stdout.trim().startsWith("running")) {
      return null;
    }

    // Either inspect 404'd (--rm already reaped an exited container) or the
    // container is in a terminal state. Give the result file a moment to land.
    await sleep(RESULT_POLL_MS);
    if (fs.existsSync(resultPath)) return null;

    if (insp.code !== 0) {
      // Reaped without a result — exit code is unrecoverable post-reap.
      return ContainerError.error(
        1,
        "inner container exited without producing a result (possible crash)",
      );
    }

    const [, exitStr, oom] = insp.stdout.trim().split("|");
    const exitCode = Number.parseInt(exitStr ?? "1", 10) || 1;
    if (oom === "true" || exitCode === OOM_EXIT_CODE) {
      return ContainerError.oom(spaceId, exitCode);
    }
    return ContainerError.error(
      exitCode,
      "inner container exited without producing a result",
    );
  }

  /**
   * Spawn a container for a reply, with automatic recovery if the derived ext
   * image was pruned by a rolling deploy.
   *
   * Docker returns exit code 125 with "No such image" or "Unable to find image"
   * in stderr when an image that existed at build time has since been pruned.
   * On that specific error we trigger a background rebuild and immediately retry
   * with the base image so the current message is not dropped.
   *
   * rebuild() synchronously resets resolvedImage → baseImage before its first
   * await, so by the time we call reply() again this.image already returns the
   * base image. The rebuild completes in the background; subsequent spawns use
   * the fresh derived image once it is ready.
   */
  async replyWithRetry(
    input: Parameters<AgentContainerRunner["reply"]>[0],
  ): Promise<ContainerResult> {
    try {
      return await this.reply(input);
    } catch (err) {
      if (
        err instanceof ContainerError &&
        err.reason === "error" &&
        err.exitCode === 125 &&
        this.buildState &&
        (err.message.includes("No such image") ||
          err.message.includes("Unable to find image"))
      ) {
        // Capture before rebuild() resets resolvedImage to baseImage
        const missingImage = this.buildState.currentImage();
        // Fire rebuild without awaiting — rebuild() synchronously resets
        // resolvedImage to baseImage before its first internal await, so the
        // retry below immediately uses the base image rather than blocking for
        // the full ~4-minute Playwright build and timing out the connection.
        void this.buildState.rebuild().catch((rebuildErr) => {
          logger.error(
            "Unexpected error in background ext image rebuild",
            rebuildErr instanceof Error ? rebuildErr : undefined,
          );
        });
        logger.warn(
          "Ext image missing (pruned by rolling deploy?), triggering background rebuild and retrying with base image",
          { image: missingImage },
        );
        return await this.reply(input);
      }
      throw err;
    }
  }
}

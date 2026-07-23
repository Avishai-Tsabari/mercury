/**
 * Which host environment variables reach agent containers.
 *
 * Mercury passes `MERCURY_*` vars into containers with the prefix stripped.
 * That is convenient but blunt: a secret added to `.env` for one purpose is
 * exposed to every space's container, whoever triggered the turn. Vars an
 * extension declares via `mercury.env()` avoid this — they are injected in
 * runtime.ts behind the extension's permission gate instead.
 *
 * `containerEnvPassthrough: "claimed"` narrows the blunt path to nothing, so
 * declared vars are the only way in.
 */

/** Vars that must never reach a container, regardless of passthrough mode. */
export const BLOCKED_ENV_VARS = new Set([
  "MERCURY_API_SECRET",
  // Host-only: signs per-turn caller tokens. Injecting it would let the
  // agent forge a token for any caller, defeating the whole mechanism.
  "MERCURY_CALLER_TOKEN_KEY",
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

export type EnvPassthroughMode = "all" | "claimed";

/**
 * Host `MERCURY_*` var names that are neither blocked nor claimed by an
 * extension — the ones the blind passthrough carries into every container.
 *
 * Sorted, and names only: callers log these, and the values are the secrets.
 */
export function listUnclaimedPassthroughVars(
  env: NodeJS.ProcessEnv,
  claimed: Set<string> | undefined,
): string[] {
  return Object.keys(env)
    .filter(
      (key) =>
        key.startsWith("MERCURY_") &&
        env[key] !== undefined &&
        !BLOCKED_ENV_VARS.has(key) &&
        !claimed?.has(key),
    )
    .sort();
}

/**
 * The blind-passthrough pairs for a container spawn, with `MERCURY_` stripped.
 *
 * Extension-declared vars are excluded here on purpose — runtime.ts injects
 * those separately, behind the permission check. In "claimed" mode this
 * returns nothing at all.
 */
export function selectPassthroughEnv(
  env: NodeJS.ProcessEnv,
  claimed: Set<string> | undefined,
  mode: EnvPassthroughMode,
): Array<{ key: string; value: string }> {
  if (mode === "claimed") return [];

  return listUnclaimedPassthroughVars(env, claimed).map((key) => ({
    key: key.replace("MERCURY_", ""),
    // listUnclaimedPassthroughVars already filtered out undefined values.
    value: env[key] as string,
  }));
}

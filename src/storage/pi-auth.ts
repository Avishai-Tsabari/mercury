import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  getOAuthApiKey,
  type OAuthCredentials,
  type OAuthProviderId,
} from "@earendil-works/pi-ai/oauth";
import { logger } from "../logger.js";

type AuthEntry =
  | ({ type: "oauth" } & OAuthCredentials)
  | { type: "api_key"; key: string }
  | Record<string, unknown>;

type AuthFile = Record<string, AuthEntry>;

function readAuthFile(authPath: string): AuthFile {
  if (!fs.existsSync(authPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(authPath, "utf8")) as AuthFile;
  } catch (err) {
    logger.warn(
      `pi-auth: auth file at ${authPath} is malformed, ignoring`,
      err instanceof Error ? err : undefined,
    );
    return {};
  }
}

/**
 * Persist the auth file atomically: write a sibling temp file, then rename over
 * the target. A torn or partially-written auth.json is unrecoverable — Anthropic
 * rotates refresh tokens on every refresh, so the copy on disk is the only
 * record of the current link in the chain.
 *
 * The rename is retried because on Windows a concurrent reader holding a handle
 * makes `renameSync` fail with EPERM/EBUSY; the operation succeeds moments later.
 */
function writeAuthFile(authPath: string, auth: AuthFile): void {
  fs.mkdirSync(path.dirname(authPath), { recursive: true });
  const tmpPath = `${authPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(auth, null, 2), "utf8");
  try {
    fs.chmodSync(tmpPath, 0o600);
  } catch {
    // chmod is best-effort (no-op on some Windows setups); never fail the
    // persist over file permissions when a credential is waiting to be saved.
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.renameSync(tmpPath, authPath);
      return;
    } catch (err) {
      lastError = err;
      // Busy-wait briefly: this path is rare (~3x/day) and must stay sync so
      // callers cannot observe a half-persisted credential.
      const until = Date.now() + 20;
      while (Date.now() < until) {
        /* spin */
      }
    }
  }
  try {
    fs.rmSync(tmpPath, { force: true });
  } catch {
    // Leaving a stray temp file is preferable to masking the rename error.
  }
  throw lastError;
}

/**
 * Short, non-reversible fingerprint of a secret, safe to log. Used to make token
 * rotations identifiable after the fact without ever recording the token.
 */
function fingerprint(secret: string): string {
  return crypto.createHash("sha256").update(secret).digest("hex").slice(0, 12);
}

export type OAuthTokenEnvValue =
  | { status: "token"; token: string }
  | { status: "blob"; access: string }
  | { status: "corrupt-blob" }
  /** Whitespace-only value — treat the variable as unset. */
  | { status: "empty" };

/**
 * Interpret the raw value of MERCURY_ANTHROPIC_OAUTH_TOKEN. Console-provisioned
 * agents receive a full credential blob ({"access":"...","refresh":"...",
 * "expires":...}) rather than a bare token, so any code spawning pi on the host
 * must extract the access token instead of passing the value through verbatim.
 */
export function parseOAuthTokenEnv(raw: string): OAuthTokenEnvValue {
  const trimmed = raw.trim();
  if (!trimmed) return { status: "empty" };
  if (!trimmed.startsWith("{")) return { status: "token", token: trimmed };
  try {
    const blob = JSON.parse(trimmed) as { access?: unknown };
    if (typeof blob.access === "string" && blob.access) {
      return { status: "blob", access: blob.access };
    }
  } catch {
    // fall through to corrupt-blob
  }
  return { status: "corrupt-blob" };
}

export type PiAuthCredential =
  | { status: "ok"; apiKey: string }
  /** No usable oauth entry (or an env override takes precedence). */
  | { status: "none" }
  /** An oauth entry exists but could not be turned into a usable key. */
  | { status: "refresh-failed"; error?: Error };

// Deduplicate concurrent OAuth refreshes — refresh tokens are single-use, so
// two parallel calls with the same token race and one always fails.
const inflightRefresh = new Map<string, Promise<PiAuthCredential>>();

export async function getPiAuthCredential(options: {
  provider: string;
  authPath: string;
}): Promise<PiAuthCredential> {
  if (
    process.env.MERCURY_ANTHROPIC_API_KEY ||
    process.env.MERCURY_ANTHROPIC_OAUTH_TOKEN
  ) {
    return { status: "none" };
  }

  if (options.provider !== "anthropic") {
    return { status: "none" };
  }

  // Coalesce concurrent refreshes for the same auth file so only one
  // token-endpoint call is made; the rest share its result.
  //
  // The key must be canonical, not the caller's spelling: callers reach this
  // function with the same file written different ways (a relative
  // `.mercury/global/auth.json` from an extension, an absolute path from the
  // container runner). Relative paths already resolve against `process.cwd()`
  // inside `fs`, so `path.resolve` names the exact same file the raw spelling
  // would have opened — it only removes the caller's freedom to defeat the
  // dedupe by spelling. The resolved path is also what gets read, written and
  // logged, so one file never appears under two names in the logs. (The map is
  // process-local; coalescing across processes would need a lock file.)
  const key = path.resolve(options.authPath);
  const existing = inflightRefresh.get(key);
  if (existing) return existing;

  const promise = doGetPiAuthCredential({ ...options, authPath: key });
  inflightRefresh.set(key, promise);
  try {
    return await promise;
  } finally {
    inflightRefresh.delete(key);
  }
}

async function doGetPiAuthCredential(options: {
  provider: string;
  authPath: string;
}): Promise<PiAuthCredential> {
  const authPath = options.authPath;
  const auth = readAuthFile(authPath);

  const entry = auth.anthropic;
  if (!entry || typeof entry !== "object" || entry.type !== "oauth") {
    return { status: "none" };
  }

  const access = typeof entry.access === "string" ? entry.access : undefined;
  const refresh = typeof entry.refresh === "string" ? entry.refresh : undefined;
  const expires = typeof entry.expires === "number" ? entry.expires : undefined;
  if (!access || !refresh || typeof expires !== "number") {
    return { status: "none" };
  }

  // Step 1 — obtain a usable key. getOAuthApiKey only contacts the token
  // endpoint when the access token has expired; otherwise it returns the
  // existing credentials untouched. A throw here means the refresh itself was
  // rejected, which is a genuine credential failure.
  let result: Awaited<ReturnType<typeof getOAuthApiKey>>;
  try {
    result = await getOAuthApiKey("anthropic" satisfies OAuthProviderId, {
      anthropic: {
        access,
        refresh,
        expires,
      },
    });
  } catch (error) {
    logger.warn(
      `Failed to load anthropic oauth token from pi auth.json at ${authPath}`,
      error instanceof Error ? error : undefined,
    );
    return {
      status: "refresh-failed",
      error: error instanceof Error ? error : undefined,
    };
  }

  if (!result) return { status: "refresh-failed" };

  // Step 2 — persist, in its own scope. Anthropic rotates the refresh token on
  // every refresh (the old one is consumed server-side), so when a rotation has
  // happened the value in memory is the ONLY copy of the current chain link.
  // A failure to save it is therefore unrecoverable — but it is emphatically not
  // a refresh failure, and must not be reported as one: the key we hold is
  // valid, and failing the call here would break the chain instead of preserving
  // the one chance to use and re-save it.
  const nextCredentials = result.newCredentials;
  const rotated =
    typeof nextCredentials.refresh === "string" &&
    nextCredentials.refresh !== refresh;

  try {
    writeAuthFile(authPath, {
      ...auth,
      anthropic: {
        type: "oauth" as const,
        ...nextCredentials,
      },
    });
    if (rotated) {
      // The single log line that makes a broken chain diagnosable after the
      // fact: which link was replaced by which, without recording either token.
      logger.info("Rotated anthropic oauth refresh token", {
        authPath,
        previousRefresh: fingerprint(refresh),
        newRefresh: fingerprint(nextCredentials.refresh as string),
      });
    }
  } catch (error) {
    if (rotated) {
      logger.error(
        `CRITICAL: anthropic OAuth credential was rotated but could NOT be saved to ${authPath} — the previous refresh token is already consumed server-side, so this space will fail to authenticate once the current access token expires. Re-run mercury auth login from the project directory that owns this file.`,
        {
          authPath,
          previousRefresh: fingerprint(refresh),
          unsavedRefresh: fingerprint(nextCredentials.refresh as string),
          error: error instanceof Error ? error.message : String(error),
        },
      );
    } else {
      // No rotation occurred, so the on-disk copy is still current and nothing
      // was lost — the rewrite was a no-op carrying identical content.
      logger.warn(
        `Could not rewrite pi auth.json at ${authPath} (no rotation occurred, stored credential is unchanged)`,
        error instanceof Error ? error : undefined,
      );
    }
  }

  logger.debug("Loaded anthropic oauth token from pi auth.json", {
    authPath,
  });
  return { status: "ok", apiKey: result.apiKey };
}

/** Back-compat wrapper: returns the key on success, undefined otherwise. */
export async function getApiKeyFromPiAuthFile(options: {
  provider: string;
  authPath: string;
}): Promise<string | undefined> {
  const result = await getPiAuthCredential(options);
  return result.status === "ok" ? result.apiKey : undefined;
}

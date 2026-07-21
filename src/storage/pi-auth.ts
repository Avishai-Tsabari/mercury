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

function writeAuthFile(authPath: string, auth: AuthFile): void {
  fs.mkdirSync(path.dirname(authPath), { recursive: true });
  fs.writeFileSync(authPath, JSON.stringify(auth, null, 2), "utf8");
  fs.chmodSync(authPath, 0o600);
}

export type PiAuthCredential =
  | { status: "ok"; apiKey: string }
  /** No usable oauth entry (or an env override takes precedence). */
  | { status: "none" }
  /** An oauth entry exists but could not be turned into a usable key. */
  | { status: "refresh-failed"; error?: Error };

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

  try {
    const result = await getOAuthApiKey("anthropic" satisfies OAuthProviderId, {
      anthropic: {
        access,
        refresh,
        expires,
      },
    });

    if (!result) return { status: "refresh-failed" };

    const nextAuth = {
      ...auth,
      anthropic: {
        type: "oauth" as const,
        ...result.newCredentials,
      },
    };

    writeAuthFile(authPath, nextAuth);
    logger.debug("Loaded anthropic oauth token from pi auth.json", {
      authPath,
    });
    return { status: "ok", apiKey: result.apiKey };
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
}

/** Back-compat wrapper: returns the key on success, undefined otherwise. */
export async function getApiKeyFromPiAuthFile(options: {
  provider: string;
  authPath: string;
}): Promise<string | undefined> {
  const result = await getPiAuthCredential(options);
  return result.status === "ok" ? result.apiKey : undefined;
}

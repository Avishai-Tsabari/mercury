/**
 * Caller-bound capability token.
 *
 * Mercury's in-container CLIs authenticate to the host control-plane API with a
 * single shared `API_SECRET` and, historically, assert their identity via the
 * spoofable `x-mercury-caller` / `x-mercury-space` headers. Because `API_SECRET`
 * is readable inside the container, any code there could claim to be any caller.
 *
 * This module mints a short-lived, HMAC-signed token at container spawn, bound
 * to `{callerId, spaceId}`. The host verifies it and uses the token payload as
 * the authoritative identity for authorization — so a container cannot forge a
 * different caller.
 *
 * The signing key NEVER enters a container. When no key is configured
 * (`callerTokenKey`), an ephemeral random key is generated once per host process
 * — sufficient because tokens are per-turn and short-lived. A configured key is
 * only needed when minting and verification happen in separate processes.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export interface CallerTokenClaims {
  callerId: string;
  spaceId: string;
  /** Expiry, unix seconds. */
  exp: number;
}

/** Ephemeral host-only key, generated lazily when no key is configured. */
let ephemeralKey: Buffer | null = null;

function resolveKey(configuredKey?: string): Buffer {
  if (configuredKey && configuredKey.length > 0) {
    return Buffer.from(configuredKey, "utf8");
  }
  if (!ephemeralKey) {
    ephemeralKey = randomBytes(32);
  }
  return ephemeralKey;
}

/** Mint a signed caller token. `configuredKey` falls back to a host ephemeral key. */
export function mintCallerToken(
  claims: CallerTokenClaims,
  configuredKey?: string,
): string {
  const key = resolveKey(configuredKey);
  const payload = Buffer.from(
    JSON.stringify({ c: claims.callerId, s: claims.spaceId, exp: claims.exp }),
    "utf8",
  ).toString("base64url");
  const sig = createHmac("sha256", key).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

/**
 * Verify a caller token. Returns the bound identity on success, or null if the
 * signature is invalid, the payload is malformed, or the token has expired.
 */
export function verifyCallerToken(
  token: string,
  configuredKey?: string,
  nowSeconds?: number,
): { callerId: string; spaceId: string } | null {
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;

  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const key = resolveKey(configuredKey);
  const expected = createHmac("sha256", key)
    .update(payload)
    .digest("base64url");

  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }

  let decoded: { c?: unknown; s?: unknown; exp?: unknown };
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (
    typeof decoded.c !== "string" ||
    typeof decoded.s !== "string" ||
    typeof decoded.exp !== "number"
  ) {
    return null;
  }

  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  if (decoded.exp < now) return null;

  return { callerId: decoded.c, spaceId: decoded.s };
}

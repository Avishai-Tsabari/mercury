import { createSign, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { TtsLanguage } from "./language.js";

const GOOGLE_VOICES: Record<TtsLanguage, string> = {
  "he-IL": "he-IL-Standard-A",
  "en-US": "en-US-Neural2-C",
};

interface ServiceAccountJson {
  client_email?: string;
  private_key?: string;
}

function base64url(data: string | Buffer): string {
  const buf = typeof data === "string" ? Buffer.from(data) : data;
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
}

async function fetchGoogleAccessToken(credsPath: string): Promise<string> {
  let raw: ServiceAccountJson;
  try {
    raw = JSON.parse(readFileSync(credsPath, "utf-8")) as ServiceAccountJson;
  } catch (e) {
    throw new Error(
      `Invalid Google service account JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const email = raw.client_email?.trim();
  const privateKey = raw.private_key?.trim();
  if (!email || !privateKey) {
    throw new Error(
      "Google service account JSON missing client_email or private_key",
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      iss: email,
      scope: "https://www.googleapis.com/auth/cloud-platform",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
      jti: base64url(randomBytes(16)),
    }),
  );
  const signInput = `${header}.${payload}`;
  const sign = createSign("RSA-SHA256");
  sign.update(signInput);
  sign.end();
  const sig = base64url(sign.sign(privateKey));
  const jwt = `${signInput}.${sig}`;

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  const tokenJson = (await tokenRes.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };

  if (!tokenRes.ok || !tokenJson.access_token) {
    const msg =
      tokenJson.error_description ||
      tokenJson.error ||
      `HTTP ${tokenRes.status}`;
    throw new Error(`Google OAuth token failed: ${msg}`);
  }

  return tokenJson.access_token;
}

export async function synthesizeGoogle(opts: {
  credentialsPath: string;
  text: string;
  language: TtsLanguage;
}): Promise<Buffer> {
  const accessToken = await fetchGoogleAccessToken(opts.credentialsPath);
  const voiceName = GOOGLE_VOICES[opts.language];

  const body = {
    input: { text: opts.text },
    voice: {
      languageCode: opts.language,
      name: voiceName,
    },
    audioConfig: {
      audioEncoding: "MP3",
    },
  };

  const res = await fetch(
    "https://texttospeech.googleapis.com/v1/text:synthesize",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );

  const data = (await res.json()) as {
    audioContent?: string;
    error?: { message?: string; code?: number };
  };

  if (!res.ok || !data.audioContent) {
    const msg = data.error?.message || `HTTP ${res.status}`;
    throw new Error(`Google TTS failed: ${msg}`);
  }

  return Buffer.from(data.audioContent, "base64");
}

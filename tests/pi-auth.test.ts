import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getPiAuthCredential } from "../src/storage/pi-auth.js";

describe("getPiAuthCredential", () => {
  let dir: string;
  let authPath: string;
  const savedApiKey = process.env.MERCURY_ANTHROPIC_API_KEY;
  const savedOauth = process.env.MERCURY_ANTHROPIC_OAUTH_TOKEN;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-auth-test-"));
    authPath = path.join(dir, "auth.json");
    delete process.env.MERCURY_ANTHROPIC_API_KEY;
    delete process.env.MERCURY_ANTHROPIC_OAUTH_TOKEN;
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (savedApiKey !== undefined)
      process.env.MERCURY_ANTHROPIC_API_KEY = savedApiKey;
    else delete process.env.MERCURY_ANTHROPIC_API_KEY;
    if (savedOauth !== undefined)
      process.env.MERCURY_ANTHROPIC_OAUTH_TOKEN = savedOauth;
    else delete process.env.MERCURY_ANTHROPIC_OAUTH_TOKEN;
  });

  test("returns none when auth file is missing", async () => {
    const result = await getPiAuthCredential({
      provider: "anthropic",
      authPath,
    });
    expect(result.status).toBe("none");
  });

  test("returns none for non-anthropic providers", async () => {
    const result = await getPiAuthCredential({ provider: "openai", authPath });
    expect(result.status).toBe("none");
  });

  test("returns none when env override is set", async () => {
    process.env.MERCURY_ANTHROPIC_API_KEY = "sk-test";
    fs.writeFileSync(
      authPath,
      JSON.stringify({
        anthropic: { type: "oauth", access: "a", refresh: "r", expires: 0 },
      }),
    );
    const result = await getPiAuthCredential({
      provider: "anthropic",
      authPath,
    });
    expect(result.status).toBe("none");
  });

  test("returns none for a non-oauth entry", async () => {
    fs.writeFileSync(
      authPath,
      JSON.stringify({ anthropic: { type: "api_key", key: "sk-test" } }),
    );
    const result = await getPiAuthCredential({
      provider: "anthropic",
      authPath,
    });
    expect(result.status).toBe("none");
  });

  test("returns none for an oauth entry missing fields", async () => {
    fs.writeFileSync(
      authPath,
      JSON.stringify({ anthropic: { type: "oauth", access: "a" } }),
    );
    const result = await getPiAuthCredential({
      provider: "anthropic",
      authPath,
    });
    expect(result.status).toBe("none");
  });

  test("returns none for a malformed auth file", async () => {
    fs.writeFileSync(authPath, "not json{{{");
    const result = await getPiAuthCredential({
      provider: "anthropic",
      authPath,
    });
    expect(result.status).toBe("none");
  });
});

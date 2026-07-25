import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getPiAuthCredential,
  parseOAuthTokenEnv,
} from "../src/storage/pi-auth.js";

describe("parseOAuthTokenEnv", () => {
  test("returns a bare token as-is", () => {
    expect(parseOAuthTokenEnv("sk-ant-oat01-abc")).toEqual({
      status: "token",
      token: "sk-ant-oat01-abc",
    });
  });

  test("trims surrounding whitespace from a bare token", () => {
    expect(parseOAuthTokenEnv("  sk-ant-oat01-abc\n")).toEqual({
      status: "token",
      token: "sk-ant-oat01-abc",
    });
  });

  test("extracts the access token from a credential blob", () => {
    const blob = JSON.stringify({
      access: "sk-ant-oat01-abc",
      refresh: "sk-ant-ort01-def",
      expires: 123,
    });
    expect(parseOAuthTokenEnv(blob)).toEqual({
      status: "blob",
      access: "sk-ant-oat01-abc",
    });
  });

  test("flags invalid JSON that looks like a blob as corrupt", () => {
    expect(parseOAuthTokenEnv('{"access": broken')).toEqual({
      status: "corrupt-blob",
    });
  });

  test("treats whitespace-only input as unset", () => {
    expect(parseOAuthTokenEnv("")).toEqual({ status: "empty" });
    expect(parseOAuthTokenEnv("  \n")).toEqual({ status: "empty" });
  });

  test("flags a blob without a usable access token as corrupt", () => {
    expect(parseOAuthTokenEnv('{"refresh":"r"}')).toEqual({
      status: "corrupt-blob",
    });
    expect(parseOAuthTokenEnv('{"access":""}')).toEqual({
      status: "corrupt-blob",
    });
  });
});

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

describe("getPiAuthCredential — concurrent refresh coalescing", () => {
  let dir: string;
  let authPath: string;
  const savedApiKey = process.env.MERCURY_ANTHROPIC_API_KEY;
  const savedOauth = process.env.MERCURY_ANTHROPIC_OAUTH_TOKEN;

  beforeEach(() => {
    // realpath: on macOS os.tmpdir() is /var/... while process.cwd() after a
    // chdir reports /private/var/..., which would make the relative-vs-absolute
    // coalescing test compare two genuinely different strings.
    dir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "pi-auth-coalesce-")),
    );
    authPath = path.join(dir, "auth.json");
    delete process.env.MERCURY_ANTHROPIC_API_KEY;
    delete process.env.MERCURY_ANTHROPIC_OAUTH_TOKEN;
    fs.writeFileSync(
      authPath,
      JSON.stringify({
        anthropic: { type: "oauth", access: "a", refresh: "r", expires: 0 },
      }),
    );
  });

  afterEach(() => {
    mock.restore();
    fs.rmSync(dir, { recursive: true, force: true });
    if (savedApiKey !== undefined)
      process.env.MERCURY_ANTHROPIC_API_KEY = savedApiKey;
    else delete process.env.MERCURY_ANTHROPIC_API_KEY;
    if (savedOauth !== undefined)
      process.env.MERCURY_ANTHROPIC_OAUTH_TOKEN = savedOauth;
    else delete process.env.MERCURY_ANTHROPIC_OAUTH_TOKEN;
  });

  test("two concurrent calls trigger one endpoint call and share the result", async () => {
    let calls = 0;
    mock.module("@earendil-works/pi-ai/oauth", () => ({
      getOAuthApiKey: async () => {
        calls++;
        // Delay so the second call overlaps the first's in-flight window.
        await new Promise((r) => setTimeout(r, 20));
        return {
          apiKey: "sk-fresh",
          newCredentials: { access: "a2", refresh: "r2", expires: 999 },
        };
      },
    }));
    // Re-import after mocking so the module binds the stubbed dependency.
    const { getPiAuthCredential: freshGet } = await import(
      "../src/storage/pi-auth.js"
    );

    const [a, b] = await Promise.all([
      freshGet({ provider: "anthropic", authPath }),
      freshGet({ provider: "anthropic", authPath }),
    ]);

    expect(calls).toBe(1);
    expect(a).toEqual({ status: "ok", apiKey: "sk-fresh" });
    expect(b).toEqual({ status: "ok", apiKey: "sk-fresh" });
  });

  test("a persist failure returns ok with the fresh key rather than refresh-failed", async () => {
    // The chain-breaking case: the refresh succeeded, so the old refresh token
    // is already consumed server-side. Failing the call here would throw away
    // the only usable key we hold; it must be returned, not reclassified as a
    // refresh failure.
    mock.module("@earendil-works/pi-ai/oauth", () => ({
      getOAuthApiKey: async () => ({
        apiKey: "sk-fresh",
        newCredentials: { access: "a2", refresh: "r2", expires: 999 },
      }),
    }));
    const { getPiAuthCredential: freshGet } = await import(
      "../src/storage/pi-auth.js"
    );

    // auth.json is readable, but the directory is made read-only so the atomic
    // temp-write + rename cannot complete.
    const realWrite = fs.writeFileSync;
    let writeAttempted = false;
    (fs as { writeFileSync: typeof fs.writeFileSync }).writeFileSync = ((
      target: fs.PathOrFileDescriptor,
      ...rest: unknown[]
    ) => {
      if (typeof target === "string" && target.includes(".tmp")) {
        writeAttempted = true;
        throw new Error("EACCES: simulated write failure");
      }
      return (realWrite as (...a: unknown[]) => void)(target, ...rest);
    }) as typeof fs.writeFileSync;

    try {
      const result = await freshGet({ provider: "anthropic", authPath });
      expect(writeAttempted).toBe(true);
      expect(result).toEqual({ status: "ok", apiKey: "sk-fresh" });
    } finally {
      (fs as { writeFileSync: typeof fs.writeFileSync }).writeFileSync =
        realWrite;
    }
  });

  test("relative and absolute spellings of one file coalesce", async () => {
    // The real-world shape: an extension passes an unresolved
    // `<globalDir>/auth.json` while the container runner passes the resolved
    // absolute path. Same file, two spellings — they must share one refresh.
    let calls = 0;
    mock.module("@earendil-works/pi-ai/oauth", () => ({
      getOAuthApiKey: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 20));
        return {
          apiKey: "sk-fresh",
          newCredentials: { access: "a2", refresh: "r2", expires: 999 },
        };
      },
    }));
    const { getPiAuthCredential: freshGet } = await import(
      "../src/storage/pi-auth.js"
    );

    const savedCwd = process.cwd();
    process.chdir(dir);
    try {
      const [a, b] = await Promise.all([
        freshGet({ provider: "anthropic", authPath: "auth.json" }),
        freshGet({ provider: "anthropic", authPath }),
      ]);

      expect(calls).toBe(1);
      expect(a).toEqual({ status: "ok", apiKey: "sk-fresh" });
      expect(b).toEqual({ status: "ok", apiKey: "sk-fresh" });
    } finally {
      process.chdir(savedCwd);
    }

    // Resolution must not have redirected the write: the rotated credential
    // still lands in the same file the relative spelling named.
    const persisted = JSON.parse(fs.readFileSync(authPath, "utf8"));
    expect(persisted.anthropic.refresh).toBe("r2");
  });

  test("a call after the window resolves refreshes again", async () => {
    let calls = 0;
    mock.module("@earendil-works/pi-ai/oauth", () => ({
      getOAuthApiKey: async () => {
        calls++;
        return {
          apiKey: `sk-${calls}`,
          newCredentials: { access: "a", refresh: "r", expires: 0 },
        };
      },
    }));
    const { getPiAuthCredential: freshGet } = await import(
      "../src/storage/pi-auth.js"
    );

    await freshGet({ provider: "anthropic", authPath });
    await freshGet({ provider: "anthropic", authPath });

    expect(calls).toBe(2);
  });
});

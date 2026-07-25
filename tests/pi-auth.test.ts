import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getPiAuthCredential,
  hasOAuthEntry,
  parseOAuthTokenEnv,
  providerCredentialEnvVar,
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

  test("returns none for a provider pi cannot refresh OAuth for", async () => {
    // openai is an API-key provider — no OAuth flow, so an entry under that key
    // is not ours to interpret and getOAuthApiKey would throw on the id.
    fs.writeFileSync(
      authPath,
      JSON.stringify({ openai: { type: "api_key", key: "sk-test" } }),
    );
    const result = await getPiAuthCredential({ provider: "openai", authPath });
    expect(result.status).toBe("none");
  });

  test("an anthropic env override does not suppress other providers", async () => {
    // The override names the anthropic credential to use; it says nothing about
    // github-copilot, whose entry must still be read from the file.
    process.env.MERCURY_ANTHROPIC_API_KEY = "sk-test";
    fs.writeFileSync(
      authPath,
      JSON.stringify({
        "github-copilot": {
          type: "oauth",
          access: "a",
          refresh: "r",
          expires: Date.now() + 60_000,
        },
      }),
    );
    const result = await getPiAuthCredential({
      provider: "github-copilot",
      authPath,
    });
    expect(result).toEqual({ status: "ok", apiKey: "a" });
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

describe("providerCredentialEnvVar", () => {
  test("names the env var pi reads each OAuth provider's credential from", () => {
    expect(providerCredentialEnvVar("anthropic")).toBe("ANTHROPIC_OAUTH_TOKEN");
    expect(providerCredentialEnvVar("github-copilot")).toBe(
      "COPILOT_GITHUB_TOKEN",
    );
  });

  test("openai-codex has none — its credential cannot reach the container", () => {
    // pi maps no env var to openai-codex, and auth.json is not mounted, so a
    // codex leg has no way to receive a token.
    expect(providerCredentialEnvVar("openai-codex")).toBeUndefined();
  });

  test("returns undefined for providers Mercury does not resolve", () => {
    expect(providerCredentialEnvVar("openai")).toBeUndefined();
  });
});

describe("hasOAuthEntry", () => {
  let dir: string;
  let authPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-auth-entry-"));
    authPath = path.join(dir, "auth.json");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("true only for an oauth entry under that provider", () => {
    fs.writeFileSync(
      authPath,
      JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: "a",
          refresh: "r",
          expires: 1,
        },
        openai: { type: "api_key", key: "sk" },
      }),
    );
    expect(hasOAuthEntry(authPath, "openai-codex")).toBe(true);
    expect(hasOAuthEntry(authPath, "openai")).toBe(false);
    expect(hasOAuthEntry(authPath, "anthropic")).toBe(false);
  });

  test("false when the file is missing", () => {
    expect(hasOAuthEntry(authPath, "anthropic")).toBe(false);
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
      getOAuthProvider: (id: string) => ({ id }),
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
      getOAuthProvider: (id: string) => ({ id }),
      getOAuthApiKey: async () => ({
        apiKey: "sk-fresh",
        newCredentials: { access: "a2", refresh: "r2", expires: 999 },
      }),
    }));
    const { getPiAuthCredential: freshGet } = await import(
      "../src/storage/pi-auth.js"
    );

    // auth.json stays readable; writes to the atomic temp file are made to
    // throw, so the write + rename cannot complete.
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
      getOAuthProvider: (id: string) => ({ id }),
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

  test("two providers in one file do not share a refresh promise", async () => {
    // Keyed on the file alone, the copilot caller would receive anthropic's
    // token — a cross-provider mixup, silent and total.
    fs.writeFileSync(
      authPath,
      JSON.stringify({
        anthropic: { type: "oauth", access: "a", refresh: "r", expires: 0 },
        "github-copilot": {
          type: "oauth",
          access: "c",
          refresh: "cr",
          expires: 0,
        },
      }),
    );
    const seen: string[] = [];
    mock.module("@earendil-works/pi-ai/oauth", () => ({
      getOAuthProvider: (id: string) => ({ id }),
      getOAuthApiKey: async (providerId: string) => {
        seen.push(providerId);
        await new Promise((r) => setTimeout(r, 20));
        return {
          apiKey: `sk-${providerId}`,
          newCredentials: { access: "a2", refresh: "r2", expires: 999 },
        };
      },
    }));
    const { getPiAuthCredential: freshGet } = await import(
      "../src/storage/pi-auth.js"
    );

    const [anthropic, copilot] = await Promise.all([
      freshGet({ provider: "anthropic", authPath }),
      freshGet({ provider: "github-copilot", authPath }),
    ]);

    expect(seen.sort()).toEqual(["anthropic", "github-copilot"]);
    expect(anthropic).toEqual({ status: "ok", apiKey: "sk-anthropic" });
    expect(copilot).toEqual({ status: "ok", apiKey: "sk-github-copilot" });

    // Both rotations survive: the second write re-reads the file instead of
    // merging into the snapshot it read before the first one landed.
    const persisted = JSON.parse(fs.readFileSync(authPath, "utf8"));
    expect(persisted.anthropic.refresh).toBe("r2");
    expect(persisted["github-copilot"].refresh).toBe("r2");
  });

  test("a call after the window resolves refreshes again", async () => {
    let calls = 0;
    mock.module("@earendil-works/pi-ai/oauth", () => ({
      getOAuthProvider: (id: string) => ({ id }),
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

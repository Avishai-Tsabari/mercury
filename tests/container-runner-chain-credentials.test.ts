import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentContainerRunner } from "../src/agent/container-runner.js";
import type { AppConfig, ModelLeg } from "../src/config.js";
import type { PiAuthCredential } from "../src/storage/pi-auth.js";

/**
 * auth.json stays on the host (it carries refresh tokens), so every OAuth
 * provider in the model chain has to be resolved here and handed to the
 * container as the env var pi reads it from. `injectChainOAuthCredentials` is
 * private — reached through a narrow cast, the same way the api-host test reads
 * `resolvedApiHost`.
 */
type EnvPair = { key: string; value: string };

function inject(
  config: Partial<AppConfig>,
  envPairs: EnvPair[],
  authPath: string,
  extraEnv?: Record<string, string>,
  resolveCredential?: (options: {
    provider: string;
    authPath: string;
  }) => Promise<PiAuthCredential>,
): Promise<void> {
  const runner = new AgentContainerRunner({
    agentContainerImage: "mercury-agent:latest",
    containerRuntime: "runc",
    ...config,
  } as AppConfig);
  return (
    runner as unknown as {
      injectChainOAuthCredentials(
        envPairs: EnvPair[],
        extraEnv: Record<string, string> | undefined,
        authPath: string,
        spaceId: string,
        resolveCredential?: (options: {
          provider: string;
          authPath: string;
        }) => Promise<PiAuthCredential>,
      ): Promise<void>;
    }
  ).injectChainOAuthCredentials(
    envPairs,
    extraEnv,
    authPath,
    "main",
    resolveCredential,
  );
}

function chain(...providers: string[]): ModelLeg[] {
  return providers.map((provider) => ({ provider, model: "some-model" }));
}

describe("injectChainOAuthCredentials", () => {
  let dir: string;
  let authPath: string;
  const savedApiKey = process.env.MERCURY_ANTHROPIC_API_KEY;
  const savedOauth = process.env.MERCURY_ANTHROPIC_OAUTH_TOKEN;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "chain-creds-"));
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

  /** An unexpired entry — resolvable without contacting the token endpoint. */
  function writeAuth(entries: Record<string, unknown>): void {
    fs.writeFileSync(authPath, JSON.stringify(entries));
  }

  function oauthEntry(access: string) {
    return {
      type: "oauth",
      access,
      refresh: "r",
      expires: Date.now() + 600_000,
    };
  }

  test("injects a non-anthropic chain leg's credential (the regression)", async () => {
    writeAuth({ "github-copilot": oauthEntry("gho-token") });
    const envPairs: EnvPair[] = [];

    await inject(
      { resolvedModelChain: chain("openai", "github-copilot") },
      envPairs,
      authPath,
    );

    expect(envPairs).toEqual([
      { key: "COPILOT_GITHUB_TOKEN", value: "gho-token" },
    ]);
  });

  test("resolves an anthropic fallback leg the primary-provider block skips", async () => {
    // modelProvider is openai, so the anthropic fail-fast never runs — the
    // anthropic leg still needs its credential.
    writeAuth({ anthropic: oauthEntry("sk-ant-oat01") });
    const envPairs: EnvPair[] = [];

    await inject(
      {
        modelProvider: "openai",
        resolvedModelChain: chain("openai", "anthropic"),
      },
      envPairs,
      authPath,
    );

    expect(envPairs).toEqual([
      { key: "ANTHROPIC_OAUTH_TOKEN", value: "sk-ant-oat01" },
    ]);
  });

  test("leaves a credential already carried by passthrough env alone", async () => {
    writeAuth({ "github-copilot": oauthEntry("from-file") });
    const envPairs: EnvPair[] = [
      { key: "COPILOT_GITHUB_TOKEN", value: "from-env" },
    ];

    await inject(
      { resolvedModelChain: chain("github-copilot") },
      envPairs,
      authPath,
    );

    expect(envPairs).toEqual([
      { key: "COPILOT_GITHUB_TOKEN", value: "from-env" },
    ]);
  });

  test("does not re-inject what extraEnv already provides", async () => {
    writeAuth({ "github-copilot": oauthEntry("from-file") });
    const envPairs: EnvPair[] = [];

    await inject(
      { resolvedModelChain: chain("github-copilot") },
      envPairs,
      authPath,
      { COPILOT_GITHUB_TOKEN: "from-extra" },
    );

    expect(envPairs).toEqual([]);
  });

  test("injects nothing for openai-codex — pi reads no env var for it", async () => {
    writeAuth({ "openai-codex": oauthEntry("codex-token") });
    const envPairs: EnvPair[] = [];

    await inject(
      { resolvedModelChain: chain("openai-codex") },
      envPairs,
      authPath,
    );

    expect(envPairs).toEqual([]);
  });

  test("injects nothing when the provider has no entry in auth.json", async () => {
    writeAuth({ anthropic: oauthEntry("sk-ant-oat01") });
    const envPairs: EnvPair[] = [];

    await inject(
      { resolvedModelChain: chain("github-copilot") },
      envPairs,
      authPath,
    );

    expect(envPairs).toEqual([]);
  });

  test("tolerates a missing auth file and an empty chain", async () => {
    const envPairs: EnvPair[] = [];

    await inject(
      { resolvedModelChain: chain("github-copilot") },
      envPairs,
      authPath,
    );
    await inject({ resolvedModelChain: [] }, envPairs, authPath);

    expect(envPairs).toEqual([]);
  });

  test("a failed refresh is logged, not thrown — later legs still get to run", async () => {
    // The whole point of a chain: one leg's dead credential must not take the
    // spawn down with it.
    writeAuth({ "github-copilot": oauthEntry("stale") });
    const envPairs: EnvPair[] = [];

    await inject(
      { resolvedModelChain: chain("github-copilot") },
      envPairs,
      authPath,
      undefined,
      async () => ({ status: "refresh-failed" as const }),
    );

    expect(envPairs).toEqual([]);
  });

  test("resolves each distinct provider once even when a leg repeats", async () => {
    writeAuth({ "github-copilot": oauthEntry("gho-token") });
    const envPairs: EnvPair[] = [];

    await inject(
      { resolvedModelChain: chain("github-copilot", "github-copilot") },
      envPairs,
      authPath,
    );

    expect(envPairs).toEqual([
      { key: "COPILOT_GITHUB_TOKEN", value: "gho-token" },
    ]);
  });
});

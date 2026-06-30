import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, resolveProjectPath } from "../src/config.js";

describe("loadConfig", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear all MERCURY_ env vars before each test to isolate from .env file
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("MERCURY_")) {
        delete process.env[key];
      }
    }
    // Skip auto-loading mercury.yaml from cwd (would make tests flaky)
    process.env.MERCURY_CONFIG_FILE = "";
  });

  afterEach(() => {
    // Restore original env after each test
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("MERCURY_")) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  test("defaults", () => {
    const config = loadConfig();
    expect(config.dataDir).toBe(".mercury");
    expect(config.triggerPatterns).toBe("@Mercury,Mercury");
    expect(config.triggerMatch).toBe("mention");
    expect(config.maxConcurrency).toBe(2);
    expect(config.port).toBe(8787);
    expect(config.containerTimeoutMs).toBe(5 * 60 * 1000);
    expect(config.logLevel).toBe("info");
    expect(config.logFormat).toBe("text");
    expect(config.resolvedModelChain).toEqual([
      { provider: "anthropic", model: "claude-opus-4-6" },
    ]);
    expect(config.modelMaxRetriesPerLeg).toBe(2);
    expect(config.modelChainBudgetMs).toBe(120_000);
    expect(config.effectiveModelChainBudgetMs).toBe(120_000);
    expect(config.parsedModelCapabilitiesEnv).toBeNull();
    expect(config.resolvedModelChainCapabilities).toHaveLength(1);
    expect(config.resolvedModelChainCapabilities[0]?.tools).toBe(true);
    expect(config.inboxTtlDays).toBe(7);
    expect(config.outboxTtlDays).toBe(3);
    expect(config.cleanupIntervalMs).toBe(3_600_000);
    expect(config.maxDiskMb).toBeUndefined();
  });

  test("derived paths use dataDir", () => {
    process.env.MERCURY_DATA_DIR = "/custom/data";
    const config = loadConfig();
    expect(path.normalize(config.dbPath)).toBe(
      path.normalize(path.join("/custom/data", "state.db")),
    );
    expect(path.normalize(config.globalDir)).toBe(
      path.normalize(path.join("/custom/data", "global")),
    );
    expect(path.normalize(config.spacesDir)).toBe(
      path.normalize(path.join("/custom/data", "spaces")),
    );
    expect(path.normalize(config.whatsappAuthDir)).toBe(
      path.normalize(path.join("/custom/data", "whatsapp-auth")),
    );
  });

  test("env overrides", () => {
    process.env.MERCURY_TRIGGER_PATTERNS = "@Bot,Bot";
    process.env.MERCURY_TRIGGER_MATCH = "prefix";
    process.env.MERCURY_MAX_CONCURRENCY = "4";
    process.env.MERCURY_CONTAINER_TIMEOUT_MS = "120000";
    process.env.MERCURY_LOG_LEVEL = "debug";
    process.env.MERCURY_LOG_FORMAT = "json";

    const config = loadConfig();
    expect(config.triggerPatterns).toBe("@Bot,Bot");
    expect(config.triggerMatch).toBe("prefix");
    expect(config.maxConcurrency).toBe(4);
    expect(config.containerTimeoutMs).toBe(120000);
    expect(config.logLevel).toBe("debug");
    expect(config.logFormat).toBe("json");
    expect(config.effectiveModelChainBudgetMs).toBe(110_000);
  });

  test("MERCURY_MODEL_CHAIN JSON overrides legacy primary", () => {
    process.env.MERCURY_MODEL_CHAIN = JSON.stringify([
      { provider: "openai", model: "gpt-4o-mini" },
      { provider: "anthropic", model: "claude-3-5-haiku-latest" },
    ]);

    const config = loadConfig();
    expect(config.resolvedModelChain).toEqual([
      { provider: "openai", model: "gpt-4o-mini" },
      { provider: "anthropic", model: "claude-3-5-haiku-latest" },
    ]);
    expect(config.resolvedModelChainCapabilities).toHaveLength(2);
    expect(config.resolvedModelChainCapabilities[0]?.tools).toBe(true);
    expect(config.resolvedModelChainCapabilities[1]?.tools).toBe(true);
  });

  test("MERCURY_MODEL_CAPABILITIES forces caps on all legs", () => {
    process.env.MERCURY_MODEL_CHAIN = JSON.stringify([
      { provider: "openai", model: "gpt-4o-mini" },
    ]);
    process.env.MERCURY_MODEL_CAPABILITIES = JSON.stringify({ tools: false });

    const config = loadConfig();
    expect(config.parsedModelCapabilitiesEnv?.tools).toBe(false);
    expect(config.resolvedModelChainCapabilities).toHaveLength(1);
    expect(config.resolvedModelChainCapabilities[0]?.tools).toBe(false);
  });

  test("legacy primary + optional fallback builds two-leg chain", () => {
    process.env.MERCURY_MODEL_PROVIDER = "anthropic";
    process.env.MERCURY_MODEL = "claude-sonnet-4-20250514";
    process.env.MERCURY_MODEL_FALLBACK_PROVIDER = "openai";
    process.env.MERCURY_MODEL_FALLBACK = "gpt-4o-mini";

    const config = loadConfig();
    expect(config.resolvedModelChain).toEqual([
      { provider: "anthropic", model: "claude-sonnet-4-20250514" },
      { provider: "openai", model: "gpt-4o-mini" },
    ]);
  });

  test("effectiveModelChainBudgetMs clamps to container timeout slack", () => {
    process.env.MERCURY_CONTAINER_TIMEOUT_MS = "60000";
    process.env.MERCURY_MODEL_CHAIN_BUDGET_MS = "300000";

    const config = loadConfig();
    expect(config.effectiveModelChainBudgetMs).toBe(50_000);
  });

  test("mercury.yaml supplies values when env keys unset", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mercury-cfg-"));
    try {
      const yamlPath = path.join(dir, "mercury.yaml");
      writeFileSync(
        yamlPath,
        `server:
  port: 3929
  bot_username: yamlbot
model:
  chain:
    - provider: openai
      model: gpt-4o-mini
`,
        "utf-8",
      );
      process.env.MERCURY_CONFIG_FILE = yamlPath;
      const config = loadConfig();
      expect(config.port).toBe(3929);
      expect(config.botUsername).toBe("yamlbot");
      expect(config.resolvedModelChain).toEqual([
        { provider: "openai", model: "gpt-4o-mini" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("env overrides mercury.yaml", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mercury-cfg-"));
    try {
      const yamlPath = path.join(dir, "mercury.yaml");
      writeFileSync(
        yamlPath,
        `server:
  port: 4000
`,
        "utf-8",
      );
      process.env.MERCURY_CONFIG_FILE = yamlPath;
      process.env.MERCURY_PORT = "5000";
      const config = loadConfig();
      expect(config.port).toBe(5000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("MERCURY_API_SECRET from env is applied with yaml present", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mercury-cfg-"));
    try {
      const yamlPath = path.join(dir, "mercury.yaml");
      writeFileSync(
        yamlPath,
        `server:
  port: 3001
`,
        "utf-8",
      );
      process.env.MERCURY_CONFIG_FILE = yamlPath;
      process.env.MERCURY_API_SECRET = "secret-from-env-only";
      const config = loadConfig();
      expect(config.port).toBe(3001);
      expect(config.apiSecret).toBe("secret-from-env-only");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("invalid mercury.yaml throws with path in message", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mercury-cfg-"));
    try {
      const yamlPath = path.join(dir, "mercury.yaml");
      writeFileSync(
        yamlPath,
        `server:
  port: not-a-number
`,
        "utf-8",
      );
      process.env.MERCURY_CONFIG_FILE = yamlPath;
      expect(() => loadConfig()).toThrow(yamlPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("invalid model chain in mercury.yaml throws", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mercury-cfg-"));
    try {
      const yamlPath = path.join(dir, "mercury.yaml");
      writeFileSync(
        yamlPath,
        `model:
  chain:
    - provider: ""
      model: x
`,
        "utf-8",
      );
      process.env.MERCURY_CONFIG_FILE = yamlPath;
      expect(() => loadConfig()).toThrow(/mercury.yaml/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveProjectPath", () => {
  test("absolute path returns as-is", () => {
    expect(resolveProjectPath("/absolute/path")).toBe("/absolute/path");
  });

  test("relative path resolves against cwd", () => {
    const result = resolveProjectPath(".mercury/state.db");
    expect(result).toBe(path.join(process.cwd(), ".mercury/state.db"));
  });
});

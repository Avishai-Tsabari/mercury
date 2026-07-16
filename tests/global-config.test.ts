import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppConfig } from "../src/config.js";
import { mergeRawMercuryConfig } from "../src/config-file.js";
import {
  ConfigRegistry,
  GLOBAL_CONFIG_SPACE_ID,
} from "../src/extensions/config-registry.js";
import {
  createMercuryExtensionContext,
  resolveExtensionConfig,
} from "../src/extensions/context.js";
import type { Logger } from "../src/logger.js";
import { Db } from "../src/storage/db.js";

const log = {
  level: "info" as const,
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child() {
    return this;
  },
} as unknown as Logger;

let tmpDir: string;
let db: Db;
let registry: ConfigRegistry;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-globalcfg-"));
  db = new Db(path.join(tmpDir, "state.db"));
  registry = new ConfigRegistry();
  registry.register("voice-transcribe", "provider", {
    description: "STT provider",
    default: "local",
  });
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeConfig(defaults?: Record<string, string>): AppConfig {
  return { parsedExtensionDefaults: defaults ?? {} } as AppConfig;
}

describe("resolveExtensionConfig — resolution chain", () => {
  const KEY = "voice-transcribe.provider";
  const SPACE = "telegram:123";

  it("falls back to the registered code default when nothing is set", () => {
    const value = resolveExtensionConfig({
      db,
      config: makeConfig(),
      configRegistry: registry,
      spaceId: SPACE,
      key: KEY,
    });
    expect(value).toBe("local");
  });

  it("mercury.yaml extensions defaults beat the code default", () => {
    const value = resolveExtensionConfig({
      db,
      config: makeConfig({ [KEY]: "openai" }),
      configRegistry: registry,
      spaceId: SPACE,
      key: KEY,
    });
    expect(value).toBe("openai");
  });

  it("@global DB value beats yaml defaults", () => {
    db.setSpaceConfig(GLOBAL_CONFIG_SPACE_ID, KEY, "gemini", "test");
    const value = resolveExtensionConfig({
      db,
      config: makeConfig({ [KEY]: "openai" }),
      configRegistry: registry,
      spaceId: SPACE,
      key: KEY,
    });
    expect(value).toBe("gemini");
  });

  it("per-space value beats everything", () => {
    db.setSpaceConfig(GLOBAL_CONFIG_SPACE_ID, KEY, "gemini", "test");
    db.setSpaceConfig(SPACE, KEY, "api", "test");
    const value = resolveExtensionConfig({
      db,
      config: makeConfig({ [KEY]: "openai" }),
      configRegistry: registry,
      spaceId: SPACE,
      key: KEY,
    });
    expect(value).toBe("api");
  });

  it("returns null for unregistered keys with no value anywhere", () => {
    const value = resolveExtensionConfig({
      db,
      config: makeConfig(),
      configRegistry: registry,
      spaceId: SPACE,
      key: "nonexistent.key",
    });
    expect(value).toBeNull();
  });

  it("works without a config registry (no code-default fallback)", () => {
    db.setSpaceConfig(GLOBAL_CONFIG_SPACE_ID, KEY, "gemini", "test");
    const value = resolveExtensionConfig({
      db,
      config: makeConfig(),
      spaceId: SPACE,
      key: KEY,
    });
    expect(value).toBe("gemini");
  });

  it("tolerates a partial AppConfig without parsedExtensionDefaults", () => {
    const value = resolveExtensionConfig({
      db,
      config: {} as AppConfig,
      configRegistry: registry,
      spaceId: SPACE,
      key: KEY,
    });
    expect(value).toBe("local");
  });
});

describe("ctx.getConfig", () => {
  it("is exposed on the extension context and resolves the chain", () => {
    const KEY = "voice-transcribe.provider";
    db.setSpaceConfig(GLOBAL_CONFIG_SPACE_ID, KEY, "openai", "test");
    const ctx = createMercuryExtensionContext({
      db,
      config: makeConfig(),
      log,
      configRegistry: registry,
    });
    expect(ctx.getConfig("telegram:42", KEY)).toBe("openai");
    db.setSpaceConfig("telegram:42", KEY, "local", "test");
    expect(ctx.getConfig("telegram:42", KEY)).toBe("local");
  });
});

describe("mercury.env hostOnly", () => {
  it("keeps the hostOnly flag in meta and still claims the source var", async () => {
    const { MercuryExtensionAPIImpl } = await import(
      "../src/extensions/api.js"
    );
    const api = new MercuryExtensionAPIImpl("stt-test", tmpDir, db);
    api.env({ from: "MERCURY_STT_API_KEY", hostOnly: true });
    api.env({ from: "MERCURY_GH_TOKEN" });
    const meta = api.getMeta();
    expect(meta.envVars).toEqual([
      { from: "MERCURY_STT_API_KEY", hostOnly: true },
      { from: "MERCURY_GH_TOKEN" },
    ]);
  });
});

describe("mercury.yaml extensions: section", () => {
  it("flattens extension defaults into extensionDefaults JSON", () => {
    const yamlPath = path.join(tmpDir, "mercury.yaml");
    fs.writeFileSync(
      yamlPath,
      [
        "extensions:",
        "  voice-transcribe:",
        "    provider: openai",
        "    language: he",
        "    max_retries: 3",
      ].join("\n"),
    );
    const raw = mergeRawMercuryConfig(
      { MERCURY_CONFIG_FILE: yamlPath } as NodeJS.ProcessEnv,
      tmpDir,
    );
    expect(raw.extensionDefaults).toBeDefined();
    const parsed = JSON.parse(raw.extensionDefaults as string);
    expect(parsed["voice-transcribe.provider"]).toBe("openai");
    expect(parsed["voice-transcribe.language"]).toBe("he");
    expect(parsed["voice-transcribe.max_retries"]).toBe("3");
  });

  it("MERCURY_EXTENSION_DEFAULTS env wins over the yaml section", () => {
    const yamlPath = path.join(tmpDir, "mercury.yaml");
    fs.writeFileSync(
      yamlPath,
      ["extensions:", "  voice-transcribe:", "    provider: openai"].join("\n"),
    );
    const raw = mergeRawMercuryConfig(
      {
        MERCURY_CONFIG_FILE: yamlPath,
        MERCURY_EXTENSION_DEFAULTS: '{"voice-transcribe.provider":"gemini"}',
      } as NodeJS.ProcessEnv,
      tmpDir,
    );
    const parsed = JSON.parse(raw.extensionDefaults as string);
    expect(parsed["voice-transcribe.provider"]).toBe("gemini");
  });
});

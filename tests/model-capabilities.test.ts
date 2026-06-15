import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  chainSupportsRequirements,
  DEFAULT_CAPABILITIES,
  loadUserModelCapabilitiesMap,
  parseModelCapabilitiesEnv,
  resolveModelCapabilitiesWithSource,
  resolveModelChainCapabilities,
} from "../src/agent/model-capabilities.js";

describe("parseModelCapabilitiesEnv", () => {
  test("returns null when empty", () => {
    expect(parseModelCapabilitiesEnv(undefined)).toBeNull();
    expect(parseModelCapabilitiesEnv("")).toBeNull();
  });

  test("merges partial JSON with defaults", () => {
    const c = parseModelCapabilitiesEnv('{"tools": false}');
    expect(c).not.toBeNull();
    expect(c?.tools).toBe(false);
    expect(c?.vision).toBe(DEFAULT_CAPABILITIES.vision);
  });
});

describe("resolveModelCapabilitiesWithSource", () => {
  test("env wins over builtin", () => {
    const env = parseModelCapabilitiesEnv('{"tools": false, "vision": true}');
    const r = resolveModelCapabilitiesWithSource(
      "claude-opus-4-6",
      "anthropic",
      null,
      env,
    );
    expect(r.source).toBe("env");
    expect(r.capabilities.tools).toBe(false);
    expect(r.capabilities.vision).toBe(true);
  });

  test("pi lookup: gpt-4o-mini has vision", () => {
    const r = resolveModelCapabilitiesWithSource(
      "gpt-4o-mini",
      "openai",
      null,
      null,
    );
    expect(r.source).toBe("builtin");
    expect(r.capabilities.vision).toBe(true);
  });

  test("pi lookup: llama-3.1-8b-instant has tools (pi has no tools field, defaults true)", () => {
    const r = resolveModelCapabilitiesWithSource(
      "llama-3.1-8b-instant",
      "groq",
      null,
      null,
    );
    expect(r.source).toBe("builtin");
    expect(r.capabilities.tools).toBe(true);
  });

  test("YAML exact match overrides builtin when env unset", () => {
    const map = new Map([
      [
        "claude-opus-4-6",
        { ...DEFAULT_CAPABILITIES, tools: false, vision: false },
      ],
    ]);
    const r = resolveModelCapabilitiesWithSource(
      "claude-opus-4-6",
      "anthropic",
      map,
      null,
    );
    expect(r.source).toBe("yaml");
    expect(r.capabilities.tools).toBe(false);
  });

  test("unknown model uses default", () => {
    const r = resolveModelCapabilitiesWithSource(
      "totally-unknown-model",
      "unknown-provider",
      null,
      null,
    );
    expect(r.source).toBe("default");
    expect(r.capabilities.tools).toBe(DEFAULT_CAPABILITIES.tools);
  });
});

describe("loadUserModelCapabilitiesMap", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-mc-yaml-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("loads models from yaml file", () => {
    fs.writeFileSync(
      path.join(dir, "model-capabilities.yaml"),
      `models:
  my-custom:
    tools: false
    vision: true
`,
      "utf8",
    );
    const map = loadUserModelCapabilitiesMap(dir);
    expect(map?.get("my-custom")?.tools).toBe(false);
    expect(map?.get("my-custom")?.vision).toBe(true);
  });

  test("returns null when file missing", () => {
    expect(loadUserModelCapabilitiesMap(dir)).toBeNull();
  });
});

describe("resolveModelChainCapabilities", () => {
  test("returns one entry per leg", () => {
    const chain = [
      { provider: "groq", model: "llama-3.1-8b-instant" },
      { provider: "openai", model: "gpt-4o" },
    ];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-mc-ch-"));
    try {
      const { chainCaps } = resolveModelChainCapabilities(chain, dir, null);
      expect(chainCaps).toHaveLength(2);
      // pi has no tools field — defaults to true for all known models
      expect(chainCaps[0]?.tools).toBe(true);
      expect(chainCaps[1]?.tools).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("chainSupportsRequirements", () => {
  test("true when any leg satisfies all keys", () => {
    expect(
      chainSupportsRequirements(
        ["tools"],
        [
          { ...DEFAULT_CAPABILITIES, tools: false },
          { ...DEFAULT_CAPABILITIES, tools: true },
        ],
      ),
    ).toBe(true);
  });

  test("false when no leg satisfies", () => {
    expect(
      chainSupportsRequirements(
        ["tools", "vision"],
        [{ ...DEFAULT_CAPABILITIES, tools: true, vision: false }],
      ),
    ).toBe(false);
  });
});

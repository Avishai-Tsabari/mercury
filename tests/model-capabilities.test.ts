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
      "claude-opus-4-8",
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
        "claude-opus-4-8",
        { ...DEFAULT_CAPABILITIES, tools: false, vision: false },
      ],
    ]);
    const r = resolveModelCapabilitiesWithSource(
      "claude-opus-4-8",
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

  test("marks unknown model ids as source=default so guesses stay labelled", () => {
    const chain = [
      { provider: "anthropic", model: "claude-does-not-exist-9" },
      { provider: "anthropic", model: "claude-haiku-4-5" },
    ];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-mc-src-"));
    try {
      const { chainCaps } = resolveModelChainCapabilities(chain, dir, null);
      // Unknown id: capabilities are a guess, and must say so — the container
      // suppresses "vision NOT available" claims when source is "default".
      expect(chainCaps[0]?.source).toBe("default");
      expect(chainCaps[0]?.vision).toBe(false);
      // Known id: looked up, so the flags are assertable facts.
      expect(chainCaps[1]?.source).toBe("builtin");
      expect(chainCaps[1]?.vision).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("yaml override reports source=yaml", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-mc-yml-"));
    try {
      fs.writeFileSync(
        path.join(dir, "model-capabilities.yaml"),
        "models:\n  some-new-model:\n    vision: true\n",
      );
      const { chainCaps } = resolveModelChainCapabilities(
        [{ provider: "anthropic", model: "some-new-model" }],
        dir,
        null,
      );
      expect(chainCaps[0]?.source).toBe("yaml");
      expect(chainCaps[0]?.vision).toBe(true);
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

  test("a resolved vision:false really does exclude", () => {
    expect(
      chainSupportsRequirements(
        ["vision"],
        [{ ...DEFAULT_CAPABILITIES, vision: false, source: "builtin" }],
      ),
    ).toBe(false);
  });

  test("an unresolved model id is permissive, not exclusionary", () => {
    // Regression: a model absent from pi's registry resolves to
    // vision:false/source:"default". Treating that guess as fact silently
    // dropped capability-gated extensions and skills at startup.
    expect(
      chainSupportsRequirements(
        ["vision"],
        [{ ...DEFAULT_CAPABILITIES, vision: false, source: "default" }],
      ),
    ).toBe(true);
  });

  test("one unresolved leg is enough for the chain to qualify", () => {
    expect(
      chainSupportsRequirements(
        ["vision", "audio_input"],
        [
          { ...DEFAULT_CAPABILITIES, vision: false, source: "builtin" },
          { ...DEFAULT_CAPABILITIES, source: "default" },
        ],
      ),
    ).toBe(true);
  });
});

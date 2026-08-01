import { describe, expect, test } from "bun:test";
import { buildCapabilitySection } from "../src/agent/container-entry.js";
import {
  type CapabilitySource,
  DEFAULT_CAPABILITIES,
} from "../src/agent/model-capabilities-core.js";

const SOURCES: Array<CapabilitySource | undefined> = [
  "env",
  "yaml",
  "builtin",
  "default",
  undefined,
];

describe("buildCapabilitySection", () => {
  test("never narrates vision, whatever the flag or its source says", () => {
    // pi's read tool reports non-vision models at read time, keyed to the model
    // it is actually calling. Mercury restating it up front can only add a
    // claim it may have guessed — which is what told Opus 5 it was blind.
    for (const source of SOURCES) {
      for (const vision of [true, false]) {
        const section = buildCapabilitySection({
          ...DEFAULT_CAPABILITIES,
          vision,
          source,
        });
        expect(section).not.toContain("vision");
        expect(section).not.toContain("image");
      }
    }
  });

  test("never narrates audio — a lookup can never make these true", () => {
    for (const source of SOURCES) {
      const section = buildCapabilitySection({
        ...DEFAULT_CAPABILITIES,
        source,
      });
      expect(section).not.toContain("audio");
      expect(section).not.toContain("Voice attachments");
    }
  });

  test("always states tools, which operator config can genuinely turn off", () => {
    const section = buildCapabilitySection({
      ...DEFAULT_CAPABILITIES,
      tools: true,
    });
    expect(section).toContain("**tools (bash / read / write / edit):**");
    expect(section).toContain("available");
    expect(section).not.toContain("Toolless mode");
  });

  test("explains toolless mode when tools are disabled", () => {
    const section = buildCapabilitySection({
      ...DEFAULT_CAPABILITIES,
      tools: false,
    });
    expect(section).toContain("NOT available");
    expect(section).toContain("Toolless mode");
  });

  test("stays a single well-formed section", () => {
    const section = buildCapabilitySection({
      ...DEFAULT_CAPABILITIES,
      source: "builtin",
    });
    expect(section.startsWith("## Current model capabilities")).toBe(true);
    // Header + intro + exactly one capability bullet.
    expect(section.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(
      1,
    );
  });
});

import { describe, expect, test } from "bun:test";
import {
  buildMercuryAdditions,
  type Payload,
} from "../src/agent/container-entry.js";
import { DEFAULT_CAPABILITIES } from "../src/agent/model-capabilities-core.js";

// Safety invariants must be present in every rendered system prompt regardless
// of which AGENTS.md profile is deployed — they are code, not config. These
// tests lock that property in against future refactors dropping a section.
const INVARIANT_HEADINGS = [
  "## Destructive Operations — Confirmation Required",
  "## Presenting tool results",
  "## Character",
  "## Permissions & Security",
  "## Moderation",
];

const payload: Payload = {
  spaceId: "space1",
  spaceWorkspace: "/workspace/space1",
  messages: [],
  prompt: "hello",
};

describe("buildMercuryAdditions safety invariants", () => {
  test("append mode (skipIdentity=false) contains all invariant sections", () => {
    const out = buildMercuryAdditions(DEFAULT_CAPABILITIES, payload);
    for (const heading of INVARIANT_HEADINGS) {
      expect(out).toContain(heading);
    }
    expect(out).toContain("You are Claude Code");
  });

  test("override mode (skipIdentity=true) contains all invariant sections", () => {
    const out = buildMercuryAdditions(DEFAULT_CAPABILITIES, payload, {
      skipIdentity: true,
    });
    for (const heading of INVARIANT_HEADINGS) {
      expect(out).toContain(heading);
    }
    expect(out).not.toContain("You are Claude Code");
  });

  test("invariants survive toolless capabilities", () => {
    const out = buildMercuryAdditions(
      { ...DEFAULT_CAPABILITIES, tools: false },
      payload,
    );
    for (const heading of INVARIANT_HEADINGS) {
      expect(out).toContain(heading);
    }
  });
});

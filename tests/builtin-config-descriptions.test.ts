import { describe, expect, test } from "bun:test";
import {
  BUILTIN_CONFIG_DESCRIPTIONS,
  BUILTIN_CONFIG_KEYS,
} from "../src/core/routes/config-builtin.js";

describe("BUILTIN_CONFIG_DESCRIPTIONS", () => {
  test("covers exactly the BUILTIN_CONFIG_KEYS set", () => {
    const descriptionKeys = Object.keys(BUILTIN_CONFIG_DESCRIPTIONS).sort();
    const builtinKeys = [...BUILTIN_CONFIG_KEYS].sort();
    expect(descriptionKeys).toEqual(builtinKeys);
  });

  test("every description is a non-empty single-line string", () => {
    for (const [key, desc] of Object.entries(BUILTIN_CONFIG_DESCRIPTIONS)) {
      expect(desc.length, `description for ${key} is empty`).toBeGreaterThan(0);
      expect(
        desc.includes("\n"),
        `description for ${key} contains newline`,
      ).toBe(false);
    }
  });
});

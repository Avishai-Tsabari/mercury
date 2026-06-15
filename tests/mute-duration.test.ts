import { describe, expect, test } from "bun:test";
import { parseMuteDuration } from "../src/core/mute-duration.js";

describe("parseMuteDuration", () => {
  test("parses minutes and hours", () => {
    expect(parseMuteDuration("10m")).toBe(10 * 60 * 1000);
    expect(parseMuteDuration("1h")).toBe(60 * 60 * 1000);
    expect(parseMuteDuration("24h")).toBe(24 * 60 * 60 * 1000);
  });

  test("parses days and alternate suffixes", () => {
    expect(parseMuteDuration("7d")).toBe(7 * 24 * 60 * 60 * 1000);
    expect(parseMuteDuration("1day")).toBe(24 * 60 * 60 * 1000);
    expect(parseMuteDuration("5min")).toBe(5 * 60 * 1000);
  });

  test("returns null for invalid input", () => {
    expect(parseMuteDuration("")).toBeNull();
    expect(parseMuteDuration("xyz")).toBeNull();
    expect(parseMuteDuration("1w")).toBeNull();
  });
});

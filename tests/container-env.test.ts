import { describe, expect, test } from "bun:test";
import {
  BLOCKED_ENV_VARS,
  listUnclaimedPassthroughVars,
  selectPassthroughEnv,
} from "../src/agent/container-env.js";

const env = {
  MERCURY_GEMINI_API_KEY: "gem",
  MERCURY_CLALIT_PASSWORD: "pw",
  MERCURY_GH_TOKEN: "gh",
  MERCURY_API_SECRET: "secret",
  MERCURY_TELEGRAM_BOT_TOKEN: "tg",
  MERCURY_UNSET: undefined,
  PATH: "/usr/bin",
} as NodeJS.ProcessEnv;

const claimed = new Set(["MERCURY_GH_TOKEN"]);

describe("listUnclaimedPassthroughVars", () => {
  test("lists MERCURY_* vars that are neither blocked nor claimed", () => {
    expect(listUnclaimedPassthroughVars(env, claimed)).toEqual([
      "MERCURY_CLALIT_PASSWORD",
      "MERCURY_GEMINI_API_KEY",
    ]);
  });

  test("excludes non-MERCURY vars and unset values", () => {
    const result = listUnclaimedPassthroughVars(env, claimed);
    expect(result).not.toContain("PATH");
    expect(result).not.toContain("MERCURY_UNSET");
  });

  test("treats an absent claimed set as nothing claimed", () => {
    expect(listUnclaimedPassthroughVars(env, undefined)).toContain(
      "MERCURY_GH_TOKEN",
    );
  });

  test("never lists a blocked var", () => {
    const all = listUnclaimedPassthroughVars(
      Object.fromEntries([...BLOCKED_ENV_VARS].map((k) => [k, "x"])),
      undefined,
    );
    expect(all).toEqual([]);
  });
});

describe("selectPassthroughEnv", () => {
  test("mode 'all' strips the MERCURY_ prefix", () => {
    expect(selectPassthroughEnv(env, claimed, "all")).toEqual([
      { key: "CLALIT_PASSWORD", value: "pw" },
      { key: "GEMINI_API_KEY", value: "gem" },
    ]);
  });

  test("mode 'all' still excludes blocked and claimed vars", () => {
    const keys = selectPassthroughEnv(env, claimed, "all").map((p) => p.key);
    expect(keys).not.toContain("API_SECRET");
    expect(keys).not.toContain("TELEGRAM_BOT_TOKEN");
    expect(keys).not.toContain("GH_TOKEN");
  });

  test("mode 'claimed' passes nothing blindly", () => {
    expect(selectPassthroughEnv(env, claimed, "claimed")).toEqual([]);
  });

  test("mode 'claimed' withholds undeclared secrets even with no extensions", () => {
    expect(selectPassthroughEnv(env, undefined, "claimed")).toEqual([]);
  });
});

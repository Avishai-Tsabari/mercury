import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  BLOCKED_ENV_VARS,
  listUnclaimedPassthroughVars,
  listUnexpectedPassthroughVars,
  MODEL_PROVIDER_ENV_VARS,
  selectPassthroughEnv,
} from "../src/agent/container-env.js";

const env = {
  MERCURY_GEMINI_API_KEY: "gem",
  MERCURY_BILLING_API_KEY: "pw",
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
      "MERCURY_BILLING_API_KEY",
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
      { key: "BILLING_API_KEY", value: "pw" },
      { key: "GEMINI_API_KEY", value: "gem" },
    ]);
  });

  test("mode 'all' still excludes blocked and claimed vars", () => {
    const keys = selectPassthroughEnv(env, claimed, "all").map((p) => p.key);
    expect(keys).not.toContain("API_SECRET");
    expect(keys).not.toContain("TELEGRAM_BOT_TOKEN");
    expect(keys).not.toContain("GH_TOKEN");
  });

  test("mode 'claimed' withholds undeclared secrets", () => {
    const keys = selectPassthroughEnv(env, claimed, "claimed").map(
      (p) => p.key,
    );
    expect(keys).not.toContain("BILLING_API_KEY");
  });

  test("mode 'claimed' still passes model-provider credentials", () => {
    // Without this the agent cannot reach any model: no extension declares
    // provider keys, so "claimed" would leave pi with no credential at all.
    expect(selectPassthroughEnv(env, claimed, "claimed")).toEqual([
      { key: "GEMINI_API_KEY", value: "gem" },
    ]);
  });

  test("mode 'claimed' passes the console OAuth blob through", () => {
    const consoleEnv = {
      MERCURY_ANTHROPIC_OAUTH_TOKEN: '{"access":"a"}',
    } as NodeJS.ProcessEnv;
    expect(selectPassthroughEnv(consoleEnv, undefined, "claimed")).toEqual([
      { key: "ANTHROPIC_OAUTH_TOKEN", value: '{"access":"a"}' },
    ]);
  });

  test("mode 'claimed' still honours the blocklist", () => {
    const blockedProvider = {
      MERCURY_TELEGRAM_BOT_TOKEN: "tg",
    } as NodeJS.ProcessEnv;
    expect(selectPassthroughEnv(blockedProvider, undefined, "claimed")).toEqual(
      [],
    );
  });
});

describe("listUnexpectedPassthroughVars", () => {
  test("omits model-provider keys so a real outlier stands out", () => {
    expect(listUnexpectedPassthroughVars(env, claimed)).toEqual([
      "MERCURY_BILLING_API_KEY",
    ]);
  });

  test("is empty when only provider keys are undeclared", () => {
    const providersOnly = {
      MERCURY_GEMINI_API_KEY: "g",
      MERCURY_GROQ_API_KEY: "q",
    } as NodeJS.ProcessEnv;
    expect(listUnexpectedPassthroughVars(providersOnly, undefined)).toEqual([]);
  });
});

describe("MODEL_PROVIDER_ENV_VARS", () => {
  test("covers every provider env var the dashboard offers", () => {
    // Drift guard: adding a provider to the dashboard without listing it here
    // would silently break that provider under env_passthrough=claimed.
    const dashboard = fs.readFileSync(
      path.join(import.meta.dir, "../src/core/routes/dashboard.ts"),
      "utf8",
    );
    const declared = [
      ...dashboard.matchAll(/envVar:\s*"(MERCURY_[A-Z_0-9]+)"/g),
    ].map((m) => m[1]);

    expect(declared.length).toBeGreaterThan(0);
    const missing = declared.filter((v) => !MODEL_PROVIDER_ENV_VARS.has(v));
    expect(missing).toEqual([]);
  });

  test("no provider var is also blocked", () => {
    const both = [...MODEL_PROVIDER_ENV_VARS].filter((v) =>
      BLOCKED_ENV_VARS.has(v),
    );
    expect(both).toEqual([]);
  });
});

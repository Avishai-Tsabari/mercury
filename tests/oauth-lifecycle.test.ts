import { describe, expect, test } from "bun:test";
import {
  type OAuthSpawnDeps,
  resolveOAuthCredentialForSpawn,
} from "../src/agent/container-runner.js";

// ─── Integration test: Anthropic OAuth credential lifecycle at container spawn ─
//
// resolveOAuthCredentialForSpawn is the single chokepoint for the three
// container-side lifecycle steps (step 3 — restart — runs console-side):
//   1. refresh the access token when near expiry
//   2. write the refreshed blob back to the console DB
//   4. on invalid_grant, pull the current blob from the console DB
//
// The module-level refresh cooldown means every test that triggers a refresh
// must advance the injected clock past the 60s cooldown window. `nextClock()`
// jumps 10 minutes per call so successive tests never share a cooldown window.

let clock = 100_000_000;
function nextClock(): number {
  clock += 600_000;
  return clock;
}

const CONSOLE = {
  consoleUrl: "https://console.test",
  consoleInternalSecret: "internal-secret",
  agentId: "agent-123",
};

function freshCreds() {
  return { access: "acc-old", refresh: "ref-old", expires: clock + 3_600_000 };
}
function nearExpiryCreds() {
  return { access: "acc-old", refresh: "ref-old", expires: clock + 30_000 };
}

/** Build a deps object with sensible spies; override per test. */
function makeDeps(over: Partial<OAuthSpawnDeps> = {}): OAuthSpawnDeps {
  const now = nextClock();
  return {
    now: () => now,
    refresh: async () => ({
      access: "acc-refreshed",
      refresh: "ref-refreshed",
      expires: now + 3_600_000,
    }),
    pushToConsole: async () => {},
    fetchFromConsole: async () => null,
    ...over,
  };
}

describe("resolveOAuthCredentialForSpawn", () => {
  test("step 1 — refreshes when the token is within the 60s expiry window", async () => {
    let refreshCalled = false;
    const deps = makeDeps({
      refresh: async (creds) => {
        refreshCalled = true;
        expect(creds.refresh).toBe("ref-old");
        return {
          access: "acc-refreshed",
          refresh: "ref-refreshed",
          expires: clock + 3_600_000,
        };
      },
    });
    const result = await resolveOAuthCredentialForSpawn(
      nearExpiryCreds(),
      CONSOLE,
      deps,
    );
    expect(refreshCalled).toBe(true);
    expect(result.access).toBe("acc-refreshed");
  });

  test("does not refresh when the token is still fresh", async () => {
    let refreshCalled = false;
    const deps = makeDeps({
      refresh: async () => {
        refreshCalled = true;
        return { access: "x", refresh: "y", expires: 0 };
      },
    });
    const result = await resolveOAuthCredentialForSpawn(
      freshCreds(),
      CONSOLE,
      deps,
    );
    expect(refreshCalled).toBe(false);
    expect(result.access).toBe("acc-old");
    expect(result.updatedBlob).toBeNull();
  });

  test("step 2 — writes the refreshed blob back to the console DB", async () => {
    let pushedCreds: {
      access: string;
      refresh: string;
      expires: number;
    } | null = null;
    const deps = makeDeps({
      pushToConsole: async (url, secret, agentId, creds) => {
        expect(url).toBe(CONSOLE.consoleUrl);
        expect(secret).toBe(CONSOLE.consoleInternalSecret);
        expect(agentId).toBe(CONSOLE.agentId);
        pushedCreds = creds;
      },
    });
    await resolveOAuthCredentialForSpawn(nearExpiryCreds(), CONSOLE, deps);
    expect(pushedCreds).not.toBeNull();
    expect(pushedCreds?.access).toBe("acc-refreshed");
    expect(pushedCreds?.refresh).toBe("ref-refreshed");
  });

  test("the resolved blob is a full {access,refresh,expires} JSON object — never a bare string", async () => {
    const deps = makeDeps();
    const result = await resolveOAuthCredentialForSpawn(
      nearExpiryCreds(),
      CONSOLE,
      deps,
    );
    expect(result.updatedBlob).not.toBeNull();
    const parsed = JSON.parse(result.updatedBlob ?? "") as Record<
      string,
      unknown
    >;
    expect(typeof parsed.access).toBe("string");
    expect(typeof parsed.refresh).toBe("string");
    expect(typeof parsed.expires).toBe("number");
  });

  test("skips write-back (with a warning) when the console internal secret is not configured", async () => {
    let pushCalled = false;
    const deps = makeDeps({
      pushToConsole: async () => {
        pushCalled = true;
      },
    });
    const result = await resolveOAuthCredentialForSpawn(
      nearExpiryCreds(),
      {
        consoleUrl: CONSOLE.consoleUrl,
        consoleInternalSecret: undefined,
        agentId: CONSOLE.agentId,
      },
      deps,
    );
    expect(pushCalled).toBe(false);
    expect(result.access).toBe("acc-refreshed");
  });

  test("step 4 — on invalid_grant, pulls fresh creds from the console DB and uses them", async () => {
    let fetchCalled = false;
    const deps = makeDeps({
      refresh: async () => {
        throw new Error("Anthropic OAuth refresh failed (400): invalid_grant");
      },
      fetchFromConsole: async (_url, _secret, agentId) => {
        fetchCalled = true;
        expect(agentId).toBe(CONSOLE.agentId);
        return {
          access: "acc-from-console",
          refresh: "ref-NEW",
          expires: clock + 3_600_000,
        };
      },
    });
    const result = await resolveOAuthCredentialForSpawn(
      nearExpiryCreds(),
      CONSOLE,
      deps,
    );
    expect(fetchCalled).toBe(true);
    expect(result.access).toBe("acc-from-console");
    const parsed = JSON.parse(result.updatedBlob ?? "") as { refresh: string };
    expect(parsed.refresh).toBe("ref-NEW");
  });

  test("invalid_grant with the same refresh token still in the console throws a reconnect error", async () => {
    const deps = makeDeps({
      refresh: async () => {
        throw new Error("invalid_grant");
      },
      // Console holds the SAME refresh token — user has not reconnected.
      fetchFromConsole: async () => ({
        access: "acc-old",
        refresh: "ref-old",
        expires: clock,
      }),
    });
    await expect(
      resolveOAuthCredentialForSpawn(nearExpiryCreds(), CONSOLE, deps),
    ).rejects.toThrow(/invalid_grant/);
  });

  test("invalid_grant with an unreachable console throws (cannot confirm reconnect)", async () => {
    const deps = makeDeps({
      refresh: async () => {
        throw new Error("invalid_grant");
      },
      fetchFromConsole: async () => null,
    });
    await expect(
      resolveOAuthCredentialForSpawn(nearExpiryCreds(), CONSOLE, deps),
    ).rejects.toThrow(/could not be fetched/);
  });

  test("transient refresh failure falls back to the current access token (never throws)", async () => {
    const deps = makeDeps({
      refresh: async () => {
        throw new Error("network timeout");
      },
    });
    const result = await resolveOAuthCredentialForSpawn(
      nearExpiryCreds(),
      CONSOLE,
      deps,
    );
    expect(result.access).toBe("acc-old");
    expect(result.updatedBlob).toBeNull();
  });
});

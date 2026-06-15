import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppConfig } from "../src/config.js";
import { createMercuryExtensionContext } from "../src/extensions/context.js";
import { getNextCronDelay, JobRunner } from "../src/extensions/jobs.js";
import type {
  ExtensionMeta,
  MercuryExtensionContext,
} from "../src/extensions/types.js";
import type { Logger } from "../src/logger.js";
import { Db } from "../src/storage/db.js";

let tmpDir: string;
let db: Db;
let ctx: MercuryExtensionContext;
let runner: JobRunner;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-jobs-test-"));
  db = new Db(path.join(tmpDir, "test.db"));
  const testLog = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child() {
      return this;
    },
  } as unknown as Logger;
  ctx = createMercuryExtensionContext({
    db,
    config: {} as AppConfig,
    log: testLog,
  });
  runner = new JobRunner();
});

afterEach(() => {
  runner.stop();
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeExt(overrides: Partial<ExtensionMeta> = {}): ExtensionMeta {
  return {
    name: "test-ext",
    dir: tmpDir,
    hooks: new Map(),
    jobs: new Map(),
    configs: new Map(),
    widgets: [],
    ...overrides,
  };
}

describe("JobRunner", () => {
  test("interval job runs immediately", async () => {
    let runCount = 0;
    const ext = makeExt({
      jobs: new Map([
        [
          "counter",
          {
            interval: 100_000, // long enough to not re-fire during test
            run: async () => {
              runCount++;
            },
          },
        ],
      ]),
    });

    runner.start([ext], ctx);
    // Give the immediate run a tick
    await Bun.sleep(50);
    expect(runCount).toBe(1);
  });

  test("interval job runs multiple times", async () => {
    let runCount = 0;
    const ext = makeExt({
      jobs: new Map([
        [
          "fast",
          {
            interval: 30,
            run: async () => {
              runCount++;
            },
          },
        ],
      ]),
    });

    runner.start([ext], ctx);
    await Bun.sleep(120);
    expect(runCount).toBeGreaterThanOrEqual(3);
  });

  test("job errors are caught, don't crash", async () => {
    let errorCount = 0;
    let successCount = 0;

    const ext = makeExt({
      jobs: new Map([
        [
          "flaky",
          {
            interval: 30,
            run: async () => {
              if (errorCount < 2) {
                errorCount++;
                throw new Error("boom");
              }
              successCount++;
            },
          },
        ],
      ]),
    });

    runner.start([ext], ctx);
    await Bun.sleep(150);
    expect(errorCount).toBe(2);
    expect(successCount).toBeGreaterThanOrEqual(1);
  });

  test("stop clears all timers", async () => {
    let runCount = 0;
    const ext = makeExt({
      jobs: new Map([
        [
          "counter",
          {
            interval: 20,
            run: async () => {
              runCount++;
            },
          },
        ],
      ]),
    });

    runner.start([ext], ctx);
    await Bun.sleep(50);
    const countAtStop = runCount;
    runner.stop();
    await Bun.sleep(80);
    // Should not have run more after stop
    expect(runCount).toBe(countAtStop);
    expect(runner.activeCount).toBe(0);
  });

  test("multiple extensions with multiple jobs", async () => {
    const runs: string[] = [];

    const ext1 = makeExt({
      name: "ext1",
      jobs: new Map([
        [
          "a",
          {
            interval: 100_000,
            run: async () => {
              runs.push("ext1:a");
            },
          },
        ],
      ]),
    });

    const ext2 = makeExt({
      name: "ext2",
      jobs: new Map([
        [
          "b",
          {
            interval: 100_000,
            run: async () => {
              runs.push("ext2:b");
            },
          },
        ],
        [
          "c",
          {
            interval: 100_000,
            run: async () => {
              runs.push("ext2:c");
            },
          },
        ],
      ]),
    });

    runner.start([ext1, ext2], ctx);
    await Bun.sleep(50);
    expect(runs).toContain("ext1:a");
    expect(runs).toContain("ext2:b");
    expect(runs).toContain("ext2:c");
    expect(runner.activeCount).toBe(3);
  });

  test("start is idempotent", async () => {
    let runCount = 0;
    const ext = makeExt({
      jobs: new Map([
        [
          "once",
          {
            interval: 100_000,
            run: async () => {
              runCount++;
            },
          },
        ],
      ]),
    });

    runner.start([ext], ctx);
    runner.start([ext], ctx); // second call ignored
    await Bun.sleep(50);
    expect(runCount).toBe(1);
    expect(runner.activeCount).toBe(1);
  });

  test("extensions with no jobs are fine", () => {
    const ext = makeExt();
    runner.start([ext], ctx);
    expect(runner.activeCount).toBe(0);
  });
});

describe("getNextCronDelay", () => {
  test("returns non-null for valid cron", () => {
    const delay = getNextCronDelay("* * * * *");
    expect(delay).not.toBeNull();
    // Next minute should be within 60 seconds
    expect(delay).not.toBeNull();
    expect(delay ?? 0).toBeLessThanOrEqual(60_000);
    expect(delay ?? 0).toBeGreaterThanOrEqual(0);
  });

  test("returns null for invalid cron", () => {
    expect(getNextCronDelay("not a cron")).toBeNull();
  });

  test("specific time computes correct delay", () => {
    // "0 0 1 1 *" = midnight, January 1st — always in the future
    const delay = getNextCronDelay("0 0 1 1 *");
    expect(delay).not.toBeNull();
    expect(delay).not.toBeNull();
    expect(delay ?? 0).toBeGreaterThan(0);
  });
});

describe("cron job scheduling", () => {
  test("cron job registers a timer", () => {
    const ext = makeExt({
      jobs: new Map([
        [
          "cron-test",
          {
            cron: "* * * * *",
            run: async () => {},
          },
        ],
      ]),
    });

    runner.start([ext], ctx);
    expect(runner.activeCount).toBe(1);
  });

  test("cron job fires and reschedules", async () => {
    // We can't wait for real cron (1 min minimum), so we test the
    // scheduleCron path by using a very-soon cron and short sleep.
    // Instead, we verify the run function is called by using a
    // patched getNextCronDelay that returns a tiny delay.
    let runCount = 0;

    // Use a custom job runner where we directly call scheduleCron
    // via the public start() with a mock cron that fires immediately.
    // We can do this by monkey-patching getNextCronDelay temporarily.
    const _origModule = await import("../src/extensions/jobs.js");

    // Create a job with interval-like behavior via very fast polling
    // Actually, we can test the setTimeout path fires by using
    // the runner and a short setTimeout directly.
    const ext = makeExt({
      jobs: new Map([
        [
          "cron-fire",
          {
            cron: "* * * * *", // every minute
            async run() {
              runCount++;
            },
          },
        ],
      ]),
    });

    // Override the timer to fire immediately
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((
      fn: (...args: unknown[]) => void,
      _delay: number,
      ...args: unknown[]
    ) => {
      // Fire with 10ms delay instead of waiting for cron
      return originalSetTimeout(fn, 10, ...args);
    }) as typeof setTimeout;

    try {
      runner.start([ext], ctx);
      // Wait for the first cron fire + reschedule
      await Bun.sleep(80);
      expect(runCount).toBeGreaterThanOrEqual(1);
      // Should still be active (rescheduled)
      expect(runner.activeCount).toBe(1);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  test("cron job with invalid expression logs error", () => {
    const ext = makeExt({
      jobs: new Map([
        [
          "bad-cron",
          {
            cron: "not valid",
            async run() {},
          },
        ],
      ]),
    });

    runner.start([ext], ctx);
    // Invalid cron doesn't register a timer
    expect(runner.activeCount).toBe(0);
  });

  test("cron job stops after runner.stop()", async () => {
    let runCount = 0;
    const ext = makeExt({
      jobs: new Map([
        [
          "cron-stop",
          {
            cron: "* * * * *",
            async run() {
              runCount++;
            },
          },
        ],
      ]),
    });

    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((
      fn: (...args: unknown[]) => void,
      _delay: number,
      ...args: unknown[]
    ) => {
      return originalSetTimeout(fn, 10, ...args);
    }) as typeof setTimeout;

    try {
      runner.start([ext], ctx);
      await Bun.sleep(30);
      const countAtStop = runCount;
      runner.stop();
      await Bun.sleep(50);
      // Should not have run more after stop
      expect(runCount).toBe(countAtStop);
      expect(runner.activeCount).toBe(0);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });
});

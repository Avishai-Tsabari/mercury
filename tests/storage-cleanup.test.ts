import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppConfig } from "../src/config.js";
import { runStorageCleanup } from "../src/core/storage-cleanup.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-cleanup-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeConfig(overrides?: Partial<AppConfig>): AppConfig {
  return {
    spacesDir: path.join(tmpDir, "spaces"),
    inboxTtlDays: 7,
    outboxTtlDays: 3,
    ...overrides,
  } as AppConfig;
}

function mockLog() {
  const calls: { level: string; msg: string; data?: unknown }[] = [];
  return {
    log: {
      info: (msg: string, data?: unknown) =>
        calls.push({ level: "info", msg, data }),
      warn: (msg: string, data?: unknown) =>
        calls.push({ level: "warn", msg, data }),
      error: (msg: string, data?: unknown) =>
        calls.push({ level: "error", msg, data }),
    },
    calls,
  };
}

function mockDb() {
  const clearCalls: string[] = [];
  return {
    db: {
      clearSpaceAttachments: (spaceId: string) => {
        clearCalls.push(spaceId);
        return 5;
      },
    },
    clearCalls,
  };
}

function writeFileWithAge(filePath: string, ageDays: number, content = "x") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  const mtime = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
  fs.utimesSync(filePath, mtime, mtime);
}

describe("runStorageCleanup", () => {
  test("deletes expired inbox files and keeps fresh ones", async () => {
    const config = makeConfig();
    const spacesDir = config.spacesDir;
    const inboxDir = path.join(spacesDir, "space1", "inbox");

    writeFileWithAge(path.join(inboxDir, "old.jpg"), 10);
    writeFileWithAge(path.join(inboxDir, "fresh.jpg"), 1);

    const { db } = mockDb();
    const { log } = mockLog();

    const result = await runStorageCleanup({
      config,
      db: db as never,
      log: log as never,
      isSpaceActive: () => false,
    });

    expect(result.filesDeleted).toBe(1);
    expect(fs.existsSync(path.join(inboxDir, "old.jpg"))).toBe(false);
    expect(fs.existsSync(path.join(inboxDir, "fresh.jpg"))).toBe(true);
  });

  test("deletes expired outbox files with outbox TTL", async () => {
    const config = makeConfig();
    const outboxDir = path.join(config.spacesDir, "space1", "outbox");

    writeFileWithAge(path.join(outboxDir, "old.txt"), 5);
    writeFileWithAge(path.join(outboxDir, "fresh.txt"), 1);

    const { db } = mockDb();
    const { log } = mockLog();

    const result = await runStorageCleanup({
      config,
      db: db as never,
      log: log as never,
      isSpaceActive: () => false,
    });

    expect(result.filesDeleted).toBe(1);
    expect(fs.existsSync(path.join(outboxDir, "old.txt"))).toBe(false);
    expect(fs.existsSync(path.join(outboxDir, "fresh.txt"))).toBe(true);
  });

  test("skips active spaces", async () => {
    const config = makeConfig();
    const inboxDir = path.join(config.spacesDir, "active-space", "inbox");

    writeFileWithAge(path.join(inboxDir, "old.jpg"), 10);

    const { db } = mockDb();
    const { log } = mockLog();

    const result = await runStorageCleanup({
      config,
      db: db as never,
      log: log as never,
      isSpaceActive: (id) => id === "active-space",
    });

    expect(result.spacesSkipped).toBe(1);
    expect(result.filesDeleted).toBe(0);
    expect(fs.existsSync(path.join(inboxDir, "old.jpg"))).toBe(true);
  });

  test("calls clearSpaceAttachments when inbox files are deleted", async () => {
    const config = makeConfig();
    const inboxDir = path.join(config.spacesDir, "space1", "inbox");

    writeFileWithAge(path.join(inboxDir, "old.jpg"), 10);

    const { db, clearCalls } = mockDb();
    const { log } = mockLog();

    await runStorageCleanup({
      config,
      db: db as never,
      log: log as never,
      isSpaceActive: () => false,
    });

    expect(clearCalls).toEqual(["space1"]);
  });

  test("does not call clearSpaceAttachments when only outbox files are deleted", async () => {
    const config = makeConfig();
    const outboxDir = path.join(config.spacesDir, "space1", "outbox");

    writeFileWithAge(path.join(outboxDir, "old.txt"), 5);

    const { db, clearCalls } = mockDb();
    const { log } = mockLog();

    await runStorageCleanup({
      config,
      db: db as never,
      log: log as never,
      isSpaceActive: () => false,
    });

    expect(clearCalls).toEqual([]);
  });

  test("returns zero results when spacesDir does not exist", async () => {
    const config = makeConfig({ spacesDir: path.join(tmpDir, "nonexistent") });
    const { db } = mockDb();
    const { log } = mockLog();

    const result = await runStorageCleanup({
      config,
      db: db as never,
      log: log as never,
      isSpaceActive: () => false,
    });

    expect(result.spacesScanned).toBe(0);
    expect(result.filesDeleted).toBe(0);
  });

  test("skips dotfiles", async () => {
    const config = makeConfig();
    const inboxDir = path.join(config.spacesDir, "space1", "inbox");

    writeFileWithAge(path.join(inboxDir, ".hidden"), 10);

    const { db } = mockDb();
    const { log } = mockLog();

    const result = await runStorageCleanup({
      config,
      db: db as never,
      log: log as never,
      isSpaceActive: () => false,
    });

    expect(result.filesDeleted).toBe(0);
    expect(fs.existsSync(path.join(inboxDir, ".hidden"))).toBe(true);
  });

  test("tracks bytes freed correctly", async () => {
    const config = makeConfig();
    const inboxDir = path.join(config.spacesDir, "space1", "inbox");
    const content = "a".repeat(1024);

    writeFileWithAge(path.join(inboxDir, "big.jpg"), 10, content);

    const { db } = mockDb();
    const { log } = mockLog();

    const result = await runStorageCleanup({
      config,
      db: db as never,
      log: log as never,
      isSpaceActive: () => false,
    });

    expect(result.bytesFreed).toBe(1024);
  });

  test("scans multiple spaces", async () => {
    const config = makeConfig();

    writeFileWithAge(path.join(config.spacesDir, "s1", "inbox", "old.jpg"), 10);
    writeFileWithAge(path.join(config.spacesDir, "s2", "outbox", "old.txt"), 5);

    const { db } = mockDb();
    const { log } = mockLog();

    const result = await runStorageCleanup({
      config,
      db: db as never,
      log: log as never,
      isSpaceActive: () => false,
    });

    expect(result.spacesScanned).toBe(2);
    expect(result.filesDeleted).toBe(2);
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "../src/storage/db.js";

describe("project_config (character storage)", () => {
  let tempDir: string;
  let db: Db;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-character-"));
    db = new Db(path.join(tempDir, "state.db"));
  });

  afterEach(async () => {
    db.close();
    for (let i = 0; i < 5; i++) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100 * (i + 1)));
      }
    }
  });

  test("get returns null when unset", () => {
    expect(db.getProjectConfig("character")).toBeNull();
  });

  test("set then get round-trip", () => {
    db.setProjectConfig("character", "Be formal", "admin:123");
    expect(db.getProjectConfig("character")).toBe("Be formal");
  });

  test("set overwrites previous value", () => {
    db.setProjectConfig("character", "Be formal", "admin:123");
    db.setProjectConfig("character", "Be casual", "admin:456");
    expect(db.getProjectConfig("character")).toBe("Be casual");
  });

  test("updatedBy tracks who set the value", () => {
    db.setProjectConfig("character", "Be formal", "admin:123");
    expect(db.getProjectConfigUpdatedBy("character")).toBe("admin:123");
    db.setProjectConfig("character", "Be casual", "admin:456");
    expect(db.getProjectConfigUpdatedBy("character")).toBe("admin:456");
  });

  test("delete removes the value", () => {
    db.setProjectConfig("character", "Be formal", "admin:123");
    const deleted = db.deleteProjectConfig("character");
    expect(deleted).toBe(true);
    expect(db.getProjectConfig("character")).toBeNull();
  });

  test("delete returns false when nothing to delete", () => {
    expect(db.deleteProjectConfig("character")).toBe(false);
  });

  test("different keys are independent", () => {
    db.setProjectConfig("character", "Be formal", "admin:123");
    db.setProjectConfig("other_key", "some value", "admin:123");
    expect(db.getProjectConfig("character")).toBe("Be formal");
    expect(db.getProjectConfig("other_key")).toBe("some value");
  });
});

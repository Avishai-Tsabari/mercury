import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getRolePermissions,
  registerPermission,
  resetPermissions,
  setActiveProfileMemberPermissions,
} from "../src/core/permissions.js";
import {
  getActiveProfileSystemPrompt,
  loadActiveProfile,
  loadProfileFromDir,
  persistActiveProfile,
  setActiveProfileSystemPrompt,
  validateProfileCapabilities,
} from "../src/core/profiles.js";
import { Db } from "../src/storage/db.js";

let tmpDir: string;

function writeProfile(yaml: string): string {
  const dir = fs.mkdtempSync(path.join(tmpDir, "profile-"));
  fs.writeFileSync(path.join(dir, "mercury-profile.yaml"), yaml);
  return dir;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-profile-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("applicative profile schema", () => {
  test("parses capabilities, member_permissions, and multiline system_prompt", () => {
    const dir = writeProfile(`name: barber-appointments
description: Appointment booking for a barber shop
version: 0.1.0
capabilities:
  - gws
member_permissions:
  - prompt
  - prefs.get
  - barber
system_prompt: |
  You are a barber shop assistant.
  Help each customer with only their own appointments.
`);
    const profile = loadProfileFromDir(dir);
    expect(profile.name).toBe("barber-appointments");
    expect(profile.capabilities).toEqual(["gws"]);
    expect(profile.member_permissions).toEqual([
      "prompt",
      "prefs.get",
      "barber",
    ]);
    expect(profile.system_prompt).toContain("barber shop assistant");
    expect(profile.system_prompt).toContain("only their own appointments");
  });

  test("defaults capabilities to [] and leaves optional fields undefined", () => {
    const dir = writeProfile(`name: minimal
version: 0.1.0
`);
    const profile = loadProfileFromDir(dir);
    expect(profile.capabilities).toEqual([]);
    expect(profile.member_permissions).toBeUndefined();
    expect(profile.system_prompt).toBeUndefined();
  });

  test("rejects an invalid profile name", () => {
    const dir = writeProfile(`name: "Not Valid"
version: 0.1.0
`);
    expect(() => loadProfileFromDir(dir)).toThrow();
  });
});

describe("validateProfileCapabilities", () => {
  test("passes when every capability is an installed extension", () => {
    const dataDir = path.join(tmpDir, "data");
    fs.mkdirSync(path.join(dataDir, "extensions", "gws"), { recursive: true });
    const profile = loadProfileFromDir(
      writeProfile("name: p\nversion: 0.1.0\ncapabilities:\n  - gws\n"),
    );
    expect(() => validateProfileCapabilities(profile, dataDir)).not.toThrow();
  });

  test("throws listing the missing capabilities", () => {
    const dataDir = path.join(tmpDir, "data");
    fs.mkdirSync(path.join(dataDir, "extensions"), { recursive: true });
    const profile = loadProfileFromDir(
      writeProfile("name: p\nversion: 0.1.0\ncapabilities:\n  - gws\n"),
    );
    expect(() => validateProfileCapabilities(profile, dataDir)).toThrow(/gws/);
  });

  test("no-ops when the profile declares no capabilities", () => {
    const dataDir = path.join(tmpDir, "data");
    const profile = loadProfileFromDir(
      writeProfile("name: p\nversion: 0.1.0\n"),
    );
    expect(() => validateProfileCapabilities(profile, dataDir)).not.toThrow();
  });
});

describe("active profile persistence", () => {
  test("persist then load round-trips activation", () => {
    const dataDir = path.join(tmpDir, "data");
    const profile = loadProfileFromDir(
      writeProfile(`name: barber-appointments
version: 0.1.0
member_permissions:
  - prompt
  - barber
system_prompt: |
  Persona line.
`),
    );
    persistActiveProfile(profile, dataDir);
    const loaded = loadActiveProfile(dataDir);
    expect(loaded?.name).toBe("barber-appointments");
    expect(loaded?.memberPermissions).toEqual(["prompt", "barber"]);
    expect(loaded?.systemPrompt).toContain("Persona line.");
  });

  test("loadActiveProfile returns null when no profile applied", () => {
    expect(loadActiveProfile(path.join(tmpDir, "empty"))).toBeNull();
  });

  test("system prompt holder set/get/clear round-trips", () => {
    setActiveProfileSystemPrompt("You are a barber assistant.");
    expect(getActiveProfileSystemPrompt()).toBe("You are a barber assistant.");
    setActiveProfileSystemPrompt(null);
    expect(getActiveProfileSystemPrompt()).toBeNull();
  });
});

describe("profile-aware permission resolution", () => {
  let db: Db;

  beforeEach(() => {
    resetPermissions();
    db = new Db(path.join(tmpDir, `perms-${Math.random()}.db`));
    // Make "barber" a recognized permission so it isn't filtered out.
    registerPermission("barber", { defaultRoles: [] });
  });

  afterEach(() => {
    db.close();
    resetPermissions();
  });

  test("an active profile is the exhaustive member set (replaces defaults)", () => {
    setActiveProfileMemberPermissions(["prompt", "barber"]);
    const perms = getRolePermissions(db, "main", "member");
    expect(perms.has("prompt")).toBe(true);
    expect(perms.has("barber")).toBe(true);
    // prefs.get is a built-in member default — the profile set must REPLACE it.
    expect(perms.has("prefs.get")).toBe(false);
  });

  test("raw capability stays out of the member set unless listed", () => {
    registerPermission("gws", { defaultRoles: [] });
    setActiveProfileMemberPermissions(["prompt", "barber"]);
    const perms = getRolePermissions(db, "main", "member");
    expect(perms.has("gws")).toBe(false);
  });

  test("admin is unaffected by the active profile", () => {
    setActiveProfileMemberPermissions(["prompt"]);
    const perms = getRolePermissions(db, "main", "admin");
    expect(perms.has("barber")).toBe(true);
    expect(perms.has("permissions.set")).toBe(true);
  });

  test("an explicit per-space override wins over the profile", () => {
    setActiveProfileMemberPermissions(["prompt", "barber"]);
    db.setSpaceConfig("main", "role.member.permissions", "prompt");
    const perms = getRolePermissions(db, "main", "member");
    expect(perms.has("prompt")).toBe(true);
    expect(perms.has("barber")).toBe(false);
  });

  test("clearing the active profile restores built-in member defaults", () => {
    setActiveProfileMemberPermissions(["prompt"]);
    setActiveProfileMemberPermissions(null);
    const perms = getRolePermissions(db, "main", "member");
    expect(perms.has("prefs.get")).toBe(true);
  });
});

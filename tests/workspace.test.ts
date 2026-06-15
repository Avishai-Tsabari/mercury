import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ensurePiResourceDir,
  ensureSpaceWorkspace,
  removeSpaceWorkspace,
} from "../src/storage/memory.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("ensurePiResourceDir", () => {
  test("creates directory with .pi subdirs and empty AGENTS.md", () => {
    const dir = path.join(tmpDir, "global");
    ensurePiResourceDir(dir);

    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.existsSync(path.join(dir, ".pi"))).toBe(true);
    expect(fs.existsSync(path.join(dir, ".pi/extensions"))).toBe(true);
    expect(fs.existsSync(path.join(dir, ".pi/skills"))).toBe(true);
    expect(fs.existsSync(path.join(dir, ".pi/prompts"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "AGENTS.md"))).toBe(true);
    expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8")).toBe("");
  });

  test("does not overwrite existing AGENTS.md", () => {
    const dir = path.join(tmpDir, "global");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "custom content");

    ensurePiResourceDir(dir);

    expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8")).toBe(
      "custom content",
    );
  });

  test("is idempotent", () => {
    const dir = path.join(tmpDir, "global");
    ensurePiResourceDir(dir);
    ensurePiResourceDir(dir);

    expect(fs.existsSync(path.join(dir, "AGENTS.md"))).toBe(true);
    expect(fs.existsSync(path.join(dir, ".pi/extensions"))).toBe(true);
  });
});

describe("ensureSpaceWorkspace", () => {
  test("creates space workspace using the slug directly", () => {
    const spacesDir = path.join(tmpDir, "spaces");
    fs.mkdirSync(spacesDir, { recursive: true });

    const dir = ensureSpaceWorkspace(spacesDir, "main");

    expect(dir).toBe(path.join(spacesDir, "main"));
    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.existsSync(path.join(dir, "AGENTS.md"))).toBe(true);
    expect(fs.existsSync(path.join(dir, ".pi/extensions"))).toBe(true);
    expect(fs.existsSync(path.join(dir, ".pi/skills"))).toBe(true);
    expect(fs.existsSync(path.join(dir, ".pi/prompts"))).toBe(true);
  });

  test("preserves the provided space slug", () => {
    const spacesDir = path.join(tmpDir, "spaces");
    fs.mkdirSync(spacesDir, { recursive: true });

    const dir = ensureSpaceWorkspace(spacesDir, "work-project");
    expect(path.basename(dir)).toBe("work-project");
  });

  test("preserves safe characters", () => {
    const spacesDir = path.join(tmpDir, "spaces");
    fs.mkdirSync(spacesDir, { recursive: true });

    const dir = ensureSpaceWorkspace(spacesDir, "main");
    expect(path.basename(dir)).toBe("main");
  });

  test("does not overwrite existing space workspace", () => {
    const spacesDir = path.join(tmpDir, "spaces");
    fs.mkdirSync(spacesDir, { recursive: true });

    const dir = ensureSpaceWorkspace(spacesDir, "test-group");
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "space instructions");

    const dir2 = ensureSpaceWorkspace(spacesDir, "test-group");
    expect(dir2).toBe(dir);
    expect(fs.readFileSync(path.join(dir2, "AGENTS.md"), "utf8")).toBe(
      "space instructions",
    );
  });
});

describe("full workspace structure", () => {
  test("scaffolds global + spaces + main correctly", () => {
    const dataDir = path.join(tmpDir, ".mercury");
    const globalDir = path.join(dataDir, "global");
    const spacesDir = path.join(dataDir, "spaces");

    ensurePiResourceDir(globalDir);
    ensureSpaceWorkspace(spacesDir, "main");

    // Global
    expect(fs.existsSync(path.join(globalDir, "AGENTS.md"))).toBe(true);
    expect(fs.existsSync(path.join(globalDir, ".pi/extensions"))).toBe(true);
    expect(fs.existsSync(path.join(globalDir, ".pi/skills"))).toBe(true);

    // Main
    expect(fs.existsSync(path.join(spacesDir, "main/AGENTS.md"))).toBe(true);
    expect(fs.existsSync(path.join(spacesDir, "main/.pi/extensions"))).toBe(
      true,
    );

    // Spaces root has no AGENTS.md (not scaffolded)
    expect(fs.existsSync(path.join(spacesDir, "AGENTS.md"))).toBe(false);
  });

  test("removeSpaceWorkspace deletes a space directory", () => {
    const spacesDir = path.join(tmpDir, "spaces");
    ensureSpaceWorkspace(spacesDir, "doomed");
    expect(fs.existsSync(path.join(spacesDir, "doomed"))).toBe(true);

    removeSpaceWorkspace(spacesDir, "doomed");
    expect(fs.existsSync(path.join(spacesDir, "doomed"))).toBe(false);
  });

  test("removeSpaceWorkspace is a no-op for missing paths", () => {
    const spacesDir = path.join(tmpDir, "spaces");
    // Should not throw
    removeSpaceWorkspace(spacesDir, "nonexistent");
  });

  test("adding a new space creates its workspace", () => {
    const spacesDir = path.join(tmpDir, "spaces");

    const dir = ensureSpaceWorkspace(spacesDir, "new-chat");

    expect(fs.existsSync(path.join(dir, "AGENTS.md"))).toBe(true);
    expect(fs.existsSync(path.join(dir, ".pi/extensions"))).toBe(true);
    expect(fs.existsSync(path.join(dir, ".pi/skills"))).toBe(true);
    expect(fs.existsSync(path.join(dir, ".pi/prompts"))).toBe(true);
  });
});

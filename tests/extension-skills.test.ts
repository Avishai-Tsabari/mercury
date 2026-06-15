import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CAPABILITIES } from "../src/agent/model-capabilities.js";
import {
  installBuiltinSkills,
  installExtensionSkills,
} from "../src/extensions/skills.js";
import type { ExtensionMeta } from "../src/extensions/types.js";

let tmpDir: string;
let globalDir: string;

const log = {
  level: "info" as const,
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child() {
    return this;
  },
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-skills-"));
  globalDir = path.join(tmpDir, "global");
  fs.mkdirSync(globalDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeSkillDir(name: string): string {
  const dir = path.join(tmpDir, "ext", name, "skill");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: Test skill for ${name}\n---\n\n# ${name}\n`,
  );
  return dir;
}

function makeMeta(
  name: string,
  skillDir?: string,
  requires?: ExtensionMeta["requires"],
): ExtensionMeta {
  return {
    name,
    dir: path.join(tmpDir, "ext", name),
    clis: [],
    skillDir,
    requires,
    hooks: new Map(),
    jobs: new Map(),
    configs: new Map(),
    widgets: [],
    envVars: [],
  };
}

describe("installExtensionSkills", () => {
  it("copies skill directory to global dir", () => {
    const skillDir = makeSkillDir("napkin");
    installExtensionSkills([makeMeta("napkin", skillDir)], globalDir, log);

    const dst = path.join(globalDir, "skills", "napkin", "SKILL.md");
    expect(fs.existsSync(dst)).toBe(true);
    expect(fs.readFileSync(dst, "utf-8")).toContain("name: napkin");
  });

  it("copies nested files (scripts, references)", () => {
    const skillDir = makeSkillDir("napkin");
    fs.mkdirSync(path.join(skillDir, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(skillDir, "scripts", "search.js"), "// search");
    fs.mkdirSync(path.join(skillDir, "references"), { recursive: true });
    fs.writeFileSync(path.join(skillDir, "references", "api.md"), "# API");

    installExtensionSkills([makeMeta("napkin", skillDir)], globalDir, log);

    expect(
      fs.existsSync(
        path.join(globalDir, "skills", "napkin", "scripts", "search.js"),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(globalDir, "skills", "napkin", "references", "api.md"),
      ),
    ).toBe(true);
  });

  it("skips extensions without skillDir", () => {
    installExtensionSkills([makeMeta("no-skill", undefined)], globalDir, log);
    expect(fs.existsSync(path.join(globalDir, "skills", "no-skill"))).toBe(
      false,
    );
  });

  it("handles multiple extensions", () => {
    const s1 = makeSkillDir("ext-a");
    const s2 = makeSkillDir("ext-b");
    installExtensionSkills(
      [makeMeta("ext-a", s1), makeMeta("ext-b", s2)],
      globalDir,
      log,
    );

    expect(
      fs.existsSync(path.join(globalDir, "skills", "ext-a", "SKILL.md")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(globalDir, "skills", "ext-b", "SKILL.md")),
    ).toBe(true);
  });

  it("removes stale skill directories", () => {
    // Simulate a previously installed skill
    const staleDir = path.join(globalDir, "skills", "removed-ext");
    fs.mkdirSync(staleDir, { recursive: true });
    fs.writeFileSync(path.join(staleDir, "SKILL.md"), "old");

    // Install with no extensions that have skills
    installExtensionSkills([], globalDir, log);

    expect(fs.existsSync(staleDir)).toBe(false);
  });

  it("does not remove skills for active extensions", () => {
    const skillDir = makeSkillDir("active");
    // Pre-populate
    const dst = path.join(globalDir, "skills", "active");
    fs.mkdirSync(dst, { recursive: true });
    fs.writeFileSync(path.join(dst, "SKILL.md"), "old version");

    installExtensionSkills([makeMeta("active", skillDir)], globalDir, log);

    // Should have the new version, not the old
    const content = fs.readFileSync(
      path.join(globalDir, "skills", "active", "SKILL.md"),
      "utf-8",
    );
    expect(content).toContain("name: active");
    expect(content).not.toContain("old version");
  });

  it("replaces existing skill on reinstall", () => {
    const skillDir = makeSkillDir("napkin");
    installExtensionSkills([makeMeta("napkin", skillDir)], globalDir, log);

    // Modify source
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: napkin\ndescription: Updated\n---\n",
    );
    installExtensionSkills([makeMeta("napkin", skillDir)], globalDir, log);

    const content = fs.readFileSync(
      path.join(globalDir, "skills", "napkin", "SKILL.md"),
      "utf-8",
    );
    expect(content).toContain("Updated");
  });

  it("creates skills dir if it doesn't exist", () => {
    const freshGlobal = path.join(tmpDir, "fresh-global");
    const skillDir = makeSkillDir("test");
    installExtensionSkills([makeMeta("test", skillDir)], freshGlobal, log);
    expect(
      fs.existsSync(path.join(freshGlobal, "skills", "test", "SKILL.md")),
    ).toBe(true);
  });

  it("handles empty extensions array", () => {
    installExtensionSkills([], globalDir, log);
    // Should not crash, skills dir created
    expect(fs.existsSync(path.join(globalDir, "skills"))).toBe(true);
  });

  it("skips skill when requires[] not met by any chain leg", () => {
    const skillDir = makeSkillDir("pdfish");
    installExtensionSkills(
      [makeMeta("pdfish", skillDir, ["tools"])],
      globalDir,
      log,
      [{ ...DEFAULT_CAPABILITIES, tools: false }],
    );

    expect(
      fs.existsSync(path.join(globalDir, "skills", "pdfish", "SKILL.md")),
    ).toBe(false);
  });

  it("installs skill when requires met by at least one chain leg", () => {
    const skillDir = makeSkillDir("pdfish");
    installExtensionSkills(
      [makeMeta("pdfish", skillDir, ["tools"])],
      globalDir,
      log,
      [
        { ...DEFAULT_CAPABILITIES, tools: false },
        { ...DEFAULT_CAPABILITIES, tools: true },
      ],
    );

    expect(
      fs.existsSync(path.join(globalDir, "skills", "pdfish", "SKILL.md")),
    ).toBe(true);
  });
});

describe("installBuiltinSkills", () => {
  it("copies built-in skill directories", () => {
    const builtinDir = path.join(tmpDir, "builtin-skills");
    fs.mkdirSync(path.join(builtinDir, "tasks"), { recursive: true });
    fs.writeFileSync(
      path.join(builtinDir, "tasks", "SKILL.md"),
      "---\nname: tasks\ndescription: Manage tasks\n---\n",
    );

    installBuiltinSkills(builtinDir, globalDir, log);

    expect(
      fs.existsSync(path.join(globalDir, "skills", "tasks", "SKILL.md")),
    ).toBe(true);
  });

  it("skips non-directory entries", () => {
    const builtinDir = path.join(tmpDir, "builtin-skills");
    fs.mkdirSync(builtinDir, { recursive: true });
    fs.writeFileSync(path.join(builtinDir, "readme.txt"), "ignore me");

    installBuiltinSkills(builtinDir, globalDir, log);
    expect(fs.existsSync(path.join(globalDir, "skills", "readme.txt"))).toBe(
      false,
    );
  });

  it("handles missing builtin skills directory", () => {
    installBuiltinSkills(path.join(tmpDir, "nonexistent"), globalDir, log);
    // Should not crash
  });

  it("copies multiple built-in skills", () => {
    const builtinDir = path.join(tmpDir, "builtin-skills");
    for (const name of ["tasks", "roles", "config"]) {
      fs.mkdirSync(path.join(builtinDir, name), { recursive: true });
      fs.writeFileSync(
        path.join(builtinDir, name, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${name}\n---\n`,
      );
    }

    installBuiltinSkills(builtinDir, globalDir, log);

    for (const name of ["tasks", "roles", "config"]) {
      expect(
        fs.existsSync(path.join(globalDir, "skills", name, "SKILL.md")),
      ).toBe(true);
    }
  });

  it("does not install built-in skills when no chain leg has tools", () => {
    const builtinDir = path.join(tmpDir, "builtin-skills");
    fs.mkdirSync(path.join(builtinDir, "tasks"), { recursive: true });
    fs.writeFileSync(
      path.join(builtinDir, "tasks", "SKILL.md"),
      "---\nname: tasks\n---\n",
    );

    installBuiltinSkills(builtinDir, globalDir, log, [
      { ...DEFAULT_CAPABILITIES, tools: false },
    ]);

    expect(
      fs.existsSync(path.join(globalDir, "skills", "tasks", "SKILL.md")),
    ).toBe(false);
  });
});

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetPermissions } from "../src/core/permissions.js";
import { ExtensionRegistry } from "../src/extensions/loader.js";
import { Db } from "../src/storage/db.js";

let tmpDir: string;
let db: Db;
let extDir: string;
let registry: ExtensionRegistry;

const log = {
  level: "info" as const,
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => log,
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-ext-loader-"));
  db = new Db(path.join(tmpDir, "state.db"));
  extDir = path.join(tmpDir, "extensions");
  fs.mkdirSync(extDir);
  registry = new ExtensionRegistry();
  resetPermissions();
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeExt(name: string, code: string) {
  const dir = path.join(extDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.ts"), code);
  return dir;
}

function writeExtWithSkill(name: string, code: string) {
  const dir = writeExt(name, code);
  const skillDir = path.join(dir, "skill");
  fs.mkdirSync(skillDir);
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# Test Skill\n");
  return dir;
}

describe("ExtensionRegistry", () => {
  it("loads an extension with default export", async () => {
    writeExt(
      "hello",
      `export default function(m) { m.config("foo", { description: "test", default: "bar" }); }`,
    );
    await registry.loadAll(extDir, db, log);

    expect(registry.size).toBe(1);
    expect(registry.get("hello")).toBeDefined();
    expect(registry.get("hello")?.name).toBe("hello");
    expect(registry.get("hello")?.configs.get("foo")).toBeDefined();
  });

  it("loads multiple extensions", async () => {
    writeExt("ext-a", "export default function(m) {}");
    writeExt("ext-b", "export default function(m) {}");
    await registry.loadAll(extDir, db, log);
    expect(registry.size).toBe(2);
    expect(
      registry
        .list()
        .map((e) => e.name)
        .sort(),
    ).toEqual(["ext-a", "ext-b"]);
  });

  it("returns empty for missing extensions directory", async () => {
    await registry.loadAll(path.join(tmpDir, "nonexistent"), db, log);
    expect(registry.size).toBe(0);
  });

  it("returns empty for empty extensions directory", async () => {
    await registry.loadAll(extDir, db, log);
    expect(registry.size).toBe(0);
  });

  it("skips directories without index.ts", async () => {
    fs.mkdirSync(path.join(extDir, "empty-ext"));
    await registry.loadAll(extDir, db, log);
    expect(registry.size).toBe(0);
  });

  it("skips files (non-directories)", async () => {
    fs.writeFileSync(path.join(extDir, "not-a-dir.ts"), "");
    await registry.loadAll(extDir, db, log);
    expect(registry.size).toBe(0);
  });

  it("skips invalid extension names", async () => {
    writeExt("UPPER_CASE", "export default function(m) {}");
    writeExt("has spaces", "export default function(m) {}");
    await registry.loadAll(extDir, db, log);
    expect(registry.size).toBe(0);
  });

  it("skips extension names starting with hyphen", async () => {
    writeExt("-bad-name", "export default function(m) {}");
    await registry.loadAll(extDir, db, log);
    expect(registry.size).toBe(0);
  });

  it("throws on reserved name collision", async () => {
    writeExt("tasks", "export default function(m) {}");
    await expect(registry.loadAll(extDir, db, log)).rejects.toThrow(
      "conflicts with built-in",
    );
  });

  it("throws on reserved name collision — all reserved names", async () => {
    for (const name of [
      "tasks",
      "roles",
      "permissions",
      "config",
      "prefs",
      "preferences",
      "spaces",
      "stop",
      "compact",
      "ext",
      "whoami",
      "help",
    ]) {
      const r = new ExtensionRegistry();
      const d = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-res-"));
      const ed = path.join(d, "extensions");
      fs.mkdirSync(ed);
      writeExtIn(ed, name, "export default function(m) {}");
      try {
        await expect(r.loadAll(ed, db, log)).rejects.toThrow(
          "conflicts with built-in",
        );
      } finally {
        fs.rmSync(d, { recursive: true, force: true });
      }
    }
  });

  it("skips extension that throws during load", async () => {
    writeExt("bad", `export default function(m) { throw new Error("boom"); }`);
    writeExt("good", "export default function(m) {}");
    await registry.loadAll(extDir, db, log);
    expect(registry.size).toBe(1);
    expect(registry.get("good")).toBeDefined();
    expect(registry.get("bad")).toBeUndefined();
  });

  it("skips extension without default export", async () => {
    writeExt("no-default", "export function setup(m) {}");
    await registry.loadAll(extDir, db, log);
    expect(registry.size).toBe(0);
  });

  it("collects cli declaration", async () => {
    writeExt(
      "my-tool",
      `export default function(m) { m.cli({ name: "my-tool", install: "npm i -g my-tool" }); }`,
    );
    await registry.loadAll(extDir, db, log);
    const ext = registry.get("my-tool");
    expect(ext).toBeDefined();
    expect(ext.clis).toEqual([
      { name: "my-tool", install: "npm i -g my-tool" },
    ]);
    expect(registry.getCliExtensions()).toHaveLength(1);
  });

  it("collects permission declaration", async () => {
    writeExt(
      "my-tool",
      `export default function(m) { m.permission({ defaultRoles: ["admin", "member"] }); }`,
    );
    await registry.loadAll(extDir, db, log);
    const ext = registry.get("my-tool");
    expect(ext).toBeDefined();
    expect(ext.permission).toEqual({
      defaultRoles: ["admin", "member"],
    });
  });

  it("collects skill declaration", async () => {
    writeExtWithSkill(
      "my-tool",
      `export default function(m) { m.skill("./skill"); }`,
    );
    await registry.loadAll(extDir, db, log);
    const ext = registry.get("my-tool");
    expect(ext).toBeDefined();
    expect(ext.skillDir).toContain("my-tool");
    expect(ext.skillDir).toContain("skill");
  });

  it("collects hook handlers", async () => {
    writeExt(
      "hooky",
      `export default function(m) {
				m.on("startup", async () => {});
				m.on("shutdown", async () => {});
			}`,
    );
    await registry.loadAll(extDir, db, log);
    expect(registry.getHookHandlers("startup")).toHaveLength(1);
    expect(registry.getHookHandlers("shutdown")).toHaveLength(1);
    expect(registry.getHookHandlers("workspace_init")).toHaveLength(0);
  });

  it("collects hooks from multiple extensions", async () => {
    writeExt(
      "ext-a",
      `export default function(m) { m.on("startup", async () => {}); }`,
    );
    writeExt(
      "ext-b",
      `export default function(m) { m.on("startup", async () => {}); }`,
    );
    await registry.loadAll(extDir, db, log);
    expect(registry.getHookHandlers("startup")).toHaveLength(2);
  });

  it("collects jobs", async () => {
    writeExt(
      "worker",
      `export default function(m) {
				m.job("tick", { interval: 1000, run: async () => {} });
				m.job("daily", { cron: "0 0 * * *", run: async () => {} });
			}`,
    );
    await registry.loadAll(extDir, db, log);
    const jobs = registry.getJobs();
    expect(jobs).toHaveLength(2);
    expect(jobs[0].extension).toBe("worker");
    expect(jobs[0].name).toBe("tick");
    expect(jobs[1].name).toBe("daily");
  });

  it("collects widgets", async () => {
    writeExt(
      "dash",
      `export default function(m) {
				m.widget({ label: "Test", render: () => "<p>hi</p>" });
			}`,
    );
    await registry.loadAll(extDir, db, log);
    const ext = registry.get("dash");
    expect(ext).toBeDefined();
    expect(ext.widgets).toHaveLength(1);
    expect(ext.widgets[0].label).toBe("Test");
  });

  it("skips duplicate extension name from second directory", async () => {
    writeExt("dup-test", "export default function(m) {}");
    await registry.loadAll(extDir, db, log);
    expect(registry.size).toBe(1);

    // Loading same dir again should silently skip the duplicate
    await registry.loadAll(extDir, db, log);
    expect(registry.size).toBe(1);
  });

  it("user extensions take precedence over built-in", async () => {
    const builtinDir = path.join(tmpDir, "builtin-extensions");
    fs.mkdirSync(builtinDir);
    writeExt(
      "my-ext",
      `export default function(m) { m.config("source", { description: "test", default: "user" }); }`,
    );
    writeExtIn(
      builtinDir,
      "my-ext",
      `export default function(m) { m.config("source", { description: "test", default: "builtin" }); }`,
    );
    await registry.loadAll(extDir, db, log, undefined, [builtinDir]);
    expect(registry.size).toBe(1);
    expect(registry.get("my-ext")?.configs.get("source")?.default).toBe("user");
  });

  it("getCliExtensions only returns extensions with cli", async () => {
    writeExt(
      "with-cli",
      `export default function(m) { m.cli({ name: "with-cli", install: "npm i -g x" }); }`,
    );
    writeExt("no-cli", "export default function(m) {}");
    await registry.loadAll(extDir, db, log);
    expect(registry.size).toBe(2);
    const cliExts = registry.getCliExtensions();
    expect(cliExts).toHaveLength(1);
    expect(cliExts[0].name).toBe("with-cli");
  });

  it("throws when connection is declared without permission", async () => {
    writeExt(
      "no-perm",
      `export default function(m) {
        m.env({ from: "MERCURY_NO_PERM" });
        m.connection({
          displayName: "No Perm",
          category: "other",
          authType: "apikey",
          credentialEnvVar: "MERCURY_NO_PERM",
        });
      }`,
    );
    process.env.MERCURY_NO_PERM = "test-value";
    const errors: string[] = [];
    const captureLog = { ...log, error: (msg: string) => errors.push(msg) };
    await registry.loadAll(extDir, db, captureLog);
    expect(registry.get("no-perm")).toBeUndefined();
    expect(
      errors.some((m) => m.includes("connection() requires permission()")),
    ).toBe(true);
    delete process.env.MERCURY_NO_PERM;
  });

  it("loads connection extension that declares both connection and permission", async () => {
    writeExt(
      "with-perm",
      `export default function(m) {
        m.permission({ defaultRoles: ["admin"] });
        m.env({ from: "MERCURY_WITH_PERM" });
        m.connection({
          displayName: "With Perm",
          category: "other",
          authType: "apikey",
          credentialEnvVar: "MERCURY_WITH_PERM",
        });
      }`,
    );
    process.env.MERCURY_WITH_PERM = "test-value";
    await registry.loadAll(extDir, db, log);
    expect(registry.get("with-perm")).toBeDefined();
    expect(registry.get("with-perm")?.connection?.displayName).toBe(
      "With Perm",
    );
    delete process.env.MERCURY_WITH_PERM;
  });

  it("store is scoped to extension", async () => {
    writeExt(
      "store-test",
      `export default function(m) {
				m.store.set("key", "value");
			}`,
    );
    await registry.loadAll(extDir, db, log);
    expect(db.getExtState("store-test", "key")).toBe("value");
  });
});

// Helper for writing extensions in arbitrary dirs
function writeExtIn(baseDir: string, name: string, code: string) {
  const dir = path.join(baseDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.ts"), code);
}

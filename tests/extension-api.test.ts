import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetPermissions } from "../src/core/permissions.js";
import { MercuryExtensionAPIImpl } from "../src/extensions/api.js";
import { Db } from "../src/storage/db.js";

let tmpDir: string;
let db: Db;
let extDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-ext-api-"));
  db = new Db(path.join(tmpDir, "state.db"));
  extDir = path.join(tmpDir, "test-ext");
  fs.mkdirSync(extDir, { recursive: true });
  resetPermissions();
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function createApi(name = "test-ext") {
  return new MercuryExtensionAPIImpl(name, extDir, db);
}

describe("MercuryExtensionAPI", () => {
  describe("cli()", () => {
    it("stores cli config", () => {
      const api = createApi();
      api.cli({ name: "test", install: "npm i -g test" });
      expect(api.getMeta().clis).toEqual([
        { name: "test", install: "npm i -g test" },
      ]);
    });

    it("allows multiple cli calls", () => {
      const api = createApi();
      api.cli({ name: "test", install: "npm i -g test" });
      api.cli({ name: "other", install: "npm i -g other" });
      expect(api.getMeta().clis).toEqual([
        { name: "test", install: "npm i -g test" },
        { name: "other", install: "npm i -g other" },
      ]);
    });

    it("throws on empty name", () => {
      const api = createApi();
      expect(() => api.cli({ name: "", install: "npm i" })).toThrow(
        "requires name and install",
      );
    });

    it("throws on empty install", () => {
      const api = createApi();
      expect(() => api.cli({ name: "test", install: "" })).toThrow(
        "requires name and install",
      );
    });
  });

  describe("permission()", () => {
    it("stores permission config", () => {
      const api = createApi();
      api.permission({ defaultRoles: ["admin"] });
      expect(api.getMeta().permission).toEqual({
        defaultRoles: ["admin"],
      });
    });

    it("registers with dynamic permission system", () => {
      const api = createApi("perm-test");
      api.permission({ defaultRoles: ["member"] });

      const { getAllPermissions } = require("../src/core/permissions.js");
      expect(getAllPermissions()).toContain("perm-test");
    });

    it("throws on second call", () => {
      const api = createApi();
      api.permission({ defaultRoles: ["admin"] });
      expect(() => api.permission({ defaultRoles: ["member"] })).toThrow(
        "only be called once",
      );
    });
  });

  describe("skill()", () => {
    it("resolves and stores skill dir", () => {
      const skillDir = path.join(extDir, "skill");
      fs.mkdirSync(skillDir);
      fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# Test\n");

      const api = createApi();
      api.skill("./skill");
      expect(api.getMeta().skillDir).toBe(skillDir);
    });

    it("throws when SKILL.md missing", () => {
      const skillDir = path.join(extDir, "skill");
      fs.mkdirSync(skillDir);

      const api = createApi();
      expect(() => api.skill("./skill")).toThrow("SKILL.md not found");
    });
  });

  describe("requires()", () => {
    it("stores capability requirements", () => {
      const api = createApi();
      api.requires(["tools"]);
      expect(api.getMeta().requires).toEqual(["tools"]);
    });

    it("throws on empty array", () => {
      const api = createApi();
      expect(() => api.requires([])).toThrow("non-empty");
    });

    it("throws on unknown capability", () => {
      const api = createApi();
      expect(() =>
        // @ts-expect-error intentional invalid capability name
        api.requires(["not-a-capability"]),
      ).toThrow("unknown capability");
    });
  });

  describe("on()", () => {
    it("registers handlers for different events", () => {
      const api = createApi();
      api.on("startup", async () => undefined);
      api.on("shutdown", async () => undefined);
      api.on("workspace_init", async () => undefined);

      const meta = api.getMeta();
      expect(meta.hooks.get("startup")).toHaveLength(1);
      expect(meta.hooks.get("shutdown")).toHaveLength(1);
      expect(meta.hooks.get("workspace_init")).toHaveLength(1);
    });

    it("allows multiple handlers for same event", () => {
      const api = createApi();
      api.on("startup", async () => undefined);
      api.on("startup", async () => undefined);
      expect(api.getMeta().hooks.get("startup")).toHaveLength(2);
    });
  });

  describe("job()", () => {
    it("registers interval job", () => {
      const api = createApi();
      const run = async () => {};
      api.job("tick", { interval: 1000, run });
      expect(api.getMeta().jobs.get("tick")).toEqual({
        interval: 1000,
        run,
      });
    });

    it("registers cron job", () => {
      const api = createApi();
      const run = async () => {};
      api.job("daily", { cron: "0 0 * * *", run });
      expect(api.getMeta().jobs.get("daily")).toEqual({
        cron: "0 0 * * *",
        run,
      });
    });

    it("throws without interval or cron", () => {
      const api = createApi();
      expect(() => api.job("bad", { run: async () => {} })).toThrow(
        "requires interval or cron",
      );
    });

    it("throws with both interval and cron", () => {
      const api = createApi();
      expect(() =>
        api.job("bad", {
          interval: 1000,
          cron: "* * * * *",
          run: async () => {},
        }),
      ).toThrow("cannot have both");
    });

    it("throws on duplicate job name", () => {
      const api = createApi();
      api.job("tick", { interval: 1000, run: async () => {} });
      expect(() =>
        api.job("tick", { interval: 2000, run: async () => {} }),
      ).toThrow("already registered");
    });

    it("throws on empty name", () => {
      const api = createApi();
      expect(() =>
        api.job("", { interval: 1000, run: async () => {} }),
      ).toThrow("requires a name");
    });

    it("throws when run is not a function", () => {
      const api = createApi();
      expect(() =>
        api.job("bad", { interval: 1000, run: "not a fn" as unknown as never }),
      ).toThrow("requires a run function");
    });
  });

  describe("config()", () => {
    it("registers config key", () => {
      const api = createApi();
      api.config("enabled", {
        description: "Enable this",
        default: "true",
      });
      const cfg = api.getMeta().configs.get("enabled");
      expect(cfg).toBeDefined();
      expect(cfg?.description).toBe("Enable this");
      expect(cfg?.default).toBe("true");
    });

    it("throws on duplicate key", () => {
      const api = createApi();
      api.config("enabled", {
        description: "test",
        default: "true",
      });
      expect(() =>
        api.config("enabled", {
          description: "test2",
          default: "false",
        }),
      ).toThrow("already registered");
    });

    it("throws on empty key", () => {
      const api = createApi();
      expect(() =>
        api.config("", { description: "test", default: "x" }),
      ).toThrow("requires a key");
    });
  });

  describe("widget()", () => {
    it("registers widget", () => {
      const api = createApi();
      const render = () => "<p>hi</p>";
      api.widget({ label: "Test", render });
      expect(api.getMeta().widgets).toHaveLength(1);
      expect(api.getMeta().widgets[0].label).toBe("Test");
    });

    it("allows multiple widgets", () => {
      const api = createApi();
      api.widget({ label: "A", render: () => "" });
      api.widget({ label: "B", render: () => "" });
      expect(api.getMeta().widgets).toHaveLength(2);
    });

    it("throws on empty label", () => {
      const api = createApi();
      expect(() => api.widget({ label: "", render: () => "" })).toThrow(
        "requires a label",
      );
    });

    it("throws when render is not a function", () => {
      const api = createApi();
      expect(() =>
        api.widget({ label: "X", render: "not a fn" as unknown as never }),
      ).toThrow("requires a render function");
    });
  });

  describe("meta isolation", () => {
    it("two extensions have independent metadata", () => {
      const a = new MercuryExtensionAPIImpl("ext-a", extDir, db);
      const b = new MercuryExtensionAPIImpl("ext-b", extDir, db);

      a.config("key", { description: "a", default: "1" });
      b.job("tick", { interval: 1000, run: async () => {} });

      expect(a.getMeta().configs.size).toBe(1);
      expect(a.getMeta().jobs.size).toBe(0);
      expect(b.getMeta().configs.size).toBe(0);
      expect(b.getMeta().jobs.size).toBe(1);
    });
  });

  describe("store", () => {
    it("get/set scoped to extension", () => {
      const api = createApi("ext-a");
      api.store.set("key", "val-a");

      const api2 = new MercuryExtensionAPIImpl("ext-b", extDir, db);
      api2.store.set("key", "val-b");

      expect(api.store.get("key")).toBe("val-a");
      expect(api2.store.get("key")).toBe("val-b");
    });

    it("delete works", () => {
      const api = createApi();
      api.store.set("k", "v");
      expect(api.store.delete("k")).toBe(true);
      expect(api.store.get("k")).toBeNull();
    });

    it("list returns scoped entries", () => {
      const api = createApi("scoped");
      api.store.set("a", "1");
      api.store.set("b", "2");

      const other = new MercuryExtensionAPIImpl("other", extDir, db);
      other.store.set("c", "3");

      expect(api.store.list()).toEqual([
        { key: "a", value: "1" },
        { key: "b", value: "2" },
      ]);
    });
  });
});

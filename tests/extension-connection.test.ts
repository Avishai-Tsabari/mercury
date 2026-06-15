import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetPermissions } from "../src/core/permissions.js";
import { MercuryExtensionAPIImpl } from "../src/extensions/api.js";
import { ExtensionRegistry } from "../src/extensions/loader.js";
import { Db } from "../src/storage/db.js";

let tmpDir: string;
let db: Db;
let extDir: string;

const log = {
  level: "info" as const,
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => log,
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-ext-conn-"));
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

describe("mercury.connection()", () => {
  it("stores connection metadata on meta.connection", () => {
    const api = createApi();
    api.env({ from: "MERCURY_TEST_KEY" });
    api.connection({
      displayName: "Test Service",
      category: "workspace",
      authType: "apikey",
      credentialEnvVar: "MERCURY_TEST_KEY",
    });
    const meta = api.getMeta();
    expect(meta.connection).toBeDefined();
    expect(meta.connection?.displayName).toBe("Test Service");
    expect(meta.connection?.credentialEnvVar).toBe("MERCURY_TEST_KEY");
  });

  it("throws on second call", () => {
    const api = createApi();
    api.connection({
      displayName: "A",
      category: "other",
      authType: "custom",
      statusCheck: async () => ({ status: "connected" }),
    });
    expect(() =>
      api.connection({
        displayName: "B",
        category: "other",
        authType: "custom",
        statusCheck: async () => ({ status: "connected" }),
      }),
    ).toThrow("only be called once");
  });

  it("throws on missing displayName", () => {
    const api = createApi();
    expect(() =>
      api.connection({
        displayName: "",
        category: "other",
        authType: "custom",
        statusCheck: async () => ({ status: "connected" }),
      }),
    ).toThrow("requires a displayName");
  });

  it("throws on unknown category", () => {
    const api = createApi();
    expect(() =>
      api.connection({
        displayName: "X",
        // @ts-expect-error intentional invalid category
        category: "not-a-category",
        authType: "custom",
        statusCheck: async () => ({ status: "connected" }),
      }),
    ).toThrow("unknown category");
  });

  it("throws on unknown authType", () => {
    const api = createApi();
    expect(() =>
      api.connection({
        displayName: "X",
        category: "other",
        // @ts-expect-error intentional invalid authType
        authType: "not-a-type",
        statusCheck: async () => ({ status: "connected" }),
      }),
    ).toThrow("unknown authType");
  });
});

describe("loader post-setup validation", () => {
  function writeExt(name: string, code: string) {
    const dir = path.join(extDir, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "index.ts"), code);
    return dir;
  }

  it("loads when credentialEnvVar matches an envVars entry", async () => {
    writeExt(
      "ok-env",
      `export default function(m) {
        m.permission({ defaultRoles: ["admin"] });
        m.env({ from: "MERCURY_FOO" });
        m.connection({
          displayName: "Foo",
          category: "other",
          authType: "apikey",
          credentialEnvVar: "MERCURY_FOO",
        });
      }`,
    );
    process.env.MERCURY_FOO = "test-value";
    const registry = new ExtensionRegistry();
    await registry.loadAll(extDir, db, log);
    expect(registry.get("ok-env")?.connection?.displayName).toBe("Foo");
    delete process.env.MERCURY_FOO;
  });

  it("loads when only statusCheck is declared (no credentialEnvVar)", async () => {
    writeExt(
      "ok-check",
      `export default function(m) {
        m.permission({ defaultRoles: ["admin"] });
        m.connection({
          displayName: "Check",
          category: "other",
          authType: "custom",
          statusCheck: async () => ({ status: "connected" }),
        });
      }`,
    );
    const registry = new ExtensionRegistry();
    await registry.loadAll(extDir, db, log);
    expect(registry.get("ok-check")?.connection?.displayName).toBe("Check");
  });

  it("skips extension when connection has no signal and no permission", async () => {
    writeExt(
      "no-signal",
      `export default function(m) {
        m.connection({
          displayName: "Bad",
          category: "other",
          authType: "custom",
        });
      }`,
    );
    const errors: string[] = [];
    const captureLog = { ...log, error: (msg: string) => errors.push(msg) };
    const registry = new ExtensionRegistry();
    await registry.loadAll(extDir, db, captureLog);
    expect(registry.get("no-signal")).toBeUndefined();
    expect(
      errors.some((m) => m.includes("connection() requires permission()")),
    ).toBe(true);
  });

  it("skips extension when connection has no signal but has permission", async () => {
    writeExt(
      "no-signal-perm",
      `export default function(m) {
        m.permission({ defaultRoles: ["admin"] });
        m.connection({
          displayName: "Bad",
          category: "other",
          authType: "custom",
        });
      }`,
    );
    const errors: string[] = [];
    const captureLog = { ...log, error: (msg: string) => errors.push(msg) };
    const registry = new ExtensionRegistry();
    await registry.loadAll(extDir, db, captureLog);
    expect(registry.get("no-signal-perm")).toBeUndefined();
    expect(errors.some((m) => m.includes("at least one of"))).toBe(true);
  });

  it("skips extension when credentialEnvVar is not declared via mercury.env()", async () => {
    writeExt(
      "mismatch",
      `export default function(m) {
        m.permission({ defaultRoles: ["admin"] });
        m.env({ from: "MERCURY_CORRECT" });
        m.connection({
          displayName: "Mismatch",
          category: "other",
          authType: "apikey",
          credentialEnvVar: "MERCURY_TYPO",
        });
      }`,
    );
    const errors: string[] = [];
    const captureLog = { ...log, error: (msg: string) => errors.push(msg) };
    const registry = new ExtensionRegistry();
    await registry.loadAll(extDir, db, captureLog);
    expect(registry.get("mismatch")).toBeUndefined();
    expect(errors.some((m) => m.includes("not declared via mercury.env"))).toBe(
      true,
    );
  });

  it("load-time validation runs after setup, so connection-before-env works", async () => {
    writeExt(
      "order",
      `export default function(m) {
        m.permission({ defaultRoles: ["admin"] });
        m.connection({
          displayName: "Order",
          category: "other",
          authType: "apikey",
          credentialEnvVar: "MERCURY_LATER",
        });
        m.env({ from: "MERCURY_LATER" });
      }`,
    );
    process.env.MERCURY_LATER = "test-value";
    const registry = new ExtensionRegistry();
    await registry.loadAll(extDir, db, log);
    expect(registry.get("order")?.connection?.displayName).toBe("Order");
    delete process.env.MERCURY_LATER;
  });
});

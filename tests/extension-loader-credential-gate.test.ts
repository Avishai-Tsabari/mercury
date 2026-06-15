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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-ext-cred-gate-"));
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
}

const CONNECTION_EXT_CODE = `export default function(m) {
  m.permission({ defaultRoles: ["admin"] });
  m.env({ from: "MERCURY_TEST_CRED" });
  m.connection({
    displayName: "Test Service",
    category: "other",
    authType: "apikey",
    credentialEnvVar: "MERCURY_TEST_CRED",
  });
}`;

const STATUSCHECK_ONLY_CODE = `export default function(m) {
  m.permission({ defaultRoles: ["admin"] });
  m.connection({
    displayName: "Status Only",
    category: "other",
    authType: "custom",
    statusCheck: async () => ({ status: "connected" }),
  });
}`;

describe("credential-gated loading", () => {
  it("skips connection extension when credential env var is unset", async () => {
    delete process.env.MERCURY_TEST_CRED;
    writeExt("test-conn", CONNECTION_EXT_CODE);
    await registry.loadAll(extDir, db, log);
    expect(registry.size).toBe(0);
    expect(registry.get("test-conn")).toBeUndefined();
  });

  it("skips connection extension when credential env var is empty string", async () => {
    process.env.MERCURY_TEST_CRED = "";
    writeExt("test-conn", CONNECTION_EXT_CODE);
    await registry.loadAll(extDir, db, log);
    expect(registry.size).toBe(0);
    expect(registry.get("test-conn")).toBeUndefined();
    delete process.env.MERCURY_TEST_CRED;
  });

  it("loads connection extension when credential env var is set", async () => {
    process.env.MERCURY_TEST_CRED = "some-api-key";
    writeExt("test-conn", CONNECTION_EXT_CODE);
    await registry.loadAll(extDir, db, log);
    expect(registry.size).toBe(1);
    expect(registry.get("test-conn")).toBeDefined();
    expect(registry.get("test-conn")?.connection?.displayName).toBe(
      "Test Service",
    );
    delete process.env.MERCURY_TEST_CRED;
  });

  it("loads connection extension with statusCheck but no credentialEnvVar", async () => {
    writeExt("status-only", STATUSCHECK_ONLY_CODE);
    await registry.loadAll(extDir, db, log);
    expect(registry.size).toBe(1);
    expect(registry.get("status-only")).toBeDefined();
  });

  it("loads non-connection extension unconditionally", async () => {
    writeExt("plain", "export default function(m) {}");
    await registry.loadAll(extDir, db, log);
    expect(registry.size).toBe(1);
    expect(registry.get("plain")).toBeDefined();
  });

  it("credential gate applies to both user and builtin dirs", async () => {
    delete process.env.MERCURY_TEST_CRED;
    const builtinDir = path.join(tmpDir, "builtin");
    fs.mkdirSync(builtinDir);
    const dir = path.join(builtinDir, "test-conn");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "index.ts"), CONNECTION_EXT_CODE);

    await registry.loadAll(extDir, db, log, undefined, [builtinDir]);
    expect(registry.size).toBe(0);
  });

  it("does not register config keys for gated extensions", async () => {
    delete process.env.MERCURY_TEST_CRED;
    writeExt(
      "test-conn",
      `export default function(m) {
        m.permission({ defaultRoles: ["admin"] });
        m.env({ from: "MERCURY_TEST_CRED" });
        m.connection({
          displayName: "Test",
          category: "other",
          authType: "apikey",
          credentialEnvVar: "MERCURY_TEST_CRED",
        });
        m.config("enabled", { description: "test", default: "true" });
      }`,
    );
    await registry.loadAll(extDir, db, log);
    expect(registry.size).toBe(0);
  });
});

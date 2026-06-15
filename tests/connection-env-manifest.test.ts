import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import manifest from "../resources/connection-env-vars.json";
import { resetPermissions } from "../src/core/permissions.js";
import { MercuryExtensionAPIImpl } from "../src/extensions/api.js";
import { Db } from "../src/storage/db.js";

let tmpDir: string;
let db: Db;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-manifest-"));
  db = new Db(path.join(tmpDir, "state.db"));
  resetPermissions();
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const resourcesDir = path.resolve(import.meta.dir, "../examples/extensions");

async function loadExtension(name: string) {
  const extDir = path.join(resourcesDir, name);
  const api = new MercuryExtensionAPIImpl(name, extDir, db);
  const mod = await import(path.join(extDir, "index.ts"));
  mod.default(api);
  return api.getMeta();
}

describe("connection-env-vars manifest consistency", () => {
  it("gws credentialEnvVar matches manifest", async () => {
    const meta = await loadExtension("gws");
    expect(meta.connection?.credentialEnvVar).toBe(
      manifest.gws.credentialEnvVar,
    );
  });

  it("gws env vars are declared", async () => {
    const meta = await loadExtension("gws");
    const declaredVars = meta.envVars.map((e) => e.from);
    for (const envVar of Object.values(manifest.gws.env)) {
      expect(declaredVars).toContain(envVar);
    }
  });

  it("yahoo-mail credentialEnvVar matches manifest", async () => {
    const meta = await loadExtension("yahoo-mail");
    expect(meta.connection?.credentialEnvVar).toBe(
      manifest["yahoo-mail"].credentialEnvVar,
    );
  });

  it("yahoo-mail env vars are declared", async () => {
    const meta = await loadExtension("yahoo-mail");
    const declaredVars = meta.envVars.map((e) => e.from);
    for (const envVar of Object.values(manifest["yahoo-mail"].env)) {
      expect(declaredVars).toContain(envVar);
    }
  });

  it("tradestation has no credentialEnvVar (uses statusCheck)", async () => {
    const meta = await loadExtension("tradestation");
    expect(meta.connection?.credentialEnvVar).toBeUndefined();
    expect(manifest.tradestation.credentialEnvVar).toBeNull();
  });
});

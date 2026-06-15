import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createConsoleApp } from "../src/core/routes/console.js";

const API_SECRET = "test-secret-1234";

let tmpDir: string;
let whatsappAuthDir: string;

function makeApp() {
  return createConsoleApp({
    projectRoot: tmpDir,
    packageRoot: tmpDir,
    apiSecret: API_SECRET,
    spacesDir: path.join(tmpDir, "spaces"),
    dbPath: path.join(tmpDir, "state.db"),
    whatsappAuthDir,
  });
}

async function purge(
  app: ReturnType<typeof makeApp>,
  opts: { bearer?: string } = {},
) {
  const bearer = opts.bearer ?? API_SECRET;
  const res = await app.request("/adapters/whatsapp/purge", {
    method: "POST",
    headers: { Authorization: `Bearer ${bearer}` },
  });
  const data = (await res.json()) as Record<string, unknown>;
  return { status: res.status, data };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-console-test-"));
  whatsappAuthDir = path.join(tmpDir, "whatsapp-auth");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("POST /adapters/whatsapp/purge", () => {
  test("wipes existing auth directory", async () => {
    fs.mkdirSync(whatsappAuthDir);
    fs.writeFileSync(path.join(whatsappAuthDir, "creds.json"), "{}");
    const app = makeApp();

    const { status, data } = await purge(app);

    expect(status).toBe(200);
    expect(data.wiped).toBe(true);
    expect(data.alreadyAbsent).toBeUndefined();
    expect(fs.existsSync(whatsappAuthDir)).toBe(false);
  });

  test("idempotent — absent dir returns wiped:true alreadyAbsent:true", async () => {
    const app = makeApp();

    const { status, data } = await purge(app);

    expect(status).toBe(200);
    expect(data.wiped).toBe(true);
    expect(data.alreadyAbsent).toBe(true);
  });

  test("rejects missing bearer token with 401", async () => {
    const app = makeApp();

    const { status } = await purge(app, { bearer: "" });

    expect(status).toBe(401);
  });

  test("rejects wrong bearer token with 401", async () => {
    const app = makeApp();

    const { status } = await purge(app, { bearer: "wrong-secret" });

    expect(status).toBe(401);
  });
});

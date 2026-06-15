import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Hono } from "hono";
import type { AgentContainerRunner } from "../src/agent/container-runner.js";
import type { AppConfig } from "../src/config.js";
import { createApiApp, type Env } from "../src/core/api.js";
import { resetPermissions, seededSpaces } from "../src/core/permissions.js";
import { SpaceQueue } from "../src/core/space-queue.js";
import type { TaskScheduler } from "../src/core/task-scheduler.js";
import { ConfigRegistry } from "../src/extensions/config-registry.js";
import { ExtensionRegistry } from "../src/extensions/loader.js";
import { Db } from "../src/storage/db.js";

type ConnectionEntry = {
  name: string;
  displayName: string;
  iconUrl: string | null;
  category: string;
  authType: string;
  scopes: string[];
  status: "connected" | "needs-reauth" | "broken" | "unknown";
  detail: string | null;
  error: string | null;
};

type ConnectionsResponse = { connections: ConnectionEntry[] };

let tmpDir: string;
let db: Db;
let app: Hono<Env>;
let registry: ExtensionRegistry;
let extDir: string;

const headers = (caller = "admin1", group = "test-group") => ({
  "x-mercury-caller": caller,
  "x-mercury-space": group,
  "content-type": "application/json",
});

const containerRunner = {
  isRunning: () => false,
  abort: () => false,
  activeCount: 0,
  getActiveGroups: () => [],
} as unknown as AgentContainerRunner;

const scheduler = {
  start: () => {},
  stop: () => {},
  getUpcomingTasks: () => [],
} as unknown as TaskScheduler;

function writeExt(name: string, code: string) {
  const dir = path.join(extDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.ts"), code);
}

async function buildApp() {
  registry = new ExtensionRegistry();
  const log = {
    level: "info" as const,
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => log,
  };
  await registry.loadAll(extDir, db, log);

  const config = {
    port: 8787,
    admins: "admin1",
  } as AppConfig;

  app = createApiApp({
    db,
    config,
    containerRunner,
    queue: new SpaceQueue(2),
    scheduler,
    registry,
    configRegistry: new ConfigRegistry(),
  });
}

beforeEach(() => {
  resetPermissions();
  seededSpaces.clear();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-conn-routes-"));
  db = new Db(path.join(tmpDir, "state.db"));
  extDir = path.join(tmpDir, "extensions");
  fs.mkdirSync(extDir, { recursive: true });
});

afterEach(() => {
  resetPermissions();
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.MERCURY_CONN_TEST_PRESENT;
  delete process.env.MERCURY_CONN_TEST_ABSENT;
});

describe("GET /connections", () => {
  test("returns empty list when no extensions declare connection", async () => {
    writeExt(
      "plain",
      `export default function(m) { m.permission({ defaultRoles: ["admin"] }); }`,
    );
    await buildApp();
    const res = await app.request("/connections", { headers: headers() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ConnectionsResponse;
    expect(body.connections).toEqual([]);
  });

  test("default presence check: credentialEnvVar set in env", async () => {
    writeExt(
      "envpresent",
      `export default function(m) {
        m.permission({ defaultRoles: ["admin"] });
        m.env({ from: "MERCURY_CONN_TEST_PRESENT" });
        m.connection({
          displayName: "EnvPresent",
          category: "other",
          authType: "apikey",
          credentialEnvVar: "MERCURY_CONN_TEST_PRESENT",
        });
      }`,
    );
    process.env.MERCURY_CONN_TEST_PRESENT = "anything-nonempty";
    await buildApp();
    const res = await app.request("/connections", { headers: headers() });
    const body = (await res.json()) as ConnectionsResponse;
    const entry = body.connections.find((c) => c.name === "envpresent");
    expect(entry?.status).toBe("connected");
    expect(entry?.error).toBeNull();
  });

  test("credential-gated extension not loaded when credentialEnvVar unset", async () => {
    writeExt(
      "envabsent",
      `export default function(m) {
        m.permission({ defaultRoles: ["admin"] });
        m.env({ from: "MERCURY_CONN_TEST_ABSENT" });
        m.connection({
          displayName: "EnvAbsent",
          category: "other",
          authType: "apikey",
          credentialEnvVar: "MERCURY_CONN_TEST_ABSENT",
        });
      }`,
    );
    delete process.env.MERCURY_CONN_TEST_ABSENT;
    await buildApp();
    const res = await app.request("/connections", { headers: headers() });
    const body = (await res.json()) as ConnectionsResponse;
    const entry = body.connections.find((c) => c.name === "envabsent");
    expect(entry).toBeUndefined();
  });

  test("statusCheck result is used when declared", async () => {
    writeExt(
      "probe",
      `export default function(m) {
        m.permission({ defaultRoles: ["admin"] });
        m.connection({
          displayName: "Probe",
          category: "finance",
          authType: "oauth2",
          statusCheck: async () => ({ status: "needs-reauth", detail: "token expired" }),
        });
      }`,
    );
    await buildApp();
    const res = await app.request("/connections", { headers: headers() });
    const body = (await res.json()) as ConnectionsResponse;
    const entry = body.connections.find((c) => c.name === "probe");
    expect(entry?.status).toBe("needs-reauth");
    expect(entry?.detail).toBe("token expired");
    expect(entry?.error).toBeNull();
  });

  test("statusCheck throw surfaces as status=unknown with error string", async () => {
    writeExt(
      "thrower",
      `export default function(m) {
        m.permission({ defaultRoles: ["admin"] });
        m.connection({
          displayName: "Thrower",
          category: "other",
          authType: "custom",
          statusCheck: async () => { throw new Error("boom"); },
        });
      }`,
    );
    await buildApp();
    const res = await app.request("/connections", { headers: headers() });
    const body = (await res.json()) as ConnectionsResponse;
    const entry = body.connections.find((c) => c.name === "thrower");
    expect(entry?.status).toBe("unknown");
    expect(entry?.error).toBe("boom");
  });

  test("statusCheck timeout surfaces as unknown + timeout error", async () => {
    writeExt(
      "hanger",
      `export default function(m) {
        m.permission({ defaultRoles: ["admin"] });
        m.connection({
          displayName: "Hanger",
          category: "other",
          authType: "custom",
          statusCheck: () => new Promise(() => {}),
        });
      }`,
    );
    await buildApp();
    const started = Date.now();
    const res = await app.request("/connections", { headers: headers() });
    const elapsed = Date.now() - started;
    const body = (await res.json()) as ConnectionsResponse;
    const entry = body.connections.find((c) => c.name === "hanger");
    expect(entry?.status).toBe("unknown");
    expect(entry?.error).toContain("timed out");
    expect(elapsed).toBeLessThan(7000);
  }, 10000);

  test("invalid status string from statusCheck collapses to unknown", async () => {
    writeExt(
      "bogus",
      `export default function(m) {
        m.permission({ defaultRoles: ["admin"] });
        m.connection({
          displayName: "Bogus",
          category: "other",
          authType: "custom",
          statusCheck: async () => ({ status: "not-a-status" }),
        });
      }`,
    );
    await buildApp();
    const res = await app.request("/connections", { headers: headers() });
    const body = (await res.json()) as ConnectionsResponse;
    const entry = body.connections.find((c) => c.name === "bogus");
    expect(entry?.status).toBe("unknown");
    expect(entry?.error).toContain("invalid status");
  });

  test("error in one extension does not fail response for others", async () => {
    writeExt(
      "thrower",
      `export default function(m) {
        m.permission({ defaultRoles: ["admin"] });
        m.connection({
          displayName: "Thrower",
          category: "other",
          authType: "custom",
          statusCheck: async () => { throw new Error("boom"); },
        });
      }`,
    );
    writeExt(
      "good",
      `export default function(m) {
        m.permission({ defaultRoles: ["admin"] });
        m.connection({
          displayName: "Good",
          category: "other",
          authType: "custom",
          statusCheck: async () => ({ status: "connected" }),
        });
      }`,
    );
    await buildApp();
    const res = await app.request("/connections", { headers: headers() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ConnectionsResponse;
    const good = body.connections.find((c) => c.name === "good");
    const thrower = body.connections.find((c) => c.name === "thrower");
    expect(good?.status).toBe("connected");
    expect(thrower?.status).toBe("unknown");
    expect(thrower?.error).toBe("boom");
  });

  test("response never serializes credentialEnvVar or env values", async () => {
    writeExt(
      "secret",
      `export default function(m) {
        m.permission({ defaultRoles: ["admin"] });
        m.env({ from: "MERCURY_CONN_TEST_PRESENT" });
        m.connection({
          displayName: "Secret",
          category: "other",
          authType: "apikey",
          credentialEnvVar: "MERCURY_CONN_TEST_PRESENT",
        });
      }`,
    );
    const tokenValue = "super-secret-token-value-xyz";
    process.env.MERCURY_CONN_TEST_PRESENT = tokenValue;
    await buildApp();
    const res = await app.request("/connections", { headers: headers() });
    const text = await res.text();
    expect(text).not.toContain("MERCURY_CONN_TEST_PRESENT");
    expect(text).not.toContain("credentialEnvVar");
    expect(text).not.toContain(tokenValue);
  });

  test("requires auth headers", async () => {
    writeExt(
      "x",
      `export default function(m) {
        m.permission({ defaultRoles: ["admin"] });
        m.connection({
          displayName: "X",
          category: "other",
          authType: "custom",
          statusCheck: async () => ({ status: "connected" }),
        });
      }`,
    );
    await buildApp();
    const res = await app.request("/connections");
    expect(res.status).toBe(400);
  });
});

describe("GET /ext — connection metadata", () => {
  test("includes connection metadata when declared (no credentialEnvVar leak)", async () => {
    writeExt(
      "with-conn",
      `export default function(m) {
        m.permission({ defaultRoles: ["admin"] });
        m.env({ from: "MERCURY_CONN_TEST_PRESENT" });
        m.connection({
          displayName: "WithConn",
          category: "workspace",
          authType: "apikey",
          credentialEnvVar: "MERCURY_CONN_TEST_PRESENT",
          scopes: ["read"],
        });
      }`,
    );
    process.env.MERCURY_CONN_TEST_PRESENT = "test-value";
    await buildApp();
    const res = await app.request("/ext", { headers: headers() });
    const text = await res.text();
    expect(text).not.toContain("credentialEnvVar");
    expect(text).not.toContain("MERCURY_CONN_TEST_PRESENT");
    const body = (await new Response(text).json()) as {
      extensions: Array<{
        name: string;
        connection?: {
          displayName: string;
          category: string;
          authType: string;
          scopes: string[];
        };
      }>;
    };
    const ext = body.extensions.find((e) => e.name === "with-conn");
    expect(ext?.connection?.displayName).toBe("WithConn");
    expect(ext?.connection?.scopes).toEqual(["read"]);
  });

  test("omits connection field entirely when extension has no connection", async () => {
    writeExt(
      "plain",
      `export default function(m) { m.permission({ defaultRoles: ["admin"] }); }`,
    );
    await buildApp();
    const res = await app.request("/ext", { headers: headers() });
    const body = (await res.json()) as {
      extensions: Array<{ name: string; connection?: unknown }>;
    };
    const ext = body.extensions.find((e) => e.name === "plain");
    expect(ext).toBeDefined();
    expect(Object.hasOwn(ext as object, "connection")).toBe(false);
  });
});

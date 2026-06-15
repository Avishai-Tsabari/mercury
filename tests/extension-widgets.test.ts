import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppConfig } from "../src/config.js";
import { MercuryExtensionAPIImpl } from "../src/extensions/api.js";
import { createMercuryExtensionContext } from "../src/extensions/context.js";
import type { MercuryExtensionContext } from "../src/extensions/types.js";
import type { Logger } from "../src/logger.js";
import { Db } from "../src/storage/db.js";

let tmpDir: string;
let db: Db;
let ctx: MercuryExtensionContext;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-widget-test-"));
  db = new Db(path.join(tmpDir, "test.db"));
  const testLog = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child() {
      return this;
    },
  } as unknown as Logger;
  ctx = createMercuryExtensionContext({
    db,
    config: {} as AppConfig,
    log: testLog,
  });
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("Widget registration via API", () => {
  test("widget is registered in meta", () => {
    const api = new MercuryExtensionAPIImpl("test-ext", tmpDir, db);
    api.widget({ label: "Status", render: () => "<p>OK</p>" });

    const meta = api.getMeta();
    expect(meta.widgets).toHaveLength(1);
    expect(meta.widgets[0].label).toBe("Status");
  });

  test("multiple widgets registered", () => {
    const api = new MercuryExtensionAPIImpl("test-ext", tmpDir, db);
    api.widget({ label: "A", render: () => "<p>A</p>" });
    api.widget({ label: "B", render: () => "<p>B</p>" });

    const meta = api.getMeta();
    expect(meta.widgets).toHaveLength(2);
  });

  test("widget render returns HTML", () => {
    const api = new MercuryExtensionAPIImpl("test-ext", tmpDir, db);
    api.widget({ label: "Stats", render: () => "<div>42</div>" });

    const meta = api.getMeta();
    const html = meta.widgets[0].render(ctx);
    expect(html).toBe("<div>42</div>");
  });

  test("widget render can use store", () => {
    const api = new MercuryExtensionAPIImpl("test-ext", tmpDir, db);
    api.store.set("count", "5");
    api.widget({
      label: "Count",
      render: (c) => {
        const count = c.db.getExtState("test-ext", "count") ?? "0";
        return `<p>${count}</p>`;
      },
    });

    const meta = api.getMeta();
    const html = meta.widgets[0].render(ctx);
    expect(html).toBe("<p>5</p>");
  });

  test("widget render error is isolatable", () => {
    const api = new MercuryExtensionAPIImpl("test-ext", tmpDir, db);
    api.widget({
      label: "Broken",
      render: () => {
        throw new Error("render failed");
      },
    });

    const meta = api.getMeta();
    // Callers (dashboard) should catch render errors
    expect(() => meta.widgets[0].render(ctx)).toThrow("render failed");
  });
});

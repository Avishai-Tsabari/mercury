import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  runTradeStationTokenRefresh,
  TRADESTATION_EXT,
} from "../examples/extensions/tradestation/host/refresh.js";
import { Db } from "../src/storage/db.js";

let tmpDir: string;
let db: Db;

const log = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-ts-"));
  db = new Db(path.join(tmpDir, "state.db"));
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("runTradeStationTokenRefresh", () => {
  it("seeds refresh token from env when store empty", async () => {
    process.env.MERCURY_TRADESTATION_REFRESH_TOKEN = "rt-seed";
    process.env.MERCURY_TS_CLIENT_ID = "cid";

    const mockFetch = async () =>
      new Response(
        JSON.stringify({
          access_token: "at-new",
          refresh_token: "rt-new",
          expires_in: 1200,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    await runTradeStationTokenRefresh(
      db,
      log,
      mockFetch as unknown as typeof fetch,
    );

    expect(db.getExtState(TRADESTATION_EXT, "refresh_token")).toBe("rt-new");
    expect(db.getExtState(TRADESTATION_EXT, "access_token")).toBe("at-new");
    expect(db.getExtState(TRADESTATION_EXT, "auth_error")).toBeNull();

    delete process.env.MERCURY_TRADESTATION_REFRESH_TOKEN;
    delete process.env.MERCURY_TS_CLIENT_ID;
  });

  it("uses Tagula-style TS_* env when MERCURY_* unset", async () => {
    process.env.TS_REFRESH_TOKEN = "rt-tagula";
    process.env.TS_CLIENT_ID = "cid";

    const mockFetch = async () =>
      new Response(
        JSON.stringify({
          access_token: "at-from-ts-env",
          refresh_token: "rt-new",
          expires_in: 1200,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    await runTradeStationTokenRefresh(
      db,
      log,
      mockFetch as unknown as typeof fetch,
    );

    expect(db.getExtState(TRADESTATION_EXT, "access_token")).toBe(
      "at-from-ts-env",
    );

    delete process.env.TS_REFRESH_TOKEN;
    delete process.env.TS_CLIENT_ID;
  });

  it("sets auth_error when refresh fails", async () => {
    db.setExtState(TRADESTATION_EXT, "refresh_token", "bad");
    process.env.MERCURY_TS_CLIENT_ID = "cid";

    const mockFetch = async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });

    await runTradeStationTokenRefresh(
      db,
      log,
      mockFetch as unknown as typeof fetch,
    );

    expect(db.getExtState(TRADESTATION_EXT, "auth_error")).toContain(
      "refresh_failed",
    );

    delete process.env.MERCURY_TS_CLIENT_ID;
  });

  it("skips network when token still valid", async () => {
    const future = Date.now() + 60 * 60 * 1000;
    db.setExtState(TRADESTATION_EXT, "access_token", "at-ok");
    db.setExtState(TRADESTATION_EXT, "token_expiry_ms", String(future));
    db.setExtState(TRADESTATION_EXT, "refresh_token", "rt");

    let called = false;
    const mockFetch = async () => {
      called = true;
      return new Response("{}", { status: 200 });
    };

    await runTradeStationTokenRefresh(
      db,
      log,
      mockFetch as unknown as typeof fetch,
    );

    expect(called).toBe(false);
    expect(db.getExtState(TRADESTATION_EXT, "access_token")).toBe("at-ok");
  });
});

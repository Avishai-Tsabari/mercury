import { describe, expect, test } from "bun:test";
import {
  filterConsoleArgs,
  installLibsignalConsoleFilter,
} from "../src/adapters/whatsapp-console-filter";

function fakeSessionEntry(): Record<string, unknown> {
  return {
    registrationId: 123,
    currentRatchet: {
      ephemeralKeyPair: { pubKey: Buffer.alloc(33), privKey: Buffer.alloc(32) },
      rootKey: Buffer.alloc(32),
      previousCounter: 0,
    },
    indexInfo: { baseKey: Buffer.alloc(33), closed: -1 },
    _chains: {},
  };
}

describe("filterConsoleArgs", () => {
  test("suppresses known libsignal session messages entirely", () => {
    expect(
      filterConsoleArgs(["Opening session:", fakeSessionEntry()]),
    ).toBeNull();
    expect(
      filterConsoleArgs(["Closing session:", fakeSessionEntry()]),
    ).toBeNull();
    expect(
      filterConsoleArgs(["Removing old closed session:", fakeSessionEntry()]),
    ).toBeNull();
    expect(filterConsoleArgs(["Session already open"])).toBeNull();
    expect(
      filterConsoleArgs(["Session already closed", fakeSessionEntry()]),
    ).toBeNull();
    expect(filterConsoleArgs(["Migrating session to:", "v1"])).toBeNull();
    expect(
      filterConsoleArgs([
        "Closing open session in favor of incoming prekey bundle",
      ]),
    ).toBeNull();
  });

  test("redacts session-shaped objects from unknown messages", () => {
    const out = filterConsoleArgs(["some new message", fakeSessionEntry()]);
    expect(out).toEqual(["some new message", "[libsignal session redacted]"]);
  });

  test("redacts session-shaped object as first argument", () => {
    const out = filterConsoleArgs([fakeSessionEntry()]);
    expect(out).toEqual(["[libsignal session redacted]"]);
  });

  test("passes ordinary console traffic through unchanged", () => {
    const args = ["hello", { foo: "bar" }, 42];
    expect(filterConsoleArgs(args)).toBe(args);
    expect(filterConsoleArgs(["Session error: boom", "stack"])).toEqual([
      "Session error: boom",
      "stack",
    ]);
  });

  test("does not redact objects that merely mention similar keys", () => {
    const args = ["msg", { currentRatchet: true }, { sessions: {} }];
    expect(filterConsoleArgs(args)).toBe(args);
  });
});

describe("installLibsignalConsoleFilter", () => {
  test("suppresses session dumps on the global console and is idempotent", () => {
    const originals = {
      debug: console.debug,
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
    };
    const captured: unknown[][] = [];
    console.info = (...args: unknown[]) => {
      captured.push(args);
    };
    try {
      installLibsignalConsoleFilter();
      const wrapped = console.info;
      installLibsignalConsoleFilter();
      expect(console.info).toBe(wrapped);
      console.info("Opening session:", fakeSessionEntry());
      expect(captured).toEqual([]);
      console.info("normal line", 1);
      expect(captured).toEqual([["normal line", 1]]);
    } finally {
      console.debug = originals.debug;
      console.log = originals.log;
      console.info = originals.info;
      console.warn = originals.warn;
      console.error = originals.error;
    }
  });
});

import { describe, expect, test } from "bun:test";
import {
  canonicalizeJid,
  canonicalizeJidSync,
  isLidJid,
  isPnJid,
  normalizeJid,
  resolveKeyIdentities,
  resolveKeyIdentitiesSync,
  type WaAliasStore,
} from "../src/adapters/whatsapp-identity.js";

const PN = "972501234567@s.whatsapp.net";
const LID = "24417056866472@lid";

function memoryStore(seed?: Record<string, string>): WaAliasStore & {
  learned: Array<{ lid: string; pn: string; source: string }>;
} {
  const map = new Map(Object.entries(seed ?? {}));
  const learned: Array<{ lid: string; pn: string; source: string }> = [];
  return {
    learned,
    getPnForLid: (lid) => map.get(lid) ?? null,
    learn: (lid, pn, source) => {
      map.set(lid, pn);
      learned.push({ lid, pn, source });
    },
  };
}

describe("whatsapp-identity: jid helpers", () => {
  test("isLidJid / isPnJid", () => {
    expect(isLidJid(LID)).toBe(true);
    expect(isLidJid(PN)).toBe(false);
    expect(isPnJid(PN)).toBe(true);
    expect(isPnJid(LID)).toBe(false);
  });

  test("normalizeJid strips device suffix", () => {
    expect(normalizeJid("972501234567:12@s.whatsapp.net")).toBe(PN);
    expect(normalizeJid(PN)).toBe(PN);
  });
});

describe("whatsapp-identity: canonicalizeJidSync", () => {
  test("phone jid passes through unchanged", () => {
    const result = canonicalizeJidSync(PN, undefined);
    expect(result.canonical).toBe(PN);
    expect(result.changed).toBe(false);
  });

  test("lid with phone alt resolves and learns the pair", () => {
    const store = memoryStore();
    const result = canonicalizeJidSync(LID, PN, store);
    expect(result.canonical).toBe(PN);
    expect(result.original).toBe(LID);
    expect(result.changed).toBe(true);
    expect(store.learned).toEqual([{ lid: LID, pn: PN, source: "key-alt" }]);
  });

  test("phone raw with lid alt learns the reverse pair", () => {
    const store = memoryStore();
    const result = canonicalizeJidSync(PN, LID, store);
    expect(result.canonical).toBe(PN);
    expect(result.changed).toBe(false);
    expect(store.learned).toEqual([{ lid: LID, pn: PN, source: "key-alt" }]);
  });

  test("lid resolves from the alias store when no alt field", () => {
    const store = memoryStore({ [LID]: PN });
    const result = canonicalizeJidSync(LID, undefined, store);
    expect(result.canonical).toBe(PN);
    expect(result.changed).toBe(true);
  });

  test("unresolvable lid is kept as-is", () => {
    const result = canonicalizeJidSync(LID, undefined, memoryStore());
    expect(result.canonical).toBe(LID);
    expect(result.changed).toBe(false);
  });

  test("device suffix on the alt is normalized", () => {
    const result = canonicalizeJidSync(
      LID,
      "972501234567:99@s.whatsapp.net",
      memoryStore(),
    );
    expect(result.canonical).toBe(PN);
  });

  test("empty/undefined raw never throws", () => {
    expect(canonicalizeJidSync(undefined, undefined).canonical).toBe("");
    expect(canonicalizeJidSync(null, PN).canonical).toBe("");
  });
});

describe("whatsapp-identity: canonicalizeJid (async)", () => {
  test("falls through to the lid lookup and learns from it", async () => {
    const store = memoryStore();
    const result = await canonicalizeJid(LID, undefined, store, async () => PN);
    expect(result.canonical).toBe(PN);
    expect(result.changed).toBe(true);
    expect(store.learned).toEqual([
      { lid: LID, pn: PN, source: "lid-mapping" },
    ]);
  });

  test("lookup returning null keeps the lid", async () => {
    const result = await canonicalizeJid(
      LID,
      undefined,
      undefined,
      async () => null,
    );
    expect(result.canonical).toBe(LID);
    expect(result.changed).toBe(false);
  });

  test("lookup throwing degrades to the lid instead of crashing", async () => {
    const result = await canonicalizeJid(
      LID,
      undefined,
      undefined,
      async () => {
        throw new Error("boom");
      },
    );
    expect(result.canonical).toBe(LID);
  });

  test("does not call the lookup when the sync chain already resolved", async () => {
    let called = false;
    const result = await canonicalizeJid(LID, PN, undefined, async () => {
      called = true;
      return null;
    });
    expect(result.canonical).toBe(PN);
    expect(called).toBe(false);
  });
});

describe("whatsapp-identity: resolveKeyIdentities", () => {
  test("group chat jid is never rewritten, participant is canonicalized", async () => {
    const group = "1203630298@g.us";
    const result = await resolveKeyIdentities({
      remoteJid: group,
      remoteJidAlt: LID, // hostile input — must be ignored for groups
      participant: LID,
      participantAlt: PN,
    });
    expect(result.chat.canonical).toBe(group);
    expect(result.chat.changed).toBe(false);
    expect(result.sender.canonical).toBe(PN);
    expect(result.sender.changed).toBe(true);
  });

  test("DM: sender falls back to the canonical chat jid", async () => {
    const result = await resolveKeyIdentities({
      remoteJid: LID,
      remoteJidAlt: PN,
    });
    expect(result.chat.canonical).toBe(PN);
    expect(result.chat.original).toBe(LID);
    expect(result.sender.canonical).toBe(PN);
  });

  test("sync variant matches async behavior for key-alt resolution", () => {
    const result = resolveKeyIdentitiesSync({
      remoteJid: LID,
      remoteJidAlt: PN,
    });
    expect(result.chat.canonical).toBe(PN);
    expect(result.sender.canonical).toBe(PN);
  });
});

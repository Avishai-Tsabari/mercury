import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type AutoSpaceConfig,
  resolveConversation,
} from "../src/core/conversation.js";
import { Db } from "../src/storage/db.js";

const PN_JID = "972509999999@s.whatsapp.net";
const LID_JID = "24417056866472@lid";
const PN_EXTERNAL = `${PN_JID}:${PN_JID}`;
const LID_EXTERNAL = `${LID_JID}:${LID_JID}`;
const PN_CALLER = `whatsapp:${PN_JID}`;
const LID_CALLER = `whatsapp:${LID_JID}`;

describe("whatsapp canonical identity", () => {
  let tempDir: string;
  let db: Db;

  const autoSpace: AutoSpaceConfig = {
    enabled: true,
    adminIds: ["972501234567"],
    defaultSystemPrompt: "",
    defaultMemberPermissions: "prompt,prefs.get",
    rateLimitDailyMember: 0,
  };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-wa-identity-"));
    db = new Db(path.join(tempDir, "state.db"));
    db.ensureSpace("main");
  });

  afterEach(async () => {
    db.close();
    for (let i = 0; i < 5; i++) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100 * (i + 1)));
      }
    }
  });

  describe("alias table", () => {
    test("learn and look up in both directions", () => {
      expect(db.learnWaAlias(LID_JID, PN_JID, "key-alt")).toBe(true);
      expect(db.getWaPnForLid(LID_JID)).toBe(PN_JID);
      expect(db.getWaLidForPn(PN_JID)).toBe(LID_JID);
      expect(db.getWaPnForLid("unknown@lid")).toBeNull();
    });

    test("re-learning the same pair reports not-new", () => {
      expect(db.learnWaAlias(LID_JID, PN_JID, "key-alt")).toBe(true);
      expect(db.learnWaAlias(LID_JID, PN_JID, "key-alt")).toBe(false);
      expect(db.learnWaAlias(LID_JID, PN_JID, "lid-mapping")).toBe(false);
    });

    test("a changed pair updates and reports new", () => {
      db.learnWaAlias(LID_JID, PN_JID, "key-alt");
      expect(
        db.learnWaAlias(LID_JID, "972500000001@s.whatsapp.net", "manual"),
      ).toBe(true);
      expect(db.getWaPnForLid(LID_JID)).toBe("972500000001@s.whatsapp.net");
    });
  });

  describe("migrateCallerId", () => {
    test("moves roles, mutes, and rate usage to the new caller id", () => {
      db.ensureSpace("dm-x");
      db.setRole("dm-x", LID_CALLER, "member", "test");
      db.muteUser("dm-x", LID_CALLER, Date.now() + 60_000, "spam", "admin");
      db.checkAndIncrementDailyUsage("dm-x", LID_CALLER, 10);

      const migrated = db.migrateCallerId("dm-x", LID_CALLER, PN_CALLER);
      expect(migrated.roles).toBe(1);
      expect(migrated.mutes).toBe(1);

      expect(db.getRole("dm-x", PN_CALLER)).toBe("member");
      expect(db.getRole("dm-x", LID_CALLER)).toBeNull();
      expect(db.isMuted("dm-x", PN_CALLER)).toBe(true);
      expect(db.isMuted("dm-x", LID_CALLER)).toBe(false);
      const usage = db.checkAndIncrementDailyUsage("dm-x", PN_CALLER, 10);
      expect(usage.count).toBe(2); // migrated row incremented, not a fresh one
    });

    test("drops the old row when the target already exists", () => {
      db.ensureSpace("dm-x");
      db.setRole("dm-x", LID_CALLER, "member", "test");
      db.setRole("dm-x", PN_CALLER, "admin", "test");

      db.migrateCallerId("dm-x", LID_CALLER, PN_CALLER);
      expect(db.getRole("dm-x", PN_CALLER)).toBe("admin"); // existing wins
      expect(db.getRole("dm-x", LID_CALLER)).toBeNull();
    });

    test("no-op when ids are equal", () => {
      const migrated = db.migrateCallerId("dm-x", PN_CALLER, PN_CALLER);
      expect(migrated).toEqual({ roles: 0, mutes: 0 });
    });
  });

  describe("sticky-space adoption", () => {
    test("upgrade scenario: canonical conversation adopts the LID-keyed space", () => {
      // Pre-upgrade: customer messaged from a LID, auto-space created.
      const before = resolveConversation(
        db,
        "whatsapp",
        LID_EXTERNAL,
        "dm",
        undefined,
        autoSpace,
        "Arie",
      );
      expect(before?.spaceId).toBe("dm-24417056866472");
      db.setRole("dm-24417056866472", LID_CALLER, "member", "test");

      // Post-upgrade: same person now canonicalizes to their phone.
      const after = resolveConversation(
        db,
        "whatsapp",
        PN_EXTERNAL,
        "dm",
        undefined,
        autoSpace,
        "Arie",
        LID_EXTERNAL,
      );
      expect(after?.spaceId).toBe("dm-24417056866472");
      // No new space was created for the phone identity.
      expect(db.getSpace("dm-972509999999")).toBeNull();
      // Per-user rows were carried over to the canonical caller id.
      expect(db.getRole("dm-24417056866472", PN_CALLER)).toBe("member");
      expect(db.getRole("dm-24417056866472", LID_CALLER)).toBeNull();
      // Subsequent messages resolve straight to the adopted space.
      const again = resolveConversation(
        db,
        "whatsapp",
        PN_EXTERNAL,
        "dm",
        undefined,
        autoSpace,
        "Arie",
        LID_EXTERNAL,
      );
      expect(again?.spaceId).toBe("dm-24417056866472");
    });

    test("adoption works even when auto-space is disabled (manually linked space)", () => {
      const conv = db.ensureConversation("whatsapp", LID_EXTERNAL, "dm");
      db.ensureSpace("customer-x");
      db.linkConversation(conv.id, "customer-x");

      const result = resolveConversation(
        db,
        "whatsapp",
        PN_EXTERNAL,
        "dm",
        undefined,
        undefined,
        undefined,
        LID_EXTERNAL,
      );
      expect(result?.spaceId).toBe("customer-x");
    });

    test("alias without a space falls through to normal space creation", () => {
      db.ensureConversation("whatsapp", LID_EXTERNAL, "dm"); // unlinked
      const result = resolveConversation(
        db,
        "whatsapp",
        PN_EXTERNAL,
        "dm",
        undefined,
        autoSpace,
        "Arie",
        LID_EXTERNAL,
      );
      expect(result?.spaceId).toBe("dm-972509999999");
    });

    test("no alias behaves exactly like before", () => {
      const result = resolveConversation(
        db,
        "whatsapp",
        PN_EXTERNAL,
        "dm",
        undefined,
        autoSpace,
        "Arie",
      );
      expect(result?.spaceId).toBe("dm-972509999999");
    });

    test("double split: canonical space wins when both exist", () => {
      const lidRes = resolveConversation(
        db,
        "whatsapp",
        LID_EXTERNAL,
        "dm",
        undefined,
        autoSpace,
      );
      const pnRes = resolveConversation(
        db,
        "whatsapp",
        PN_EXTERNAL,
        "dm",
        undefined,
        autoSpace,
      );
      expect(lidRes?.spaceId).toBe("dm-24417056866472");
      expect(pnRes?.spaceId).toBe("dm-972509999999");

      const result = resolveConversation(
        db,
        "whatsapp",
        PN_EXTERNAL,
        "dm",
        undefined,
        autoSpace,
        undefined,
        LID_EXTERNAL,
      );
      expect(result?.spaceId).toBe("dm-972509999999");
    });

    test("groups never adopt", () => {
      const conv = db.ensureConversation("whatsapp", LID_EXTERNAL, "group");
      db.ensureSpace("customer-x");
      db.linkConversation(conv.id, "customer-x");

      const result = resolveConversation(
        db,
        "whatsapp",
        "123@g.us:123@g.us",
        "group",
        undefined,
        autoSpace,
        undefined,
        LID_EXTERNAL,
      );
      expect(result).toBeNull();
    });
  });

  describe("admin matching via alias", () => {
    test("admin whose configured id is the LID form still lands in main", () => {
      const adminByLid: AutoSpaceConfig = {
        ...autoSpace,
        adminIds: ["24417056866472"],
      };
      const result = resolveConversation(
        db,
        "whatsapp",
        PN_EXTERNAL,
        "dm",
        undefined,
        adminByLid,
        undefined,
        LID_EXTERNAL,
      );
      expect(result?.spaceId).toBe("main");
    });
  });
});

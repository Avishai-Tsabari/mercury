import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  confirmWords,
  formatSystemMessage,
  MESSAGE_LOCALES,
  type MessageLocale,
  resolveLocale,
  SYSTEM_MESSAGES,
  type SystemMessageKey,
} from "../src/core/system-messages.js";
import { GLOBAL_CONFIG_SPACE_ID } from "../src/extensions/config-registry.js";
import { Db } from "../src/storage/db.js";

function placeholders(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

describe("SYSTEM_MESSAGES table parity", () => {
  test("every locale has the exact same key set as en", () => {
    const enKeys = Object.keys(SYSTEM_MESSAGES.en).sort();
    for (const locale of MESSAGE_LOCALES) {
      expect(Object.keys(SYSTEM_MESSAGES[locale]).sort()).toEqual(enKeys);
    }
  });

  test("every key has identical placeholder sets across locales", () => {
    for (const [key, enTemplate] of Object.entries(SYSTEM_MESSAGES.en)) {
      const enPlaceholders = placeholders(enTemplate);
      for (const locale of MESSAGE_LOCALES) {
        const localized = (SYSTEM_MESSAGES[locale] as Record<string, string>)[
          key
        ];
        expect(placeholders(localized)).toEqual(enPlaceholders);
      }
    }
  });

  test("no empty strings in any locale", () => {
    for (const locale of MESSAGE_LOCALES) {
      for (const value of Object.values(SYSTEM_MESSAGES[locale])) {
        expect(value.length).toBeGreaterThan(0);
      }
    }
  });

  test("mrctl enable command stays verbatim in every locale", () => {
    for (const locale of MESSAGE_LOCALES) {
      expect(SYSTEM_MESSAGES[locale].sensitive_disabled).toContain(
        "mrctl config set security.sensitive_connections_allowed true",
      );
    }
  });
});

describe("formatSystemMessage", () => {
  test("substitutes placeholders", () => {
    expect(
      formatSystemMessage("en", "rate_limit_daily", {
        count: 5,
        limit: 10,
        hours: 3,
      }),
    ).toBe("You've used 5/10 messages today. Resets in 3h.");
  });

  test("en strings are byte-identical to the original literals", () => {
    expect(formatSystemMessage("en", "rate_limit_burst")).toBe(
      "Rate limit exceeded. Try again shortly.",
    );
    expect(formatSystemMessage("en", "run_stopped")).toBe(
      "Stopped current run.",
    );
    expect(formatSystemMessage("en", "container_timeout")).toBe(
      "Container timed out.",
    );
    expect(formatSystemMessage("en", "container_oom")).toBe(
      "Container was killed (possibly out of memory).",
    );
    expect(formatSystemMessage("en", "sensitive_cancelled")).toBe("Cancelled.");
    expect(
      formatSystemMessage("en", "sensitive_confirm", { name: "Payments" }),
    ).toBe(
      "⚠️ This response may contain data from Payments and will be visible to all members of this group. Reply *yes* to proceed or *no* to cancel.",
    );
  });

  test("he table returns Hebrew text", () => {
    expect(formatSystemMessage("he", "rate_limit_burst")).toBe(
      "חריגה ממגבלת הקצב. נסו שוב בעוד רגע.",
    );
  });

  test("unknown locale falls back to en", () => {
    expect(formatSystemMessage("fr" as MessageLocale, "rate_limit_burst")).toBe(
      "Rate limit exceeded. Try again shortly.",
    );
  });

  test("unknown key falls back to the key itself", () => {
    expect(
      formatSystemMessage("en", "nonexistent_key" as SystemMessageKey),
    ).toBe("nonexistent_key");
  });

  test("missing params leave the placeholder intact", () => {
    expect(formatSystemMessage("en", "rate_limit_daily", { count: 1 })).toBe(
      "You've used 1/{limit} messages today. Resets in {hours}h.",
    );
  });
});

describe("confirmWords", () => {
  test("English yes/no accepted in every locale", () => {
    for (const locale of MESSAGE_LOCALES) {
      expect(confirmWords(locale).yes).toContain("yes");
      expect(confirmWords(locale).no).toContain("no");
    }
  });

  test("he adds Hebrew words", () => {
    expect(confirmWords("he").yes).toContain("כן");
    expect(confirmWords("he").no).toContain("לא");
  });
});

describe("resolveLocale chain", () => {
  let tempDir: string;
  let db: Db;
  const config = { messagesLocale: "en" as MessageLocale };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-locale-test-"));
    db = new Db(path.join(tempDir, "state.db"));
    db.ensureSpace("space1");
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test("unset everywhere → en", () => {
    expect(resolveLocale(db, config, "space1")).toBe("en");
  });

  test("config default used when DB has no value", () => {
    expect(resolveLocale(db, { messagesLocale: "he" }, "space1")).toBe("he");
  });

  test("@global beats config default", () => {
    db.setSpaceConfig(GLOBAL_CONFIG_SPACE_ID, "messages.locale", "he", "test");
    expect(resolveLocale(db, config, "space1")).toBe("he");
    // also applies with no space context
    expect(resolveLocale(db, config, null)).toBe("he");
  });

  test("per-space beats @global", () => {
    db.setSpaceConfig(GLOBAL_CONFIG_SPACE_ID, "messages.locale", "he", "test");
    db.setSpaceConfig("space1", "messages.locale", "en", "test");
    expect(resolveLocale(db, config, "space1")).toBe("en");
  });

  test("invalid stored value degrades to next link", () => {
    db.setSpaceConfig("space1", "messages.locale", "fr", "test");
    expect(resolveLocale(db, config, "space1")).toBe("en");
    db.setSpaceConfig(GLOBAL_CONFIG_SPACE_ID, "messages.locale", "he", "test");
    expect(resolveLocale(db, config, "space1")).toBe("he");
    db.setSpaceConfig(GLOBAL_CONFIG_SPACE_ID, "messages.locale", "xx", "test");
    expect(resolveLocale(db, config, "space1")).toBe("en");
  });

  test("null spaceId skips the per-space link", () => {
    db.setSpaceConfig("space1", "messages.locale", "he", "test");
    expect(resolveLocale(db, config, null)).toBe("en");
  });

  test("never throws on a closed DB", () => {
    db.setSpaceConfig("space1", "messages.locale", "he", "test");
    db.close();
    expect(resolveLocale(db, { messagesLocale: "he" }, "space1")).toBe("he");
    // reopen so afterEach close() doesn't fail
    db = new Db(path.join(tempDir, "state.db"));
  });
});

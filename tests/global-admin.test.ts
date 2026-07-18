import { describe, expect, test } from "bun:test";
import { isGlobalAdmin, type WaAliasLookup } from "../src/core/global-admin.js";

const ARIE_PN = "whatsapp:972542341444@s.whatsapp.net";
const ARIE_LID = "whatsapp:24417056866472@lid";

const aliases: WaAliasLookup = {
  getWaPnForLid: (lid) =>
    lid === "24417056866472@lid" ? "972542341444@s.whatsapp.net" : null,
  getWaLidForPn: (pn) =>
    pn === "972542341444@s.whatsapp.net" ? "24417056866472@lid" : null,
};

describe("isGlobalAdmin", () => {
  test("matches exact configured id", () => {
    expect(isGlobalAdmin(ARIE_PN, { admins: ARIE_PN })).toBe(true);
  });

  test("normalizes prefixes, plus signs, and domains", () => {
    expect(isGlobalAdmin(ARIE_PN, { admins: "+972542341444" })).toBe(true);
    expect(
      isGlobalAdmin(ARIE_PN, { dmAutoSpaceAdminIds: "972542341444" }),
    ).toBe(true);
  });

  test("rejects non-admin caller", () => {
    expect(
      isGlobalAdmin("whatsapp:15550001111@s.whatsapp.net", {
        admins: "972542341444",
      }),
    ).toBe(false);
  });

  test("LID-configured admin matches phone-JID caller via alias lookup", () => {
    expect(
      isGlobalAdmin(
        ARIE_PN,
        { dmAutoSpaceAdminIds: "24417056866472" },
        aliases,
      ),
    ).toBe(true);
  });

  test("phone-configured admin matches LID caller via alias lookup", () => {
    expect(
      isGlobalAdmin(ARIE_LID, { dmAutoSpaceAdminIds: "972542341444" }, aliases),
    ).toBe(true);
  });

  test("LID-configured admin does not match phone caller without aliases", () => {
    expect(
      isGlobalAdmin(ARIE_PN, { dmAutoSpaceAdminIds: "24417056866472" }),
    ).toBe(false);
  });

  test("unknown alias pair still rejects", () => {
    expect(
      isGlobalAdmin(
        "whatsapp:15550001111@s.whatsapp.net",
        { dmAutoSpaceAdminIds: "24417056866472" },
        aliases,
      ),
    ).toBe(false);
  });

  test("non-whatsapp caller never consults aliases", () => {
    expect(
      isGlobalAdmin(
        "telegram:12345",
        { dmAutoSpaceAdminIds: "12345" },
        aliases,
      ),
    ).toBe(true);
  });
});

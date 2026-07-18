/**
 * Matching of caller identities against configured user ids
 * (`config.admins`, `config.dmAutoSpaceAdminIds`).
 *
 * Configured ids come in loose formats (bare digits, `+` prefix, with or
 * without platform prefix / domain suffix), while callers arrive as full
 * canonical ids (e.g. `whatsapp:972542341444@s.whatsapp.net`). WhatsApp adds
 * a second wrinkle: older configs may list the LID digits while callers are
 * canonicalized to their phone JID (or vice versa when no mapping was known
 * at config time). When an alias lookup is provided, the caller's learned
 * LID↔phone counterpart from `wa_identity_aliases` is matched too.
 */

/** Subset of Db used to resolve WhatsApp LID↔phone pairs. */
export interface WaAliasLookup {
  getWaPnForLid(lid: string): string | null;
  getWaLidForPn(pn: string): string | null;
}

const normalize = (s: string) =>
  s
    .replace(/^[^:]+:/, "")
    .replace(/^[+]+/, "")
    .replace(/@.*$/, "");

/**
 * Check whether a caller matches any id in a configured list, tolerating
 * format differences (prefix, `+`, domain) and — with an alias lookup —
 * the WhatsApp LID↔phone split.
 */
export function matchesConfiguredId(
  callerId: string,
  configuredIds: string[],
  aliases?: WaAliasLookup,
): boolean {
  if (configuredIds.length === 0) return false;

  const callerCandidates = new Set([normalize(callerId)]);

  if (aliases) {
    const jid = callerId.replace(/^[^:]+:/, "");
    if (jid.endsWith("@s.whatsapp.net")) {
      const lid = aliases.getWaLidForPn(jid);
      if (lid) callerCandidates.add(normalize(lid));
    } else if (jid.endsWith("@lid")) {
      const pn = aliases.getWaPnForLid(jid);
      if (pn) callerCandidates.add(normalize(pn));
    }
  }

  return configuredIds.some((id) => callerCandidates.has(normalize(id)));
}

/**
 * Check if a caller is a global admin (configured in mercury.yaml / env).
 * Global admins are identified by `config.admins` and `config.dmAutoSpaceAdminIds`.
 */
export function isGlobalAdmin(
  callerId: string,
  config: { admins?: string; dmAutoSpaceAdminIds?: string },
  aliases?: WaAliasLookup,
): boolean {
  const globalAdmins = [
    ...(config.admins
      ? config.admins
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : []),
    ...(config.dmAutoSpaceAdminIds
      ? config.dmAutoSpaceAdminIds
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : []),
  ];

  return matchesConfiguredId(callerId, globalAdmins, aliases);
}

/**
 * Check if a caller is a global admin (configured in mercury.yaml / env).
 * Global admins are identified by `config.admins` and `config.dmAutoSpaceAdminIds`.
 * Platform-specific ID prefixes, + signs, and @domain suffixes are normalized.
 *
 * WhatsApp callers arrive canonicalized to their phone JID, but older configs
 * may still list the LID digits (or vice versa when no mapping was known at
 * config time). When an alias lookup is provided, the caller's learned
 * LID↔phone counterpart is matched against the configured ids too.
 */

/** Subset of Db used to resolve WhatsApp LID↔phone pairs. */
export interface WaAliasLookup {
  getWaPnForLid(lid: string): string | null;
  getWaLidForPn(pn: string): string | null;
}

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

  const normalize = (s: string) =>
    s
      .replace(/^[^:]+:/, "")
      .replace(/^[+]+/, "")
      .replace(/@.*$/, "");

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

  return globalAdmins.some(
    (id) => id === callerId || callerCandidates.has(normalize(id)),
  );
}

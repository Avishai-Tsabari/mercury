import { jidNormalizedUser } from "@whiskeysockets/baileys";

/**
 * WhatsApp canonical caller identity.
 *
 * WhatsApp non-deterministically identifies the same person by either their
 * phone-number JID (`<digits>@s.whatsapp.net`) or an anonymized LID
 * (`<digits>@lid`). Everything here resolves an inbound identity to its
 * phone form whenever a mapping is known, so downstream consumers
 * (callerId, thread ids, spaces, roles, extensions) see one stable identity.
 *
 * Resolution priority:
 *   1. Message-key alt field (`remoteJidAlt` / `participantAlt`)
 *   2. Baileys' internal LID store (`signalRepository.lidMapping`) — async only
 *   3. Mercury's persisted alias table (via WaAliasStore)
 *   4. No mapping → keep the LID (consistent, self-heals once a pair is learned)
 *
 * A LID's digits are NOT a phone number — a pair may only come from Baileys.
 */

/** Narrow persistence interface so the adapter never imports Db directly. */
export interface WaAliasStore {
  getPnForLid(lid: string): string | null;
  learn(lid: string, pn: string, source: string): void;
}

export function isLidJid(jid: string): boolean {
  return jid.endsWith("@lid");
}

export function isPnJid(jid: string): boolean {
  return jid.endsWith("@s.whatsapp.net");
}

/** Strip device suffixes (`123:45@s.whatsapp.net`) so variants compare equal. */
export function normalizeJid(jid: string): string {
  try {
    return jidNormalizedUser(jid) || jid;
  } catch {
    return jid;
  }
}

export interface CanonicalJid {
  /** The identity to use everywhere downstream. */
  canonical: string;
  /** The normalized input jid (differs from canonical when a mapping applied). */
  original: string;
  changed: boolean;
}

function unchanged(jid: string): CanonicalJid {
  return { canonical: jid, original: jid, changed: false };
}

/**
 * Synchronous canonicalization: key alt field + alias store only.
 * Learns the pair whenever the key carries both forms. Never throws —
 * a malformed key must never crash the Baileys message loop.
 */
export function canonicalizeJidSync(
  rawJid: string | null | undefined,
  altJid: string | null | undefined,
  aliasStore?: WaAliasStore,
): CanonicalJid {
  if (!rawJid) return unchanged(rawJid ?? "");
  try {
    const raw = normalizeJid(rawJid);
    const alt = altJid ? normalizeJid(altJid) : undefined;

    if (!isLidJid(raw)) {
      // Already canonical. If the key also carries the LID form, learn it so
      // future LID-tagged messages resolve even without an alt field.
      if (isPnJid(raw) && alt && isLidJid(alt)) {
        aliasStore?.learn(alt, raw, "key-alt");
      }
      return unchanged(raw);
    }

    if (alt && isPnJid(alt)) {
      aliasStore?.learn(raw, alt, "key-alt");
      return { canonical: alt, original: raw, changed: true };
    }

    const mapped = aliasStore?.getPnForLid(raw);
    if (mapped && isPnJid(mapped)) {
      return { canonical: normalizeJid(mapped), original: raw, changed: true };
    }

    return unchanged(raw);
  } catch {
    return unchanged(rawJid);
  }
}

/**
 * Full canonicalization: sync chain first, then Baileys' async LID store.
 * `lidLookup` wraps `sock.signalRepository.lidMapping.getPNForLID`.
 */
export async function canonicalizeJid(
  rawJid: string | null | undefined,
  altJid: string | null | undefined,
  aliasStore?: WaAliasStore,
  lidLookup?: (lid: string) => Promise<string | null>,
): Promise<CanonicalJid> {
  const sync = canonicalizeJidSync(rawJid, altJid, aliasStore);
  if (sync.changed || !isLidJid(sync.canonical) || !lidLookup) return sync;

  try {
    const mapped = await lidLookup(sync.canonical);
    if (mapped && isPnJid(normalizeJid(mapped))) {
      const pn = normalizeJid(mapped);
      aliasStore?.learn(sync.canonical, pn, "lid-mapping");
      return { canonical: pn, original: sync.canonical, changed: true };
    }
  } catch {
    // Lookup failure degrades to the LID — never crash the message loop.
  }
  return sync;
}

/** The subset of a Baileys message key this module reads. */
export interface WaKeyLike {
  remoteJid?: string | null;
  remoteJidAlt?: string | null;
  participant?: string | null;
  participantAlt?: string | null;
}

export interface ResolvedIdentities {
  /** Canonical sender jid (participant in groups, chat peer in DMs). */
  sender: CanonicalJid;
  /** Canonical chat jid. Group jids (`@g.us`) are never rewritten. */
  chat: CanonicalJid;
}

/**
 * Resolve both identities on an inbound key, async (full chain).
 * Group chat jids pass through untouched; group participants are
 * canonicalized exactly like DM senders.
 */
export async function resolveKeyIdentities(
  key: WaKeyLike,
  aliasStore?: WaAliasStore,
  lidLookup?: (lid: string) => Promise<string | null>,
): Promise<ResolvedIdentities> {
  const remoteJid = key.remoteJid ?? "";
  const isGroup = remoteJid.endsWith("@g.us");

  const chat = isGroup
    ? unchanged(remoteJid)
    : await canonicalizeJid(remoteJid, key.remoteJidAlt, aliasStore, lidLookup);

  const sender = key.participant
    ? await canonicalizeJid(
        key.participant,
        key.participantAlt,
        aliasStore,
        lidLookup,
      )
    : chat;

  return { sender, chat };
}

/** Sync variant of {@link resolveKeyIdentities} (key alts + alias store only). */
export function resolveKeyIdentitiesSync(
  key: WaKeyLike,
  aliasStore?: WaAliasStore,
): ResolvedIdentities {
  const remoteJid = key.remoteJid ?? "";
  const isGroup = remoteJid.endsWith("@g.us");

  const chat = isGroup
    ? unchanged(remoteJid)
    : canonicalizeJidSync(remoteJid, key.remoteJidAlt, aliasStore);

  const sender = key.participant
    ? canonicalizeJidSync(key.participant, key.participantAlt, aliasStore)
    : chat;

  return { sender, chat };
}

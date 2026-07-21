/**
 * Runtime console hygiene for the libsignal dependency (transitive via Baileys).
 *
 * libsignal writes directly to the global console — bypassing the silenced
 * Baileys logger — and several of those calls dump entire SessionEntry objects,
 * including ratchet private keys and root keys, into the service log
 * (session_record.js: "Opening session:", "Closing session:", ...).
 *
 * Mercury is a published package, so patching node_modules (bun patch /
 * patch-package) would not reach installed copies. Instead we wrap the global
 * console methods libsignal uses with two deterministic layers:
 *
 * 1. Prefix suppression — calls whose first argument is a known libsignal
 *    session message are dropped entirely.
 * 2. Shape redaction — any argument that structurally looks like a Signal
 *    SessionEntry/SessionRecord is replaced with a placeholder, as a backstop
 *    for call sites we don't know about.
 *
 * All other console traffic passes through untouched.
 */

/** Known libsignal messages (session_record.js / session_builder.js). */
const SUPPRESSED_PREFIXES = [
  "Opening session:",
  "Closing session:",
  "Session already open",
  "Session already closed",
  "Removing old closed session:",
  "Migrating session to:",
  "Closing open session in favor of incoming prekey bundle",
  "Closing stale open session for new outgoing prekey bundle",
];

const REDACTED = "[libsignal session redacted]";

function isSessionLike(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  // SessionEntry: currentRatchet + indexInfo (+ _chains); SessionRecord: sessions map + version.
  if ("currentRatchet" in obj && "indexInfo" in obj) return true;
  if ("_chains" in obj && "registrationId" in obj) return true;
  if ("sessions" in obj && "version" in obj && "haveOpenSession" in obj)
    return true;
  return false;
}

export function filterConsoleArgs(args: unknown[]): unknown[] | null {
  const first = args[0];
  if (
    typeof first === "string" &&
    SUPPRESSED_PREFIXES.some((p) => first.startsWith(p))
  ) {
    return null;
  }
  let changed = false;
  const out = args.map((arg) => {
    if (isSessionLike(arg)) {
      changed = true;
      return REDACTED;
    }
    return arg;
  });
  return changed ? out : args;
}

type ConsoleMethod = (...args: unknown[]) => void;

// Tracks wrapper functions so install is idempotent per method: a method whose
// current function is already one of our wrappers is left alone, while a
// method that was replaced (e.g. restored in a test) gets re-wrapped.
const wrappers = new WeakSet<ConsoleMethod>();

/**
 * Wrap the global console methods libsignal writes to. Idempotent; call
 * before creating the WhatsApp socket.
 */
export function installLibsignalConsoleFilter(): void {
  for (const method of ["debug", "log", "info", "warn", "error"] as const) {
    const current: ConsoleMethod = console[method];
    if (wrappers.has(current)) continue;
    const original = current.bind(console);
    const wrapper: ConsoleMethod = (...args: unknown[]) => {
      const filtered = filterConsoleArgs(args);
      if (filtered === null) return;
      original(...filtered);
    };
    wrappers.add(wrapper);
    console[method] = wrapper;
  }
}

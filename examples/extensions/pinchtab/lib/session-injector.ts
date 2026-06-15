/**
 * Browser session injector for pinchtab.
 *
 * Reads MERCURY_BROWSER_SESSIONS from env at module load, parses the base64
 * JSON manifest into an in-memory map, and exposes injectSessionIfPresent()
 * which injects cookies + localStorage via pinchtab's HTTP API before navigation.
 *
 * Used by the pinchtab before_container system prompt fragment — the agent is
 * instructed to call the standalone inject-and-nav binary before navigating
 * to any URL when authenticated sessions are available.
 */

export interface StorageStateCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
}

export interface StorageStateOrigin {
  origin: string;
  localStorage: Array<{ name: string; value: string }>;
}

export interface StorageState {
  cookies: StorageStateCookie[];
  origins: StorageStateOrigin[];
}

/** Extract the eTLD+1 from a URL hostname. e.g. "bank.chase.com" → "chase.com" */
export function extractDomain(urlOrHostname: string): string {
  let hostname = urlOrHostname;
  try {
    hostname = new URL(urlOrHostname).hostname;
  } catch {
    // Input was already a hostname
  }
  const parts = hostname.split(".");
  if (parts.length <= 2) return hostname;
  return parts.slice(-2).join(".");
}

/** Parse MERCURY_BROWSER_SESSIONS env var into domain → StorageState map. */
function loadSessionMap(): Map<string, StorageState> {
  const raw = process.env.MERCURY_BROWSER_SESSIONS;
  if (!raw) return new Map();

  try {
    const manifest = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as Record<string, string>;
    const map = new Map<string, StorageState>();
    for (const [domain, b64] of Object.entries(manifest)) {
      try {
        const state = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as StorageState;
        map.set(domain, state);
      } catch (e) {
        console.warn(`[session-injector] Failed to parse session for domain "${domain}":`, e);
      }
    }
    return map;
  } catch (e) {
    console.warn("[session-injector] Failed to parse MERCURY_BROWSER_SESSIONS:", e);
    return new Map();
  }
}

const sessionMap = loadSessionMap();

const PINCHTAB_BASE = `http://${process.env.BRIDGE_BIND ?? "127.0.0.1"}:${process.env.BRIDGE_PORT ?? "9867"}`;

/** Returns true if there is a saved session for this URL's domain. */
export function hasSession(url: string): boolean {
  return sessionMap.has(extractDomain(url));
}

/**
 * Inject cookies + localStorage for the URL's domain via pinchtab's HTTP API,
 * then navigate to the URL and reload so the site picks up the injected state.
 *
 * If no session is found for this domain, falls through to a plain navigate.
 * Errors during injection are logged but do not prevent navigation.
 */
export async function injectSessionIfPresent(url: string): Promise<void> {
  const domain = extractDomain(url);
  const session = sessionMap.get(domain);

  // Navigate first (creates context, sets tab)
  const navRes = await fetch(`${PINCHTAB_BASE}/navigate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  if (!navRes.ok) {
    throw new Error(`pinchtab navigate failed: ${navRes.status} ${await navRes.text()}`);
  }

  if (!session) return;

  // Inject cookies
  if (session.cookies.length > 0) {
    const cookieRes = await fetch(`${PINCHTAB_BASE}/cookies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, cookies: session.cookies }),
    });
    if (!cookieRes.ok) {
      console.warn(`[session-injector] Cookie injection partial failure for "${domain}": ${cookieRes.status}`);
    }
  }

  // Inject localStorage per origin
  for (const originEntry of session.origins) {
    if (originEntry.localStorage.length === 0) continue;
    try {
      const script = `(function(){${originEntry.localStorage
        .map((item) => `localStorage.setItem(${JSON.stringify(item.name)},${JSON.stringify(item.value)})`)
        .join(";")}})()`;
      const evalRes = await fetch(`${PINCHTAB_BASE}/evaluate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expression: script }),
      });
      if (!evalRes.ok) {
        console.warn(`[session-injector] localStorage injection failed for "${originEntry.origin}": ${evalRes.status}`);
      }
    } catch (e) {
      console.warn(`[session-injector] localStorage injection error for "${originEntry.origin}":`, e);
    }
  }

  // Reload so the site picks up injected cookies + localStorage
  try {
    await fetch(`${PINCHTAB_BASE}/evaluate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expression: "window.location.reload()" }),
    });
  } catch {
    // Non-fatal — session may still be partially usable
  }
}

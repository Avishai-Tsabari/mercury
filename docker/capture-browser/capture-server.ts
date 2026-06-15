/**
 * Thin HTTP server for the mercury-capture-browser container.
 * Playwright launches and owns Chrome — no connectOverCDP needed.
 *
 * Ports:
 *   3001 — this server (health + navigate + capture)
 *   6080 — noVNC WebSocket proxy (started by start.sh)
 */

import { chromium, type BrowserContext } from "playwright";
import { execSync } from "node:child_process";

const PORT = 3001;

function findChromiumPath(): string {
  try {
    const result = execSync("ls /ms-playwright/chromium-*/chrome-linux/chrome 2>/dev/null | head -1")
      .toString()
      .trim();
    if (result) return result;
  } catch { /* fall through */ }
  return "/ms-playwright/chromium-1169/chrome-linux/chrome";
}

let context: BrowserContext | null = null;
let browserReady = false;

async function initBrowser(): Promise<void> {
  const executablePath = findChromiumPath();
  console.log(`[capture-server] Launching Chrome: ${executablePath}`);

  const browser = await chromium.launch({
    executablePath,
    headless: false,
    env: { ...process.env, DISPLAY: ":99" },
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  context = await browser.newContext();
  await context.newPage(); // initial blank tab visible in VNC
  browserReady = true;
  console.log("[capture-server] Browser ready");
}

initBrowser().catch((err) => {
  console.error("[capture-server] Failed to launch browser:", err);
  process.exit(1);
});

Bun.serve({
  port: PORT,
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/health") {
      if (!browserReady) return Response.json({ status: "starting" }, { status: 503 });
      return Response.json({ status: "ok" });
    }

    if (req.method === "POST" && url.pathname === "/navigate") {
      if (!context) return Response.json({ error: "Browser not ready" }, { status: 503 });
      const body = await req.json<{ url?: string }>();
      if (!body.url) return Response.json({ error: "url is required" }, { status: 400 });
      try {
        const pages = context.pages();
        const page = pages[0] ?? await context.newPage();
        await page.goto(body.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        return Response.json({ ok: true, navigatedTo: body.url });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return Response.json({ error: message }, { status: 500 });
      }
    }

    if (req.method === "POST" && url.pathname === "/capture") {
      if (!context) return Response.json({ error: "Browser not ready" }, { status: 503 });
      try {
        const storageState = await context.storageState();
        // Strip localStorage — cookies alone are sufficient for auth; localStorage
        // is typically UI state and analytics that balloons the payload size.
        const filtered = { cookies: storageState.cookies, origins: [] as typeof storageState.origins };
        return Response.json({ storageStateJson: JSON.stringify(filtered) });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return Response.json({ error: `Playwright capture failed: ${message}` }, { status: 500 });
      }
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
});

console.log(`[capture-server] Listening on port ${PORT}`);

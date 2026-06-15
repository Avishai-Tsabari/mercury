---
name: pinchtab
description: Control a headless or headed Chrome browser via Pinchtab's HTTP API for web automation, scraping, form filling, navigation, screenshots, and extraction with stable accessibility refs.
metadata:
  short-description: Browser automation via Pinchtab HTTP API
---

# Pinchtab

Fast, lightweight browser control for AI agents via HTTP + accessibility tree.

**Security Note:** Pinchtab runs entirely locally. It does not contact external services, send telemetry, or exfiltrate data. However, it controls a real Chrome instance — if pointed at a profile with saved logins, agents can access authenticated sites. Always use a dedicated empty profile and set BRIDGE_TOKEN when exposing the API. See [TRUST.md](TRUST.md) for the full security model.

## Quick Start (Agent Workflow)

The 30-second pattern for browser tasks:

```bash
# 1. Start Pinchtab (runs forever, local on :9867)
pinchtab &

# 2. In your agent, follow this loop:
#    a) Navigate to a URL
#    b) Snapshot the page (get refs like e0, e5, e12)
#    c) Act on a ref (click e5, type e12 "search text")
#    d) Snapshot again to see the result
#    e) Repeat step c-d until done
```

**That's it.** Refs are stable—you don't need to re-snapshot before every action. Only snapshot when the page changes significantly.

## Mercury / Docker (required)

In the Mercury agent container, `pinchtab &` plus a short `sleep` often races the HTTP bridge: the CLI then hits `127.0.0.1:9867` before the daemon listens (`connection refused`). The host injects `CHROME_BINARY` and `CHROME_FLAGS` (`--no-sandbox` as root). **Always** wait until the port is open and capture daemon logs.

```bash
pinchtab_ensure() {
  local bind="${BRIDGE_BIND:-127.0.0.1}"
  local port="${BRIDGE_PORT:-9867}"
  local log="${PINCHTAB_LOG:-/tmp/pinchtab.log}"
  local max_wait="${1:-120}"
  mkdir -p "$(dirname "$log")" 2>/dev/null || true
  : >"$log"
  if [ ! -x "${CHROME_BINARY:-}" ]; then
    for _c in /usr/local/bin/chromium /usr/bin/chromium; do
      if [ -x "$_c" ]; then export CHROME_BINARY="$_c"; break; fi
    done
  fi
  if [ ! -x "${CHROME_BINARY:-}" ]; then
    echo "No executable Chromium (CHROME_BINARY=${CHROME_BINARY:-}; tried /usr/local/bin/chromium, /usr/bin/chromium). Rebuild mercury-agent-ext (restart Mercury)." | tee -a "$log"
    return 1
  fi
  _pinchtab_port_open() { (echo >/dev/tcp/$bind/$port) 2>/dev/null; }
  if command -v pinchtab >/dev/null 2>&1 && _pinchtab_port_open; then
    return 0
  fi
  pkill -f '[p]inchtab' 2>/dev/null || true
  nohup pinchtab >>"$log" 2>&1 &
  local pid=$!
  sleep 2
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "pinchtab exited immediately (pid $pid). Log:" >&2
    tail -120 "$log" >&2
    return 1
  fi
  local i=0
  while [ "$i" -lt "$max_wait" ]; do
    if _pinchtab_port_open; then
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "pinchtab died during startup. Log:" >&2
      tail -120 "$log" >&2
      return 1
    fi
    sleep 1
    i=$((i+1))
  done
  echo "pinchtab did not listen on $bind:$port within ${max_wait}s. Log:" >&2
  tail -120 "$log" >&2
  return 1
}
```

Use it before every navigation/snapshot/text workflow:

```bash
pinchtab_ensure || { echo "pinchtab failed — see /tmp/pinchtab.log"; exit 1; }
pinchtab nav "https://example.com"
sleep 3
pinchtab text
```

If `pinchtab_ensure` fails, show the user the tail of `/tmp/pinchtab.log`; do not only increase `sleep` and retry blindly.

### Recommended Secure Setup

```bash
# Best practice for AI agents
BRIDGE_BIND=127.0.0.1 \
BRIDGE_TOKEN="your-strong-secret" \
BRIDGE_PROFILE=~/.pinchtab/automation-profile \
pinchtab &
```

**Never expose to 0.0.0.0 without a token. Never point at your daily Chrome profile.**

## Setup

```bash
# Headless (default) — no visible window
pinchtab &

# Headed — visible Chrome window for human debugging
BRIDGE_HEADLESS=false pinchtab &

# With auth token
BRIDGE_TOKEN="your-secret-token" pinchtab &

# Custom port
BRIDGE_PORT=8080 pinchtab &
```

Default: **port 9867**, no auth required (local). Set `BRIDGE_TOKEN` for remote access.

For advanced setup, see [references/profiles.md](references/profiles.md) and [references/env.md](references/env.md).

## What a Snapshot Looks Like

After calling `/snapshot`, you get the page's accessibility tree as JSON—flat list of elements with refs:

```json
{
  "refs": [
    {"id": "e0", "role": "link", "text": "Sign In", "selector": "a[href='/login']"},
    {"id": "e1", "role": "textbox", "label": "Email", "selector": "input[name='email']"},
    {"id": "e2", "role": "button", "text": "Submit", "selector": "button[type='submit']"}
  ],
  "text": "... readable text version of page ...",
  "title": "Login Page"
}
```

Then you act on refs: `click e0`, `type e1 "user@example.com"`, `press e2 Enter`.

## Core Workflow

The typical agent loop:

1. **Navigate** to a URL
2. **Snapshot** the accessibility tree (get refs)
3. **Act** on refs (click, type, press)
4. **Snapshot** again to see results

Refs (e.g. `e0`, `e5`, `e12`) are cached per tab after each snapshot — no need to re-snapshot before every action unless the page changed significantly.

### Quick examples

```bash
pinchtab nav https://example.com
pinchtab snap -i -c                    # interactive + compact
pinchtab click e5
pinchtab type e12 hello world
pinchtab press Enter
pinchtab text                          # readable text (~1K tokens)
pinchtab text | jq .text               # pipe to jq
pinchtab ss -o page.jpg                # screenshot
pinchtab eval "document.title"         # run JavaScript
pinchtab pdf --tab TAB_ID -o page.pdf  # export PDF
```

For the full HTTP API (curl examples, download, upload, cookies, stealth, batch actions, PDF export with full parameter control), see [references/api.md](references/api.md).

## Token Cost Guide

| Method | Typical tokens | When to use |
|---|---|---|
| `/text` | ~800 | Reading page content |
| `/snapshot?filter=interactive` | ~3,600 | Finding buttons/links to click |
| `/snapshot?diff=true` | varies | Multi-step workflows (only changes) |
| `/snapshot?format=compact` | ~56-64% less | One-line-per-node, best efficiency |
| `/snapshot` | ~10,500 | Full page understanding |
| `/screenshot` | ~2K (vision) | Visual verification |
| `/tabs/{id}/pdf` | 0 (binary) | Export page as PDF (no token cost) |

**Strategy**: Start with `?filter=interactive&format=compact`. Use `?diff=true` on subsequent snapshots. Use `/text` when you only need readable content. Full `/snapshot` only when needed.

## Agent Optimization

**Validated Feb 2026**: Testing with AI agents revealed a critical pattern for reliable, token-efficient scraping.

**See the full guide:** [docs/agent-optimization.md](../../docs/agent-optimization.md)

### Quick Summary

**The 3-second pattern** — wait after navigate before snapshot:

```bash
curl -X POST http://localhost:9867/navigate \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com"}' && \
sleep 3 && \
curl http://localhost:9867/snapshot | jq '.nodes[] | select(.name | length > 15) | .name'
```

**Token savings:** 93% reduction (3,842 → 272 tokens) when using prescriptive instructions vs. exploratory agent approach.

For detailed findings, system prompt templates, and site-specific notes, see [docs/agent-optimization.md](../../docs/agent-optimization.md).

## Tips

- **Always pass `tabId` explicitly** when working with multiple tabs
- Refs are stable between snapshot and actions — no need to re-snapshot before clicking
- After navigation or major page changes, take a new snapshot for fresh refs
- Pinchtab persists sessions — tabs survive restarts (disable with `BRIDGE_NO_RESTORE=true`)
- Chrome profile is persistent — cookies/logins carry over between runs
- Use `BRIDGE_BLOCK_IMAGES=true` or `"blockImages": true` on navigate for read-heavy tasks
- **Wait 3+ seconds after navigate before snapshot** — Chrome needs time to render 2000+ accessibility tree nodes

## Authenticated Browser Sessions

If the user has saved a browser session for a site (via the Browser Sessions page in the console), the agent will automatically use it when navigating to that domain. No special instructions are needed — just navigate to the URL normally. The session (cookies + localStorage) is pre-loaded into the container environment and injected transparently before the first page load on the matched domain.

Sites behind login walls (banks, airlines, HR portals, niche SaaS) can be accessed this way without any copy-pasting or API key setup. If a session seems stale or the site still shows a login screen, the user can re-capture the session from the Browser Sessions page.

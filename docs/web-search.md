# Web Search & Browsing

Web search is **extension-based** in Mercury. The base agent does not include a browser — install the `web-browser` extension to add search and browsing capabilities.

## Quick Start

```bash
mercury add web-browser
```

Or install from the dashboard's **Features** page (one click).

No API key is required. The extension uses [pinchtab](https://www.npmjs.com/package/pinchtab) to control a local headless Chromium and navigates to the public [Brave Search](https://search.brave.com) website — the same way a human would.

## What It Provides

The `web-browser` extension installs pinchtab and Playwright/Chromium into the agent container. The agent can:

- **Search the web** — navigate to Brave Search, read results
- **Browse any URL** — open pages, follow links
- **Extract text** — pull readable content from any page
- **Take snapshots** — capture the accessibility tree for structured interaction
- **Fill forms** — click elements, type into fields
- **Authenticated sessions** — log into sites using injected cookies/localStorage (configured via `MERCURY_BROWSER_SESSIONS`)

## Typical Flow

1. Start the browser daemon (`pinchtab_ensure`)
2. Navigate to a search URL or any page
3. Extract text or snapshot content
4. Summarize and cite findings

```bash
pinchtab_ensure || exit 1
pinchtab nav "https://search.brave.com/search?q=your+query"
sleep 3
pinchtab text
```

## Why Extension-Based

- Keeps Mercury core lean
- Lets each deployment pick its own browser/search stack
- Allows per-space RBAC for web tooling (`pinchtab` permission)
- Avoids locking users into one provider/tool

## Security & RBAC

Extension CLIs are called directly in bash, with RBAC enforced by Mercury's in-container permission guard. If a caller lacks the `pinchtab` permission, execution is blocked.

## Related Docs

- [Extensions](./extensions.md)
- [Pipeline](./pipeline.md)
- [Container lifecycle](./container-lifecycle.md)

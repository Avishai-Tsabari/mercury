# Context Architecture

Mercury uses a three-layer approach to give the agent the right context for every request — deterministic, bounded, and never accidentally referencing stale history.

## The Three Layers

### Layer 1 — Identity (always present)

Built by `buildSystemPrompt()` in `container-entry.ts`:

- `AGENTS.md` — the space's agent persona and instructions
- System capabilities (tools, permissions, platform)
- Moderation rules
- Memory guidance (see Layer 2)

This layer is static per space configuration.

### Layer 2 — Episodic Memory (per-space, curated)

A `MEMORY.md` file that lives in the space's workspace directory (alongside `AGENTS.md`). If it exists, it is injected as `<episodic_memory>` XML at the start of every prompt.

The agent can read and write `MEMORY.md` freely. It should use it to:
- Record significant events, decisions, or patterns
- Summarise long threads into compact notes
- Remember user preferences or recurring context
- Note anything that would be annoying to re-explain each session

Keep it concise (~1500 tokens max). Use `mrctl recall` to search the full message archive when more history is needed.

### Layer 3 — Searchable Archive (on demand)

The full message history lives in SQLite and is searchable via `mrctl recall <query>`. The agent uses this explicitly when it needs to look up something specific from the past.

The sliding window (see below) makes the most recent history available automatically — `mrctl recall` is for reaching further back.

---

## Per-Request Context

Every request runs with `--no-session` (no pi session file). Continuity across requests comes from:

1. **Sliding window** — the last N user+assistant turn pairs fetched from SQLite via `getRecentTurns(spaceId, 10)`, injected as `<history>` XML
2. **MEMORY.md** — injected as `<episodic_memory>` if it exists
3. **Ambient messages** — platform-sourced messages (e.g., thread context) passed separately

The session boundary (`chat_state.min_message_id`) excludes messages older than the last `compact` call from the sliding window. Run `mrctl compact` to reset the boundary and start fresh.

### Prompt structure (inside container)

```
<system>
  [identity: AGENTS.md + capabilities + memory guidance]
</system>

<caller>…</caller>
<episodic_memory>…</episodic_memory>   ← MEMORY.md (if present)
<history>                               ← sliding window from DB
  <turn timestamp="…">
    <user>…</user>
    <assistant>…</assistant>
  </turn>
  …
</history>
<ambient_messages>…</ambient_messages>
<preferences>…</preferences>
<attachments>…</attachments>

[user prompt text]
```

---

## Why Not a Pi Session File?

Pi session files (`.mercury.session.jsonl`) are pi's intra-run working memory — essential for tracking tool calls within a single agent run. But accumulating them across separate user requests causes problems:

- The session file grows unbounded
- Loading it on every request exposes the agent to the entire conversation history
- The agent unexpectedly references old requests

By always using `--no-session`, each run starts clean. Cross-request continuity comes from the explicit, bounded sliding window instead.

---

## Compact

`mrctl compact` (or `POST /api/compact`) sets the session boundary to the latest message ID. Messages older than this boundary are excluded from the sliding window, so the agent starts with a clean slate while the archive remains searchable via `mrctl recall`.

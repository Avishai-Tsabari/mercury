# PRD: Chat-managed space preferences

**Status:** Implemented  
**Area:** Per-space assistant preferences (SQLite, API, `mrctl`, prompt injection)  
**Related:** [memory.md](memory.md), [permissions.md](permissions.md)

---

## 1. Problem

Users want to **change how the assistant behaves** (preferred data sources, tone, domain rules) **from chat** without editing files on disk. Today, durable instructions live mainly in space `AGENTS.md` or extension vaults; there is no small, structured store the agent can update via `mrctl` and that the host **always** surfaces on the next turn.

## 2. Goals

1. **Space-scoped preferences** — key/value text attached to a space, shared by all conversations linked to that space (v1).
2. **Chat management** — the agent uses **`mrctl prefs`** to list, read, set, and delete preferences (same pattern as `mrctl config`).
3. **Automatic application** — the host loads preferences for the current space and injects them into the **user prompt context** (XML) on every container run so the model sees them without calling tools first.
4. **RBAC** — members can read preferences; only callers with **`prefs.set`** (default: admin) can create, update, or delete.
5. **Dashboard** — operators can view and edit preferences on the space detail page.

## 3. Non-goals (explicit)

- **Per-user** or **per-conversation** preference rows in v1 (schema may be extended later, e.g. optional `caller_id`).
- **Natural-language-only** management without the agent invoking `mrctl` (no dedicated NLU layer).
- **Secrets** in preference values — values are plain text; operators should not store API keys here.

## 4. Functional requirements

| ID | Requirement |
|----|----------------|
| F1 | SQLite table `space_preferences` with `(space_id, key)` primary key, `value`, `created_by`, timestamps. |
| F2 | Keys match `^[a-z0-9][a-z0-9._-]{0,63}$`; values max **500** characters; max **50** keys per space (upsert on existing key does not count toward the cap). |
| F3 | HTTP API under `/api/prefs`: `GET /` list, `GET /:key` get one, `PUT /` body `{ key, value }`, `DELETE /:key`. Uses `X-Mercury-Caller` / `X-Mercury-Space` like other internal APIs. |
| F4 | Permissions **`prefs.get`** (default: admin + member) and **`prefs.set`** (default: admin only). |
| F5 | **`mrctl prefs list|get|set|delete`** calls the API; `set` accepts multi-word values (args after key joined with spaces). |
| F6 | Built-in skill documents when to use preferences and how to name keys. |
| F7 | Host passes `preferences: { key, value }[]` in the container JSON payload; `container-entry` injects `<preferences><pref key="...">...</pref></preferences>` after caller / ambient blocks, with XML escaping for text. |
| F8 | `deleteSpace` removes all rows for that space. |
| F9 | Dashboard space page shows preferences with add + delete actions (no separate auth; dashboard remains host-local operator UI). |

## 5. Security requirements

| ID | Requirement |
|----|----------------|
| S1 | All mutating `/api/prefs` operations require **`prefs.set`**; listing/reading require **`prefs.get`**. |
| S2 | Reserved extension names include **`prefs`** and **`preferences`** so third-party extensions cannot shadow the built-in command. |
| S3 | Preference text is echoed in prompts — avoid storing highly sensitive data; length limits reduce abuse. |

## 6. Success criteria

- Member can `mrctl prefs list` / `get`; cannot `set`/`delete` without permission.
- Admin can set a preference; the **next** user message run includes it in the injected XML.
- Space deletion removes preference rows.
- `bun run check` passes (typecheck, lint, tests).

## 7. Implementation map

| Component | Location |
|-----------|----------|
| Schema + Db | `src/storage/db.ts` |
| Validation + routes | `src/core/routes/prefs.ts` |
| API mount | `src/core/api.ts` |
| Permissions | `src/core/permissions.ts` |
| Reserved names | `src/extensions/reserved.ts` |
| CLI | `src/cli/mrctl.ts` |
| Skill | `resources/skills/preferences/SKILL.md` |
| Payload + prompt | `src/core/runtime.ts`, `src/agent/container-runner.ts`, `src/agent/container-entry.ts` |
| Types | `src/types.ts` |
| Dashboard | `src/core/routes/dashboard.ts` |
| Tests | `tests/prefs.test.ts` |

## 8. Revision history

| Date | Change |
|------|--------|
| 2026-03-21 | Initial PRD (space preferences v1). |

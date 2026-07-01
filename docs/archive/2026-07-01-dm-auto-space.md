# Auto-Create Space per DM

**Status**: Done
**Slug**: dm-auto-space
**Created**: 2026-06-30
**Last updated**: 2026-07-01

---

## Goal

When Mercury serves a business (e.g. a barber shop), each customer texts from a unique phone number. Today every new DM creates a conversation with `space_id = null`, so the bot has no persistent per-customer context — it can't remember preferences, appointment history, or prior conversations. This feature adds a config-driven option to auto-create a space per customer and link their conversation to it, giving each customer an isolated, persistent context.

## User Stories

- As a business owner, I want each customer who messages my bot to automatically get their own space so the bot remembers their history across conversations.
- As a business owner, I want my own number and staff numbers to auto-link to the `main` space instead of creating new spaces.
- As a business owner, I want customers restricted to chat only — no tools, no scripts, no web search.
- As a Mercury operator, I want this behavior off by default so existing deployments are unaffected.
- As a Mercury operator, I want a global daily rate limit per role so I don't have to configure each space individually.

## MVP Scope

**In scope:**
- New `dm_auto_space` config block in `mercury.yaml` with `enabled` (default `false`), `admin_numbers` (auto-link to `main`), `default_system_prompt`, and `default_member_permissions`
- On new DM from a non-admin number: find or create a space for that phone number, **and link the conversation to it** (without linking, messages are silently dropped by the handler)
- Admin numbers auto-link their DM conversation to `main` space
- Auto-created spaces seeded with: `trigger.match = "always"`, `context.mode = "context"`, member permissions restricted to config value
- Space `display_name` derived from the sender's push name (if available) or phone number
- Returning customers hitting the same conversation get their existing space — no duplicate creation
- New global daily rate limit defaults in `mercury.yaml` (`runtime.rate_limit_daily_member`, `runtime.rate_limit_daily_admin`) — applied as fallback when no per-space override exists
- Dashboard UI: add rate limit controls to the space settings panel

**Out of scope:**
- Space merging when a customer contacts from multiple numbers — complex identity resolution, not MVP
- Auto-space for group chats — DMs only for now
- Per-bridge config (WhatsApp vs Telegram) — single global toggle for now, can be extended later

---

## Context for Claude

> Key files to read before touching anything.

- `src/config.ts` — Zod `schema` object (line 53) and `AppConfig` type; add new config fields here
- `src/config-file.ts` — `mercuryFileSchema` (Zod for YAML parsing, line 25), `flattenMercuryFile()` (line 185), and `CAMEL_TO_ENV` (line 280); add the YAML blocks + env mappings here
- `src/core/conversation.ts` — `resolveConversation()` (line 9) returns `null` when `space_id` is null; this is the hook point for auto-create + link
- `src/core/handler.ts` — `createMessageHandler()` (line 17) calls `resolveConversation()` at line 50; needs to pass config + db context for auto-space logic
- `src/storage/db.ts` — `ensureSpace()` (line 334), `linkConversation()` (line 611), `ensureConversation()` (line 471), `setSpaceConfig()`, `getSpaceConfig()`; space IDs must match `/^[a-z0-9][a-z0-9-]*$/`
- `src/core/runtime.ts` — daily role-based rate limit check (line 397); burst rate limit fallback (line 424); needs fallback to new global daily rate limit config
- `src/core/routes/dashboard.ts` — space settings panels (trigger, context); add rate limit panel here
- `src/core/routes/config-builtin.ts` — `BUILTIN_CONFIG_KEYS` and `BUILTIN_CONFIG_DESCRIPTIONS`; add `rate_limit`, `rate_limit.member`, `rate_limit.admin` here so dashboard can manage them
- `src/storage/memory.ts` — `ensureSpaceWorkspace()` (line 27) creates per-space dirs with empty `AGENTS.md`; already called lazily at container execution time (runtime.ts line 1142), no changes needed

---

## Architecture & Data

### Data Models

No schema changes. Uses existing tables:

- `spaces` — auto-created via `db.ensureSpace(spaceId)` with a derived slug
- `conversations` — linked via `db.linkConversation(conversationId, spaceId)`
- `space_config` — seeded with trigger, context, rate limit, permissions, and system prompt defaults on auto-created spaces

**Space ID derivation:** Phone numbers (e.g. `972501234567@s.whatsapp.net`) must be converted to valid space IDs matching `/^[a-z0-9][a-z0-9-]*$/`. Strategy: strip the `@s.whatsapp.net` suffix and prefix with `dm-` → `dm-972501234567`. For other platforms: `dm-{platform}-{sanitized-external-id}`.

**Space display name:** Use the sender's push name if available from the message, otherwise fall back to the phone number.

### Config Shape

```yaml
# mercury.yaml

# --- Part 1: Auto-space for DMs ---
dm_auto_space:
  enabled: false                              # default off
  admin_numbers:                              # auto-link to "main" instead of creating a new space
    - "972501234567"
  default_system_prompt: "You are a barber shop assistant..."  # optional, seeded into space_config
  default_member_permissions: "prompt,prefs.get"               # restrict customers to chat only

# --- Part 2: Global daily rate limits (independent of dm_auto_space) ---
runtime:
  rate_limit_daily_member: 20                 # NEW — global default daily cap for members, 0 = unlimited
  rate_limit_daily_admin: 0                   # NEW — global default daily cap for admins, 0 = unlimited
```

**Part 1 — dm_auto_space config keys:**
- `dmAutoSpaceEnabled` → `MERCURY_DM_AUTO_SPACE_ENABLED` (boolean, default `false`)
- `dmAutoSpaceAdminNumbers` → `MERCURY_DM_AUTO_SPACE_ADMIN_NUMBERS` (comma-separated string, default `""`)
- `dmAutoSpaceDefaultSystemPrompt` → `MERCURY_DM_AUTO_SPACE_DEFAULT_SYSTEM_PROMPT` (string, default `""`)
- `dmAutoSpaceDefaultMemberPermissions` → `MERCURY_DM_AUTO_SPACE_DEFAULT_MEMBER_PERMISSIONS` (string, default `"prompt,prefs.get"`)

**Part 2 — global daily rate limit config keys:**
- `rateLimitDailyMember` → `MERCURY_RATE_LIMIT_DAILY_MEMBER` (number, default `0` = unlimited)
- `rateLimitDailyAdmin` → `MERCURY_RATE_LIMIT_DAILY_ADMIN` (number, default `0` = unlimited)

### Space seeding on auto-create

When a new customer space is created, the following `space_config` keys are seeded:

| Key | Value | Why |
|-----|-------|-----|
| `trigger.match` | `"always"` | Bot responds to every message in DMs |
| `context.mode` | `"context"` | Bot remembers conversation history |
| `role.member.permissions` | from `default_member_permissions` config | Restrict customers to chat only |
| `system_prompt` | from `default_system_prompt` config (if set) | Customer-facing persona |
| `rate_limit.member` | from `rate_limit_daily_member` config (if >0) | Daily cap seeded from global default |

### Global daily rate limit fallback

In `runtime.ts` line 397, the daily role-based rate check currently reads `rate_limit.{role}` from `space_config` only. When the key is null (not set per-space), it currently skips the daily check entirely. Change: when the per-space key is null, fall back to the new global config value (`rateLimitDailyMember` / `rateLimitDailyAdmin`). A value of `0` means unlimited (skip check), which is the default — preserving backward compatibility.

### API Contracts

No new API endpoints. Auto-created spaces are fully managed through the existing space API (`/api/spaces`, `/api/conversations/:id/link`). Rate limits are managed via the existing `POST /dashboard/api/space-config` endpoint.

### Dashboard: Rate limit panel

Add a new "Rate Limits" section to the space settings page in `dashboard.ts`, following the same pattern as the Trigger and Context panels. Fields:

| Label | Config key | Input | Notes |
|-------|-----------|-------|-------|
| Burst rate limit | `rate_limit` | number input | Per-user per-minute, falls back to global `rate_limit_per_user` |
| Daily member limit | `rate_limit.member` | number input | Per-user per-day, falls back to global `rate_limit_daily_member` |
| Daily admin limit | `rate_limit.admin` | number input | Per-user per-day, falls back to global `rate_limit_daily_admin` |

Each row shows the effective value (per-space override or global default) and a "Reset" button to clear the override.

Requires adding `rate_limit`, `rate_limit.member`, `rate_limit.admin` to `BUILTIN_CONFIG_KEYS`, `BUILTIN_CONFIG_DESCRIPTIONS`, and validators in `config-builtin.ts`.

### File & Folder Structure

| Path | New / Modified | Purpose |
|------|---------------|---------|
| `src/config-file.ts` | Modified | Add `dm_auto_space` and `runtime.rate_limit_daily_*` to YAML schema, flatten, env mappings |
| `src/config.ts` | Modified | Add all new config fields to Zod schema |
| `src/core/conversation.ts` | Modified | Add auto-space + admin-link logic in `resolveConversation()` |
| `src/core/handler.ts` | Modified | Thread auto-space config into `resolveConversation()` call |
| `src/core/runtime.ts` | Modified | Add global daily rate limit fallback in `handleRawInput()` |
| `src/core/routes/dashboard.ts` | Modified | Add rate limit settings panel to space page |
| `src/core/routes/config-builtin.ts` | Modified | Add rate limit keys to builtin config set |
| `resources/templates/mercury.example.yaml` | Modified | Add commented dm_auto_space section and rate_limit_daily_* |
| `tests/dm-auto-space.test.ts` | New | Unit tests for auto-space flow |
| `tests/global-daily-rate-limit.test.ts` | New | Unit tests for global daily rate limit fallback |

### Implementation Sequence

1. **Add config fields** — Add `dm_auto_space` block and `runtime.rate_limit_daily_*` to `mercuryFileSchema` in `config-file.ts`, flatten in `flattenMercuryFile()`, add env mappings to `CAMEL_TO_ENV`, and add all new fields to the Zod schema in `config.ts`.
   - Read first: `src/config-file.ts`, `src/config.ts`
   - Verify: `bun run typecheck` passes

2. **Add global daily rate limit fallback** — In `runtime.ts` `handleRawInput()`, when `rate_limit.{role}` is not set per-space, fall back to `config.rateLimitDailyMember` / `config.rateLimitDailyAdmin` instead of skipping.
   - Read first: `src/core/runtime.ts` (lines 395-430)
   - Verify: `bun run typecheck` passes
   - Blocker: Step 1 (config fields must exist)

3. **Add rate limit to dashboard + config-builtin** — Add `rate_limit`, `rate_limit.member`, `rate_limit.admin` to `BUILTIN_CONFIG_KEYS` and `BUILTIN_CONFIG_DESCRIPTIONS` in `config-builtin.ts`. Add a rate limit panel to the space page in `dashboard.ts` following the trigger/context panel pattern.
   - Read first: `src/core/routes/config-builtin.ts`, `src/core/routes/dashboard.ts` (trigger panel ~line 250, context panel ~line 345)
   - Verify: `bun run typecheck` passes
   - Blocker: Step 1 (need global defaults to show "project default" label)

4. **Implement auto-space logic in `resolveConversation()`** — When `conversation.spaceId` is null AND kind is `"dm"` AND config has `dmAutoSpaceEnabled: true`:
   - If sender is in `admin_numbers`: link conversation to `"main"`, return resolution
   - Otherwise: derive space ID (`dm-{sanitized-id}`), call `db.ensureSpace()`, seed `space_config` keys (trigger, context, permissions, system prompt, rate limit), call `db.linkConversation()`, return resolution
   - Read first: `src/core/conversation.ts`, `src/core/handler.ts`, `src/storage/db.ts`
   - Verify: `bun run typecheck` passes
   - Blocker: Steps 1-2 (config fields and rate limit fallback must exist)

5. **Thread config and author name through the call chain** — `resolveConversation()` currently takes `(db, platform, externalId, kind, observedTitle?)`. Add an `autoSpaceConfig` parameter with `{ enabled, adminNumbers, defaultSystemPrompt, defaultMemberPermissions, rateLimitDailyMember }` and an `authorName` parameter. The handler passes config from `config` and author name from `message.author.userName` (available before `resolveConversation` is called; set by WhatsApp adapter from `pushName`). Author name is used for the space display name.
   - Read first: `src/core/handler.ts` (line 50 where resolveConversation is called), `src/adapters/whatsapp.ts` (line 497, 576 — `userName`/`fullName` set from pushName)
   - Verify: `bun run typecheck` passes

6. **Write tests** — Test the auto-space flow: enabled + non-admin → space created + linked + config seeded; admin number → linked to main; disabled → returns null; returning customer → reuses existing space. Test global daily rate limit fallback: per-space set → uses per-space; per-space not set → uses global; global is 0 → unlimited.
   - Read first: existing test files in `tests/` for patterns
   - Verify: `bun test` passes

7. **Update example config** — Add commented `dm_auto_space` section and `rate_limit_daily_*` to `resources/templates/mercury.example.yaml`.
   - Read first: `resources/templates/mercury.example.yaml`
   - Verify: file contains the new sections

---

## Non-Negotiable Rules

- **Default off** — `dm_auto_space.enabled` must default to `false`. Existing deployments must not change behavior.
- **Admin numbers link to main** — admin numbers are auto-linked to the `main` space, never dropped. They never create a new space.
- **Customer permissions are locked down** — auto-created spaces seed `role.member.permissions` from config (default `"prompt,prefs.get"`), stripping all extension tool access.
- **Space ID format** — derived IDs must always pass the `/^[a-z0-9][a-z0-9-]*$/` regex. Strip all characters that don't match.
- **No data loss** — auto-created spaces are regular spaces. Deleting them via the existing API unlinks conversations (FK ON DELETE SET NULL), which is the correct behavior.
- **Idempotent** — `ensureSpace()` already does INSERT OR IGNORE. Space config seeding must use a read-before-write pattern (`getSpaceConfig` check before `setSpaceConfig`) because `setSpaceConfig` uses `ON CONFLICT DO UPDATE` which would overwrite manual overrides.
- **Backward compatible rate limits** — global daily rate limit defaults to `0` (unlimited), preserving existing behavior for all deployments.

---

## Edge Cases & Risks

| Scenario | Handling |
|----------|---------|
| Same customer sends multiple messages before first one is processed | `ensureSpace()` is idempotent (INSERT OR IGNORE); `linkConversation()` is an UPDATE — safe for concurrent calls. Space config seeding uses read-before-write (`getSpaceConfig` → `setSpaceConfig` only if null), so first write wins and subsequent messages don't overwrite. |
| Customer number produces an invalid space ID (starts with dash, etc.) | Sanitize: strip `@...` suffix, prefix with `dm-`, remove non-alphanumeric chars except hyphens |
| Admin numbers in different formats (+972 vs 972 vs 972...@s.whatsapp.net) | Normalize: strip leading `+`, strip `@s.whatsapp.net` suffix before comparison |
| Admin links a DM conversation to a different space manually | `resolveConversation()` only auto-creates when `spaceId` is null — if already linked, uses the existing link |
| Feature is enabled then disabled | Existing auto-created spaces and links remain; new DMs from unknown numbers go back to being dropped |
| Admin overrides rate limit per space via dashboard | Per-space value takes precedence over global default; "Reset" button clears override to fall back to global |
| Very large number of unique customers | Each gets a space row + workspace dir + space_config entries. Acceptable for MVP; monitoring via `listSpaces()` count |
| `main` space doesn't exist when admin number messages | `ensureSpace("main")` is called at runtime boot (runtime.ts line 88); always exists |
| Race in space config seeding (read-before-write) | Two concurrent messages could both read null and both write. `setSpaceConfig` uses `ON CONFLICT DO UPDATE` so second write wins — acceptable since both write the same default values. The race only matters if an admin manually changed the config between the two messages, which is vanishingly unlikely during the first-message window. |
| Push name not available (e.g., privacy settings) | Fall back to phone number as space display name. `message.author.userName` may be just the JID prefix — acceptable for MVP. |

---

## Implementation Checklist

### Phase 1 — Goal (fill before asking for approval)
- [x] Goal, User Stories, and MVP Scope written and reviewed

### Phase 2 — Architecture (fill after Goal approved)
- [x] Architecture & Data section complete
- [x] Non-Negotiable Rules defined
- [x] Edge Cases covered
- [x] Context for Claude pointers filled in

### Implementation (tick off as you go)
- [x] Step 1 — Add config fields to `config-file.ts` and `config.ts`
- [x] Step 2 — Add global daily rate limit fallback in `runtime.ts`
- [x] Step 3 — Add rate limit to dashboard + config-builtin
- [x] Step 4 — Implement auto-space logic in `resolveConversation()`
- [x] Step 5 — Thread config through handler → resolveConversation call chain
- [x] Step 6 — Write tests
- [x] Step 7 — Update example config
- [x] `bun run check` passes
- [x] No secrets or `.env` files committed
- [x] No unrelated files modified
- [x] All user stories verifiably met

---

## Open Questions

- [x] Config key naming — confirmed: `dm_auto_space: { enabled, admin_numbers, default_system_prompt, default_member_permissions }`
- [x] Should `exclude` match exact numbers or support patterns/wildcards? — exact phone numbers only
- [x] What happens to excluded/admin numbers? — auto-linked to `main`, not dropped
- [x] How to restrict customer tools? — seed `role.member.permissions` via `default_member_permissions` config
- [x] How to set trigger mode? — auto-seeded `trigger.match = "always"` on customer spaces
- [x] Global daily rate limits? — added to `runtime` config block, per-space dashboard override on top

---

## Retrospective

> Fill this section when archiving.

**Residual risks / follow-ups:**
- Per-space AGENTS.md for auto-created spaces is empty by default; the global AGENTS.md applies but a dedicated customer-facing template could improve quality — accepted
- Business logic (appointment booking, etc.) must be handled by dedicated business extensions with deterministic code, NOT via LLM prompting → ideas/business-extensions.md

**What changed from the plan:**
- Steps 4 and 5 (auto-space logic + config threading) implemented together as they are tightly coupled
- Added `.toLowerCase()` to `deriveSpaceId` for future non-numeric platform IDs (caught in code review)
- `memory.ts` removed from modified files list — `ensureSpaceWorkspace` is already called lazily at container execution time

**Key decisions made during implementation:**
- Used `seedSpaceConfigIfAbsent` helper (read-before-write) instead of raw `setSpaceConfig` to avoid overwriting manual admin overrides
- Author name sourced from `message.author.userName` (set from WhatsApp pushName) before `resolveConversation` — available before bridge normalization

**Architecture impact** (update `docs/ARCHITECTURE.md` if any of these apply):
- [ ] New package/module added
- [ ] New data model or schema change
- [ ] New inter-package interaction
- [ ] Deployment topology changed

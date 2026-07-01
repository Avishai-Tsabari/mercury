# Authoring Applicative Profiles

The contract for building a **profile** — a package of deterministic business
logic that wraps raw capabilities (Calendar, email, …) and scopes what members
can do. Mercury (this repo) provides the schema, loader, permission scoping, and
the host-side capability broker; **profiles live in a separate repo** and depend
only on this contract.

> Layers: **Mercury** = platform (messaging, spaces, permissions, tokens,
> broker). **Capability extensions** = raw API access (e.g. `gws`), admin-only.
> **Profiles** = deterministic domain logic wrapping capabilities, member-facing.

## 1. Profile manifest — `mercury-profile.yaml`

```yaml
name: barber-appointments            # lowercase-kebab; required
description: Appointment booking for a barber shop
version: 0.1.0

agents_md: ./AGENTS.md               # optional; copied to the global AGENTS.md

# Raw capability extensions this profile requires to be installed. Validated at
# apply time — activation fails loudly if any are missing.
capabilities:
  - gws

# Extensions this profile ships (copied into .mercury/extensions).
extensions:
  - name: barber
    source: ./extensions/barber

# EXHAUSTIVE member permission set while active. When present it REPLACES the
# default member permissions — nothing is merged in — so raw capabilities stay
# admin-only unless listed here. Omit entirely to keep built-in defaults.
member_permissions:
  - prompt
  - prefs.get
  - barber                           # the profile's own capability, NOT gws

# Optional env the profile needs (host-side credentials for capabilities).
env:
  - key: MERCURY_BARBER_BUSINESS_HOURS
    description: "Business hours"
    default: "09:00-18:00"

# Project-wide agent persona, injected into every container's system prompt.
system_prompt: |
  You are a barber shop assistant. Help each customer book, view, and cancel
  ONLY their own appointments. Never reveal other customers' schedules.

defaults:
  trigger_patterns: always
```

Apply it with `mercury profile apply <name|path|git-url>`. That validates
capabilities, copies extensions/AGENTS.md, and persists activation to
`.mercury/active-profile.json`, which Mercury loads at startup.

## 2. The capability broker (where the business logic runs)

A profile's privileged work runs **on the host**, so credentials never enter the
customer-controlled agent container. The profile's extension registers a
handler; the agent invokes it through a thin CLI.

### Register a handler (in the extension's `index.ts`)

```ts
import type { ExtensionSetupFn } from "mercury-agent"; // types from this repo

const setup: ExtensionSetupFn = (mercury) => {
  // Make the capability gate-able. Members get it via member_permissions.
  mercury.permission({ defaultRoles: [] });

  // Host-side credentials for the wrapped capability (never sent to the container).
  mercury.env({ from: "MERCURY_BARBER_GOOGLE_CREDENTIALS" });

  mercury.capability("barber", async (req, ctx) => {
    // req.callerId is the TOKEN-DERIVED, unspoofable caller — safe for ownership.
    switch (req.action) {
      case "availability":
        return { data: await listOpenSlots(req.body, ctx) };
      case "book":
        return { data: await book(req.callerId, req.body, ctx) };
      case "cancel":
        return { data: await cancelOwn(req.callerId, req.body, ctx) };
      case "my-appointments":
        return { data: await listOwn(req.callerId, ctx) };
      default:
        return { status: 400, data: { error: `unknown action: ${req.action}` } };
    }
  });
};

export default setup;
```

### The contract types (exported from this repo)

```ts
type CapabilityHandler = (
  req: CapabilityRequest,
  ctx: MercuryExtensionContext,
) => Promise<CapabilityResult>;

interface CapabilityRequest {
  name: string;      // capability name
  action: string;    // sub-action (book, cancel, …)
  callerId: string;  // token-derived, TRUSTWORTHY — use for ownership checks
  spaceId: string;
  body: unknown;     // parsed JSON request body (or null)
}

interface CapabilityResult {
  status?: number;   // default 200
  data: unknown;     // JSON-serializable response
}
```

`ctx` (`MercuryExtensionContext`) gives you `db`, `config`, `log`, and
`hasCallerPermission(spaceId, callerId, permission)`. Store per-profile state via
`mercury.store` (namespaced KV) or your own tables through `ctx.db`.

### How the agent invokes it

Inside the container the agent runs:

```
mrctl capability barber book '{"slot":"2026-07-02T15:00"}'
```

→ `POST /api/capability/barber/book`. Document these commands for the agent in
the extension's `SKILL.md` or the profile's `AGENTS.md`.

## 3. Permission & security model (non-negotiable)

- **`member_permissions` is exhaustive.** List every permission a member may
  hold, including the capability name (e.g. `barber`). Anything not listed —
  including raw capabilities like `gws` — is unavailable to members.
- **Authorization = permission named after the capability.** The broker route
  requires the caller to hold the `<name>` permission; the same grant gates both
  the `mrctl capability <name> …` CLI and the route. Keep capability name ==
  permission name == the entry in `member_permissions`.
- **Credentials stay on the host.** Put capability credentials in host env
  (`mercury.env`) / `mercury.store` and use them only inside the handler. Never
  expose a raw capability CLI (e.g. `gws`) to members — its secret would be
  readable inside the container.
- **Enforce ownership with `req.callerId`.** It is token-derived and cannot be
  spoofed by the container. Never trust an id passed in `req.body`.
- **`callerId === "system"`** for scheduled/system runs — handle it explicitly
  (e.g. skip per-customer ownership).

## 4. Suggested profile repo layout

```
<profile-repo>/
  barber/                      # one folder per profile
    mercury-profile.yaml
    AGENTS.md
    extensions/
      barber/
        index.ts               # registers permission + capability
        package.json
```

Depend on this repo (`mercury-agent`) for the types
(`ExtensionSetupFn`, `CapabilityRequest`, `CapabilityResult`,
`MercuryExtensionContext`). See `src/extensions/types.ts` for the full surface.

## 5. Local test loop

1. `mercury profile apply ./barber`
2. `mercury service install` (builds the derived image with the extension CLI)
3. DM the bot as a non-admin number; confirm you can `book`/`cancel` only your
   own appointments and cannot reach `gws`/Gmail.

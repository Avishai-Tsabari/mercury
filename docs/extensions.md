# Extensions

Mercury's extension system lets you add CLIs, skills, background jobs, lifecycle hooks, config keys, and dashboard widgets — all in TypeScript.

Extensions **cannot register HTTP routes** on the host API today. Features that need authenticated host endpoints (for example TradeStation **order placement** with a two-step confirm flow) are implemented as routes under `src/core/routes/` and gated with the same permission name as the extension (`tradestation`). A future `mercury.route()` API could move such handlers next to the extension source.

## Structure

Extensions live in `.mercury/extensions/*/`. Each directory is an extension:

```
.mercury/extensions/
├── napkin/
│   ├── index.ts           # Required — setup function
│   ├── skill/SKILL.md     # Optional — agent skill
│   └── package.json       # Optional — dependencies
└── gws/
    └── index.ts
```

The extension **name** is the directory name.

## Setup Function

Every extension exports a default function that receives the `MercuryExtensionAPI`:

```typescript
import type { MercuryExtensionAPI } from "mercury-agent";

export default function(mercury: MercuryExtensionAPI) {
  // Declare what this extension provides
  mercury.cli({ name: "napkin", install: "bun add -g napkin-ai" });
  mercury.permission({ defaultRoles: ["admin", "member"] });
  mercury.skill("./skill");

  mercury.on("workspace_init", async ({ workspace, containerWorkspace }) => {
    mkdirSync(join(workspace, "entities"), { recursive: true });
  });

  mercury.job("cleanup", {
    interval: 3600_000,
    run: async (ctx) => { /* ... */ },
  });

  mercury.config("enabled", {
    description: "Enable napkin for this space",
    default: "true",
  });

  mercury.widget({
    label: "Napkin Status",
    render: (ctx) => `<p>Last run: ${mercury.store.get("last-run") ?? "never"}</p>`,
  });
}
```

All declarations are optional — use only what you need.

## API Reference

### `mercury.cli(opts)`

Declare a CLI tool to install in the container image.

```typescript
mercury.cli({ name: "napkin", install: "bun add -g napkin-ai" });
```

- `name` — binary name (should match extension name)
- `install` — shell command run as a Dockerfile `RUN` step

Mercury auto-generates a derived Docker image with all extension CLIs installed. The agent calls them directly in bash. Permission enforcement is handled by a built-in pi extension that blocks denied CLIs based on the caller's role.

Can be called multiple times for extensions that need several tools (e.g., media needs ffmpeg, imagemagick, and yt-dlp).

### `mercury.permission(opts)`

Register this extension's permission and set default roles.

```typescript
mercury.permission({ defaultRoles: ["admin", "member"] });
```

- Permission name = extension name (e.g., `napkin`)
- `defaultRoles` — roles that get this permission by default
- `admin` always gets all permissions automatically
- Per-space overrides in `space_config` take precedence
- **Applicative profiles override `defaultRoles`**: when the active profile
  defines `member_permissions`, that list is exhaustive for the `member` role —
  an extension is only usable by members if its name appears there. Mercury logs
  a startup warning for each loaded extension whose `defaultRoles` include
  `member` but which the profile excludes.

Can only be called once per extension.

### `mercury.env(def)`

Declare an environment variable this extension needs. Only injected into containers when the caller has permission for this extension. Claimed vars are excluded from the blind `MERCURY_*` passthrough, preventing credential leakage to unprivileged callers.

```typescript
mercury.env({ from: "MERCURY_GH_TOKEN" });                    // injected as GH_TOKEN
mercury.env({ from: "MERCURY_GH_TOKEN", as: "GITHUB_TOKEN" }); // custom container name
mercury.env({ from: "MERCURY_STT_API_KEY", hostOnly: true }); // host-side only
```

- `from` — env var name as set in `.env` (e.g. `MERCURY_GH_TOKEN`)
- `as` — (optional) name inside the container. Defaults to `from` with `MERCURY_` prefix stripped
- `hostOnly` — (optional) claim the var (kept out of the blind `MERCURY_*` passthrough) but **never inject it into any container**. Use for secrets consumed only by host-side hooks/jobs (e.g. an STT API key used in `before_container`).

Can be called multiple times for multiple env vars.

### `mercury.skill(relativePath)`

Register a skill directory for agent discovery.

```typescript
mercury.skill("./skill");
```

The directory must contain a `SKILL.md` file in pi's [skill format](https://agentskills.io/specification). Mercury copies the entire skill directory into `.mercury/global/skills/<name>/`, which is mounted into containers at `/home/node/.pi/agent/skills/<name>/`. Pi discovers it automatically.

Skills can contain multiple files — scripts, references, assets — not just SKILL.md. The agent uses relative paths from SKILL.md to access them.

### `mercury.requires(capabilities)`

Declare that this extension's skill (or CLI workflows) needs certain model capabilities (`tools`, `vision`, etc.). If **no** leg in `MERCURY_MODEL_CHAIN` satisfies **all** listed flags, the extension skill is not copied into the global skills directory and Mercury logs a startup warning.

```typescript
mercury.requires(["tools"]); // e.g. PDF / scripting extensions
```

Capability keys: `tools`, `vision`, `audio_input`, `audio_output`, `extended_thinking`.

Host configuration:

- Built-in prefix map for common model IDs
- Optional `.mercury/model-capabilities.yaml` for per-model overrides
- Optional `MERCURY_MODEL_CAPABILITIES` JSON env var (applies to every leg)

### `mercury.on(event, handler)`

Subscribe to lifecycle events.

```typescript
mercury.on("workspace_init", async (event, ctx) => {
  // event.workspace — absolute host path
  // event.containerWorkspace — container-relative path (e.g. /spaces/main)
  mkdirSync(join(event.workspace, "my-dir"), { recursive: true });
});
```

#### Events

| Event | When | Can mutate? |
|-------|------|-------------|
| `startup` | After extensions loaded, runtime ready | No |
| `shutdown` | Mercury shutting down | No |
| `workspace_init` | Space workspace created/ensured | No |
| `before_container` | About to spawn container | Yes |
| `after_container` | Container finished | Yes |

Both `workspace_init` and `before_container` events include:
- `workspace` — absolute host path (for file operations on the host)
- `containerWorkspace` — container-relative path, e.g. `/spaces/main` (for env vars passed into the container)

`before_container` also includes:
- `attachments` — incoming `MessageAttachment[]` (e.g. voice, images), if any

#### `before_container` mutations

```typescript
mercury.on("before_container", async (event, ctx) => {
  return {
    systemPrompt: "Extra instructions...",  // appended to system prompt
    promptAppend: "Transcript or extra user text...", // appended to user prompt (newline-joined across handlers)
    env: { MY_VAR: event.containerWorkspace + "/data" },  // container-relative paths
    block: { reason: "Rate limited" },       // prevent container from running
  };
});
```

The user message stored in the DB and passed to the container uses the original prompt plus any `promptAppend` from hooks (after `before_container` runs).

#### Extension context helpers

`ctx.hasCallerPermission(spaceId, callerId, permission)` returns whether the caller has a built-in or extension-registered permission in that space. Use it in hooks to mirror container RBAC (e.g. only transcribe voice for members who have your extension permission).

#### `after_container` mutations

```typescript
mercury.on("after_container", async (event, ctx) => {
  return {
    reply: event.reply + "\n\n_Powered by Mercury_",  // transform reply
    suppress: true,                                     // don't send reply
  };
});
```

### `mercury.job(name, def)`

Register a background job that runs on the host.

```typescript
// Interval-based
mercury.job("cleanup", {
  interval: 3600_000,  // every hour
  run: async (ctx) => { /* ... */ },
});

// Cron-based
mercury.job("daily-report", {
  cron: "0 9 * * *",  // 9am daily
  run: async (ctx) => { /* ... */ },
});
```

Must specify either `interval` or `cron`, not both. Jobs are started after extensions load and stopped on shutdown. Errors are caught and logged — a failing job never crashes Mercury.

### `mercury.config(key, def)`

Register a per-space config key.

```typescript
mercury.config("enabled", {
  description: "Enable napkin for this space",
  default: "true",
  validate: (v) => v === "true" || v === "false",
});
```

Keys are namespaced to the extension: the above registers `napkin.enabled`. Users set it via `mrctl config set napkin.enabled false`.

In hooks and jobs, read values with `ctx.getConfig(spaceId, "napkin.enabled")` instead of `ctx.db.getSpaceConfig(...) ?? default`. It resolves the full chain: per-space value → `@global` scope (dashboard **Features** page) → `extensions:` section in `mercury.yaml` → the registered default. This makes deployment-wide defaults work for auto-created spaces without any per-space setup.

### `mercury.widget(def)`

Register a dashboard widget.

```typescript
mercury.widget({
  label: "KB Distillation",
  render: (ctx) => {
    const lastRun = mercury.store.get("last-run") ?? "never";
    return `<div>Last run: ${lastRun}</div>`;
  },
});
```

Widgets render HTML fragments in the dashboard overview. Errors show a placeholder — never crash the dashboard.

### `mercury.store`

Scoped key-value store for persistent state.

```typescript
mercury.store.set("last-run", Date.now().toString());
mercury.store.get("last-run");     // "1709654400000"
mercury.store.delete("last-run");  // true
mercury.store.list();              // [{ key: "last-run", value: "..." }]
```

Each extension sees only its own keys. Backed by the `extension_state` SQLite table.

## Extension Context

Event handlers and job runners receive a `MercuryExtensionContext`:

```typescript
interface MercuryExtensionContext {
  readonly db: Db;          // Database access
  readonly config: AppConfig; // Mercury configuration
  readonly log: Logger;      // Logger scoped to the extension
  hasCallerPermission(spaceId: string, callerId: string, permission: string): boolean;
  getConfig(spaceId: string, key: string): string | null;
  send(opts: { to: string; text: string }): Promise<{ spaceId: string }>;
}
```

### `ctx.send(opts)` — deterministic direct send

Delivers a message straight to the adapter outbox — no agent run, no LLM in the path. Use it from jobs and capability handlers when the message text must arrive exactly as composed (reminders, notifications):

```typescript
mercury.job("appointment-reminders", {
  cron: "*/15 * * * *",
  run: async (ctx) => {
    for (const r of dueReminders(ctx)) {
      try {
        await ctx.send({ to: r.callerId, text: r.text });
      } catch (err) {
        ctx.log.warn("reminder send failed — retrying next sweep", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  },
});
```

`to` resolves callerId-first: an exact space id, a raw WhatsApp caller id (phone JID or opaque LID — same normalization that keys DM auto-spaces), a platform-qualified id (`whatsapp:123@lid`), or a phone with leading `+`. It never creates spaces — sending to someone without an existing conversation fails.

Failures throw `DirectSendError` with a `reason` you can branch on: `sender_not_ready` (adapters not up yet, or the context has no delivery path — e.g. connection status probes), `unknown_recipient` (no existing space matches), `invalid_text` (empty or over 4096 chars).

The same delivery path is exposed to ops scripts as `POST /api/send` (Bearer `MERCURY_API_SECRET`, global-admin caller, body `{ "recipient": "...", "text": "..." }`). Like `/api/broadcast`, it is host-side only — never member-callable from containers.

## Container Integration

### Skill Files

Skills can include anything the agent needs:

```
napkin/skill/
├── SKILL.md              # Required: frontmatter + instructions
├── scripts/              # Helper scripts
│   └── search.js
├── references/           # Detailed docs loaded on-demand
│   └── api-reference.md
└── assets/
    └── template.json
```

All files are copied into the container mount. Relative paths from SKILL.md work.

### Derived Image

Extensions that declare `mercury.cli()` get their tools installed in a derived Docker image:

```
FROM mercury-agent:latest
RUN bun add -g napkin-ai        # from napkin extension
RUN pip install some-tool       # from another extension
```

Mercury builds this image on startup (cached by content hash). If no extensions declare CLIs, the base image is used unchanged.

### Agent Discovery

The agent discovers extension CLIs via skills (SKILL.md files) and invokes them through `mrctl`:

```bash
napkin search "query"           # called directly, RBAC enforced at bash level
```

## Built-in Commands vs Extensions

`mrctl` has two types of commands:

| Type | Examples | How it works |
|------|----------|--------------|
| **Built-in** | `tasks`, `roles`, `permissions`, `config`, `spaces`, `conversations`, `stop`, `compact` | HTTP calls to host API via `mrctl` |
| **Extension** | `napkin`, `pinchtab`, any custom | Called directly in bash, RBAC enforced by pi extension |

Built-in names are reserved — extension registration fails on collision.

## Permissions

One permission per extension, named after the extension. Extensions declare which roles get it by default:

```typescript
mercury.permission({ defaultRoles: ["admin", "member"] });
```

- `admin` always gets all permissions
- Per-space overrides via `mrctl permissions set <role> prompt,napkin,...`
- See [permissions.md](permissions.md) for the full RBAC system

## Installation

### `mercury add`

Install extensions from local paths, npm, or git:

```bash
mercury add ./path/to/extension         # local directory
mercury add npm:mercury-ext-napkin      # npm package
mercury add git:github.com/user/ext     # git repo
```

Mercury copies the extension to `.mercury/extensions/<name>/`, installs dependencies if `package.json` is present, copies skills to the global dir, and validates the extension loads correctly.

### `mercury remove`

```bash
mercury remove napkin
```

Removes the extension directory and its installed skill. Restart Mercury to apply.

### `mercury extensions list`

```bash
mercury extensions list    # or: mercury ext list
```

Shows all installed extensions (user + built-in) with features and descriptions.

## Examples

See [`examples/extensions/`](../examples/extensions/) for complete, working extensions ranging from minimal (charts — CLI + skill) to full-featured (napkin — hooks, jobs, config, widgets, KB distillation).

## Types

All types are in `src/extensions/types.ts`:

- `MercuryExtensionAPI` — setup API surface
- `MercuryExtensionContext` — runtime context for hooks/jobs
- `MercuryEvents` — all lifecycle events
- `EventHandler<E>` / `EventResult<E>` — typed handlers with mutation support
- `ExtensionMeta` — collected metadata after setup
- `ExtensionStore` — scoped key-value store
- `JobDef`, `ConfigDef`, `WidgetDef`, `CliDef`, `PermissionDef` — definitions
- `ExtensionSetupFn` — the default export signature

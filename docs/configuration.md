# Configuration

Mercury reads settings from **environment variables** (`MERCURY_*`) and, optionally, a project **`mercury.yaml`** file in the current working directory.

**Product / design spec:** [prd-config-load.md](prd-config-load.md) (config load: YAML + env precedence, security, non-goals).

## Precedence

1. If a `MERCURY_*` variable is **set** in the environment (the key exists, including empty string), its value wins.
2. Otherwise, if **`mercury.yaml`** (or **`mercury.yml`**) exists in `cwd`, values from that file apply.
3. Otherwise, built-in defaults from `config.ts` apply.

Set **`MERCURY_CONFIG_FILE`** to an explicit path to load a different file. Set it to **`""`** (empty) or **`none`** to **disable** loading any file (useful for tests or when you want env/defaults only).

Relative paths in `MERCURY_CONFIG_FILE` are resolved against `cwd`.

## Secrets (never use `mercury.yaml` for these)

These must be supplied via environment variables only; they are **not** read from YAML:

- `MERCURY_API_SECRET`
- `MERCURY_CHAT_API_KEY`
- `MERCURY_DISCORD_GATEWAY_SECRET`

Platform tokens, provider API keys, and extension keys (e.g. `MERCURY_TELEGRAM_BOT_TOKEN`, `MERCURY_BRAVE_API_KEY`) are also **env-only** today—they are not part of the YAML schema.

## YAML layout

See [`resources/templates/mercury.example.yaml`](../resources/templates/mercury.example.yaml) for a commented template. Supported sections include `server`, `model`, `ingress`, `runtime`, `trigger`, `context`, `conditional_context`, `compaction`, `agent`, `discord`, `telegram`, `media`, and `permissions`.

The `context:` block seeds default conversation-context behavior into the `main` space on first boot:

```yaml
context:
  mode: context              # clear | context (default: context)
  window_size: 10            # 1-50 (default: 10). Sliding-window turns when mode=context.
  reply_chain_depth: 10      # 1-50 (default: 10). Reply chain depth when mode=clear.
```

Per-space overrides via `mrctl config set context.<key> <value>` always win over YAML defaults; YAML re-reads on restart do not overwrite an existing space row.

You may also set a top-level **`model_chain`** array as an alias for `model.chain`.

## Container env passthrough (`agent.env_passthrough`)

Controls which host `MERCURY_*` variables reach agent containers:

```yaml
agent:
  env_passthrough: all       # all (default) | claimed
```

- **`all`** — every `MERCURY_*` var except a fixed blocklist is passed into the container with the prefix stripped (`MERCURY_BRAVE_API_KEY` → `BRAVE_API_KEY`). Convenient, but blunt: a secret added to `.env` for one purpose reaches **every space's container**, regardless of who triggered the turn or whether that space has anything to do with it.
- **`claimed`** — only variables an extension declared via `mercury.env()` are passed, and only when the triggering caller holds that extension's permission. Undeclared variables stay on the host.

**Model-provider credentials are exempt** and pass in both modes (`MERCURY_ANTHROPIC_API_KEY`, `MERCURY_ANTHROPIC_OAUTH_TOKEN`, `MERCURY_GEMINI_API_KEY`, `MERCURY_GROQ_API_KEY`, and the rest of the provider list). pi reads them inside the container, and no extension declares them — without the exemption, `claimed` would leave the agent unable to reach any model. They remain subject to the blocklist.

Env: `MERCURY_CONTAINER_ENV_PASSTHROUGH`.

`claimed` is opt-in because it breaks setups that rely on blind passthrough for anything other than provider keys — API keys consumed by skills (search, TTS, scrapers) and any credential you added by hand. To migrate, declare those in an extension (see [extensions.md](extensions.md)) before switching. At startup with `all`, Mercury logs the vars it is passing that are neither declared nor provider credentials — names only, so a genuine outlier stands out:

```
Container env passthrough: all — these vars reach every space's container and are scoped to nothing. […] vars=MERCURY_BRAVE_API_KEY, MERCURY_BILLING_API_KEY
```

For secrets that only host-side hooks and jobs need, prefer `mercury.env({ from: "…", hostOnly: true })`, which keeps them out of containers in either mode. For credentials the agent should never hold at all, use a host-side capability handler (`mercury.capability()`), which runs the privileged call on the host and returns only the result.

## Extension config defaults (`extensions:`)

Deployment-wide defaults for extension config keys, applied to **every space** (including auto-created DM spaces) at read time:

```yaml
extensions:
  voice-transcribe:
    provider: openai
    model: whisper-large-v3
    base_url: https://api.groq.com/openai/v1
    language: he
```

Resolution order for an extension config key: per-space value (`mrctl config set`) → `@global` scope (set from the dashboard **Features** page) → this YAML section (env: `MERCURY_EXTENSION_DEFAULTS` as flat JSON, e.g. `{"voice-transcribe.provider":"openai"}`) → the extension's registered default. Changing a global or YAML value takes effect for all existing and future spaces immediately (YAML on restart) — nothing is copied into per-space rows.

## Model chain

In YAML, use a list of `{ provider, model }` objects under `model.chain` (max 4 legs). The same rules apply as for `MERCURY_MODEL_CHAIN` JSON.

Optional **`model.capabilities`** may be a mapping; it is applied like `MERCURY_MODEL_CAPABILITIES` JSON.

### Removed: `provider: cursor`

The **Cursor Agent CLI** integration has been removed. All model legs use **pi** with standard providers (`anthropic`, `openai`, `google`, `mistral`, `groq`, `openrouter`, etc.).

If your chain still has `provider: cursor`, the agent run **fails fast** with an error that points here. Switch to the **native provider** for the model you want (for example `anthropic` for Claude, `openai` for GPT) and set the matching **`MERCURY_*_API_KEY`**.

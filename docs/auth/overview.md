# Authentication

Mercury needs credentials for two things:

1. **AI model provider** — to call the LLM (Anthropic, OpenAI, etc.)
2. **Chat platforms** — to connect to WhatsApp, Discord, Slack, Teams

## Model Provider Auth

### OAuth Login (Recommended)

Mercury reuses [pi](https://github.com/badlogic/pi)'s OAuth providers. No API key needed — just login:

```bash
mercury auth login              # Interactive provider picker
mercury auth login anthropic    # Or specify directly
```

Supported providers:

| Provider | ID | What it gives you |
|----------|----|-------------------|
| Anthropic (Claude Pro/Max) | `anthropic` | Claude access via your subscription |
| GitHub Copilot | `github-copilot` | Models via Copilot subscription |
| Google Gemini CLI | `google-gemini-cli` | Gemini via Google Cloud |
| Antigravity | `antigravity` | Gemini 3, Claude, GPT-OSS via Google Cloud |
| ChatGPT Plus/Pro | `openai-codex` | OpenAI models via ChatGPT subscription |

Credentials are saved to `.mercury/global/auth.json` and auto-refreshed when expired.

### API Key

Alternatively, set an API key in `.env`:

```bash
MERCURY_ANTHROPIC_API_KEY=sk-ant-...
# or
MERCURY_ANTHROPIC_OAUTH_TOKEN=sk-ant-oat01-...
```

### Resolution Order

Mercury resolves credentials in this order:

1. OAuth credentials from `auth.json` (via `mercury auth login`)
2. `MERCURY_ANTHROPIC_OAUTH_TOKEN` from `.env`
3. `MERCURY_ANTHROPIC_API_KEY` from `.env`

> **OAuth always takes precedence over API keys.** If a provider has both an OAuth connection (in `auth.json` or `MERCURY_*_OAUTH_TOKEN`) and an API key (`MERCURY_*_API_KEY`), the OAuth token is used and the API key is ignored. This applies both to the CLI and to agents provisioned via the cloud console.

### Managing Credentials

```bash
mercury auth status             # Show what's configured
mercury auth logout anthropic   # Remove saved credentials
mercury auth logout             # List what's logged in
```

## Chat Platform Auth

### WhatsApp

```bash
mercury auth whatsapp                              # QR code (recommended)
mercury auth whatsapp --pairing-code --phone 1234   # Pairing code (headless)
```

See [whatsapp.md](whatsapp.md) for details.

### Discord

Set in `.env`:

```bash
MERCURY_ENABLE_DISCORD=true
MERCURY_DISCORD_BOT_TOKEN=your-bot-token
```

### Slack

Set in `.env`:

```bash
MERCURY_ENABLE_SLACK=true
MERCURY_SLACK_BOT_TOKEN=xoxb-...
MERCURY_SLACK_SIGNING_SECRET=...
```

### Teams

Set in `.env`:

```bash
MERCURY_ENABLE_TEAMS=true
MERCURY_TEAMS_APP_ID=...
MERCURY_TEAMS_APP_PASSWORD=...
MERCURY_TEAMS_APP_TENANT_ID=...
```

## Dashboard Auth

The web dashboard is protected by `MERCURY_API_SECRET`. Browser sessions are established via a login handshake managed by the cloud console — see [dashboard.md](dashboard.md).

## Security

- `auth.json` has `0600` permissions (owner read/write only)
- WhatsApp credentials in `.mercury/whatsapp-auth/` are sensitive — treat like passwords
- All `MERCURY_*` env vars are passed into containers with the prefix stripped
- Never commit `.env` or `auth.json` to version control

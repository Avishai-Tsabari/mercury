# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Mercury, please report it **privately** —
do not open a public issue.

- Use GitHub's [private vulnerability reporting](https://github.com/Avishai-Tsabari/mercury/security/advisories/new)
  (**Security → Report a vulnerability**), or
- Email the maintainer at the address on the [GitHub profile](https://github.com/Avishai-Tsabari).

Please include:

- A description of the vulnerability and its impact
- Steps to reproduce (proof-of-concept if possible)
- Affected version(s) or commit

You can expect an initial acknowledgement within a few days. Please allow reasonable
time for a fix before any public disclosure.

## Scope & Notes

Mercury handles provider API keys and secrets, spawns Docker containers, and can expose
HTTP endpoints. When self-hosting, keep the following in mind:

- **Secrets** live in `.env` / `.mercury/global/auth.json` — never commit them. Only
  `.env.example` is tracked.
- **API endpoints**: set `MERCURY_API_SECRET` to require a Bearer token on `/api/*`, and
  `MERCURY_CHAT_API_KEY` to protect `/chat`. When unset, `/chat` is open (intended for
  local use only) — do not expose an unauthenticated instance to the internet.
- **Container isolation**: agents run inside Docker with in-container sandboxing
  (bubblewrap, or gVisor via `MERCURY_CONTAINER_RUNTIME=runsc`). See
  [docs/container-lifecycle.md](docs/container-lifecycle.md).
- **Live actions**: some optional extensions (e.g. TradeStation) can perform real,
  irreversible actions. These are gated behind explicit opt-in flags
  (e.g. `MERCURY_TS_ALLOW_LIVE_ORDERS`, default `false`). Review before enabling.

## Supported Versions

Mercury is pre-1.0 and evolves quickly. Security fixes land on the latest `main` and the
most recent published release. Please upgrade to the latest version before reporting.

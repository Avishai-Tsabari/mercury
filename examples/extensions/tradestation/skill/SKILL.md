---
name: tradestation
description: Call TradeStation REST API v3 from the agent (accounts, balances, positions, bars) and place orders via mrctl two-step confirmation. Admin-only; requires Mercury host OAuth setup and token refresh job.
allowed-tools: Bash
---

# TradeStation (Mercury extension)

This skill is for **admin** callers only. Mercury injects `TRADESTATION_ACCESS_TOKEN` and `TRADESTATION_API_BASE` only when the user has the `tradestation` permission (default: admins only).

## Host setup

1. Register an OAuth app with TradeStation (same model as Tagula: `TS_CLIENT_ID`, `TS_CLIENT_SECRET`, redirect URI, scopes such as `openid profile offline_access MarketData ReadAccount`).
   - **Orders**: add TradeStation scopes required for order placement (see [TradeStation scopes](https://api.tradestation.com/docs/fundamentals/authentication/scopes/)); re-authenticate after changing scopes.
2. Complete OAuth once (e.g. Tagula `manage-auth` / your dashboard) and put the same credentials in the Mercury host `.env` as either the `MERCURY_*` names **or** the same Tagula names (`TS_CLIENT_ID`, `TS_CLIENT_SECRET`, `TS_REFRESH_TOKEN`, optional `TS_ACCESS_TOKEN`). The refresh job accepts both.
   - Optional: `MERCURY_TS_TOKEN_URL`, `MERCURY_TS_API_BASE`, `MERCURY_TS_ENVIRONMENT` (`SIM` / `LIVE` — documented for parity; v3 base URL is unchanged)
   - **Live orders**: by default, only **SIM** accounts (AccountID matching `SIM…`) may place orders via Mercury. To allow non-SIM accounts, set `MERCURY_TS_ALLOW_LIVE_ORDERS=true` on the host (real-money risk).
3. Restart Mercury so the extension job runs (refresh every **10 minutes**).

If refresh fails, the container may receive `TRADESTATION_AUTH_ERROR` with a short code (e.g. `refresh_failed:...`, `no_refresh_token`). Tell the user to re-authenticate and update host env / tokens.

## CLI — reads (Bun)

Scripts live next to this skill. In the agent container the skill is typically mounted under `/home/node/.pi/agent/skills/tradestation/`.

```bash
bun /home/node/.pi/agent/skills/tradestation/scripts/ts-cli.ts accounts
bun /home/node/.pi/agent/skills/tradestation/scripts/ts-cli.ts balances ACCOUNT_KEY
bun /home/node/.pi/agent/skills/tradestation/scripts/ts-cli.ts positions ACCOUNT_KEY
bun /home/node/.pi/agent/skills/tradestation/scripts/ts-cli.ts bars SYMBOL [barsback]
```

Examples:

```bash
bun /home/node/.pi/agent/skills/tradestation/scripts/ts-cli.ts accounts
bun /home/node/.pi/agent/skills/tradestation/scripts/ts-cli.ts balances SIM123456789
bun /home/node/.pi/agent/skills/tradestation/scripts/ts-cli.ts positions SIM123456789
bun /home/node/.pi/agent/skills/tradestation/scripts/ts-cli.ts bars AAPL 20
bun /home/node/.pi/agent/skills/tradestation/scripts/ts-cli.ts bars '%40ES' 10
```

Use a URL-encoded symbol for futures (e.g. `@ES` as `%40ES`) or pass `@ES` quoted so the shell does not expand it.

## Orders — two-step confirmation (`mrctl`)

Order placement runs on the **Mercury host** (not inside `ts-cli`) so the flow can be audited and gated. Use **`mrctl`** from the agent container (same headers as other `mrctl` commands).

1. **Propose** (no `--confirm`): calls TradeStation `orderconfirm`, stores a pending id (~15 minutes), returns a summary and `pendingId`.
2. **Human check**: show the summary on **any** chat platform. The user can confirm with plain text, e.g. `CONFIRM <pendingId>`, or tell you to run step 3.
3. **Execute**: same flags as step 1 plus `--confirm --pending-id <pendingId>`.

Example (SIM account):

```bash
mrctl tradestation order --account SIM123456789 --symbol AAPL --quantity 1 --action SELL --type Market --duration DAY
# … user approves …
mrctl tradestation order --account SIM123456789 --symbol AAPL --quantity 1 --action SELL --type Market --duration DAY --confirm --pending-id '<uuid-from-step-1>'
```

Optional: `--route Intelligent` (default), `--limit-price`, `--stop-price`, `--expiration-date` (for time-in-force), `--type` (default `Market`).

**Rules**: Do not skip human confirmation. Do not place live orders unless the user explicitly wants that and `MERCURY_TS_ALLOW_LIVE_ORDERS` is enabled on the host.

## Scope

Read helpers: **accounts**, **balances**, **positions**, **bars**. Orders: **host-side** via `mrctl tradestation order` only. Not a full API mirror; no streaming in-container.

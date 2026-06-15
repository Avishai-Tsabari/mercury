---
name: context
description: Manage conversation context — clear the next run's context (one-shot) or compact to permanently reset the session boundary. Use when the user asks to "start fresh", "forget", "clear context", or "reset".
---

## Commands

```bash
mrctl clear                  # One-shot: next run starts with no prior messages, then reverts
mrctl compact                # Permanent: all older messages excluded from context going forward
mrctl config set context.mode <clear|context>   # Switch context strategy
```

## clear vs compact

| | `mrctl clear` | `mrctl compact` |
|---|---|---|
| Effect | Excludes prior messages for the **next run only** | Permanently moves the session boundary forward |
| After next run | Context window returns to normal | Old messages stay excluded forever |
| Use when | User wants a one-time fresh start ("forget what we just discussed") | User wants a hard reset ("start over", conversation is too long/confused) |

## Context modes

Set via `mrctl config set context.mode <value>`:

- **`clear`** (default) — Each message starts fresh. If the user replies to a bot message, the reply chain is included as context.
- **`context`** — Sliding window of recent turns is always included.

Sliding-window size for `context` mode: `mrctl config set context.window_size <1-50>` (default: 10).

Depth of reply-chain context for `clear` mode: `mrctl config set context.reply_chain_depth <1-50>` (default: 10).

All three keys (`context.mode`, `context.window_size`, `context.reply_chain_depth`) can also be set in `mercury.yaml` under a top-level `context:` block — values seed the `main` space on first boot.

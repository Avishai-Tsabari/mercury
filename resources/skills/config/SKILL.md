---
name: config
description: View and set per-space configuration. Use when the user asks to change trigger behavior, extension settings, or other space settings.
---

## Commands

```bash
mrctl config get [key]
mrctl config set <key> <value>
```

## Built-in keys

| Key | Values | Description |
|-----|--------|-------------|
| `trigger.match` | `prefix`, `mention`, `always` | How the bot is triggered |
| `trigger.patterns` | comma-separated words | Custom trigger words |
| `trigger.case_sensitive` | `true`, `false` | Case-sensitive trigger matching |
| `trigger.media_in_groups` | `true`, `false` | When `true`, voice/media-only messages in groups trigger the bot without text (default: `false`). DMs always allow media-only. |
| `ambient.enabled` | `true`, `false` | Store non-triggered group messages as context (default: true). Set to `false` for tag-only mode. |
| `context.mode` | `clear`, `context` | `clear` = each message starts fresh (reply to bot for chain context). `context` = sliding window of recent turns. Default: `clear`. |
| `context.reply_chain_depth` | `1`–`50` | Max number of reply-chain messages to include as context. Default: `10`. |

Extension config keys are also available and shown in `mrctl config get` output with descriptions and defaults.

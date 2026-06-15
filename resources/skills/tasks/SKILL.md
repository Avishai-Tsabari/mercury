---
name: tasks
description: Manage scheduled tasks — create cron jobs or one-shot reminders that run prompts on a schedule. Use when the user asks to schedule something, set a reminder, or manage recurring tasks.
---

## Commands

```bash
mrctl tasks list
mrctl tasks create --cron "<expr>" --prompt "<text>" [--timezone "<IANA>"] [--silent]
mrctl tasks create --at "<ISO8601>" --prompt "<text>" [--silent]
mrctl tasks pause <id>
mrctl tasks resume <id>
mrctl tasks run <id>
mrctl tasks delete <id>
```

## Cron expressions

Standard 5-field cron: minute hour day-of-month month day-of-week

Examples:
- `0 9 * * *` — daily at 9am
- `*/30 * * * *` — every 30 minutes
- `0 9 * * 1` — every Monday at 9am
- `0 0 1 * *` — first day of each month

## One-shot tasks

Use `--at` with ISO 8601 timestamp for one-time execution:
- `--at "2026-03-05T10:00:00Z"`

## Timezone

**Always pass `--timezone`** when creating cron tasks. Infer the user's timezone from:
1. Explicit mention (e.g. "Israel time", "EST")
2. Language/locale context (e.g. Hebrew → "Asia/Jerusalem")
3. Prior conversation context

If you cannot determine the timezone, ask the user before creating the task. Never omit `--timezone` for cron tasks — omitting it causes the task to fire at UTC, which is almost never what the user intends.

## Options

- `--timezone "<IANA>"` — IANA timezone for cron evaluation (e.g. `"Asia/Jerusalem"`, `"America/New_York"`). Falls back to the agent's configured default timezone, then UTC.
- `--silent` — task runs but output is not sent to chat (useful for background work)

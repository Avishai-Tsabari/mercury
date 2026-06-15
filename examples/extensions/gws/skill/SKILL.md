---
name: gws
description: Access Gmail, Google Drive, Google Calendar, Docs, and Sheets via the gws CLI. Use for email (read, send, triage inbox, reply, forward), calendar (today's agenda, add or reschedule events, meeting prep), Drive (list, find, organize files), and Docs/Sheets (read, summarize, append). Triggers on any Google Workspace or Gmail request.
allowed-tools: Bash
---

# Google Workspace (gws)

Use the `gws` CLI via Bash for all Google Workspace operations.

## Presentation rules — always enforce

**Never paste raw gws output into a reply.** Translate every result into plain language before responding.

| Raw output field | What to show instead |
|---|---|
| `name` or `summary` | The display name only |
| `mimeType: application/vnd.google-apps.document` | "Google Doc" |
| `mimeType: application/vnd.google-apps.spreadsheet` | "spreadsheet" |
| `mimeType: application/vnd.google-apps.folder` | "folder" |
| `mimeType: application/pdf` | "PDF" |
| Any `id` field | Never shown; use internally only for follow-up commands |
| JSON objects or arrays | Summarise in prose |
| Email `labelIds`, `threadId`, `messageId` | Never shown |

## Credentials setup (run once per session before any gws command)

`GWS_CREDENTIALS_JSON` contains the credentials as a JSON string. Materialize it to the path gws expects, then verify auth:

```bash
[ -n "$GWS_CREDENTIALS_JSON" ] && echo "$GWS_CREDENTIALS_JSON" > "${GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE:-/tmp/gws-credentials.json}" && export GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE="${GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE:-/tmp/gws-credentials.json}"
gws auth status
```

If `auth_method` is not `none`, credentials are ready. Skip this step on subsequent calls in the same session (the file persists in /tmp for the container lifetime).

## Dispatch table

Match the user's intent to the right category and read the reference file before acting:

| User intent | Category | Reference file |
|---|---|---|
| email, inbox, gmail, send message, unread, triage | Gmail | `references/gmail.md` |
| drive, files, folder, upload, download, share | Drive | `references/drive.md` |
| calendar, agenda, event, meeting, schedule | Calendar | `references/calendar.md` |
| doc, document, write, append, summarise | Docs | `references/docs.md` |
| sheet, spreadsheet, row, data | Sheets | `references/sheets.md` |

**Always read the reference file for the matched category before running a command.**

## Fallback

If no helper covers the case, use the raw API:
```bash
gws <service> --help             # list available subcommands
```
Still translate the output before replying.

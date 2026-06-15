---
name: yahoo-mail
description: Read, search, organize, send, and reply to Yahoo Mail via the ymail CLI. Use for email listing, search, read messages, move, delete, mark read/unread, send new emails, and reply to messages. Triggers on any Yahoo Mail or inbox management request.
allowed-tools: Bash
---

# Yahoo Mail (ymail)

Use the `ymail` CLI via Bash for all Yahoo Mail operations.

## Presentation rules — always enforce

**Never paste raw ymail output into a reply.** Translate every result into plain language before responding.

| Raw output field | What to show instead |
|---|---|
| `uid` | Never shown; use internally only for follow-up commands |
| `messageId` | Never shown; used internally for threading |
| `inReplyTo` | Never shown |
| `from` | Show name and address naturally ("From John Smith") |
| `flags` | Translate: `\Seen` → "read", absence → "unread", `\Flagged` → "starred" |
| JSON objects or arrays | Summarise in prose or a clean list |
| Error JSON | Explain the issue in plain language |
| `total` count | "You have X messages" or "Found X results" |

## Credentials

Environment variables `MERCURY_YAHOO_EMAIL` and `MERCURY_YAHOO_APP_PASSWORD` are pre-injected. No setup step needed — the CLI reads them directly.

If authentication fails, tell the user:
> "Your Yahoo Mail connection needs to be refreshed. Go to your console's Connections page and reconnect Yahoo Mail with a new app-specific password."

## Sending safety

When the user asks to send or reply:
- **Always confirm** the recipient, subject, and a brief preview of the message body before sending.
- Never send an email without the user's explicit "yes" / "send it" / "go ahead" confirmation.
- If the user's intent is ambiguous (e.g. "email John about the meeting"), draft the message and present it for approval first.

## Dispatch table

| User intent | Command | Example |
|---|---|---|
| List folders | `ymail list-folders` | "What folders do I have?" |
| Show recent inbox | `ymail list-inbox [folder] [limit]` | "Show my last 10 emails" → `ymail list-inbox INBOX 10` |
| Search email | `ymail search "<query>" [folder] [limit]` | "Find emails from John" → `ymail search "John" INBOX 20` |
| Read a message | `ymail read <uid> [folder]` | After listing, read a specific message by its uid |
| Move a message | `ymail move <uid> <destination> [source]` | "Move that to Trash" → `ymail move 12345 Trash INBOX` |
| Delete a message | `ymail delete <uid> [folder]` | "Delete that email" → `ymail delete 12345 INBOX` |
| Mark as read | `ymail mark-read <uid> [folder]` | "Mark that as read" |
| Mark as unread | `ymail mark-unread <uid> [folder]` | "Mark that as unread" |
| Send new email | `ymail send <to> <subject> <body>` | "Email john@example.com about the meeting" → confirm, then `ymail send "john@example.com" "Meeting update" "Hi John, ..."` |
| Reply to email | `ymail reply <uid> <body> [folder]` | "Reply to that email" → read the original, compose reply, confirm, then `ymail reply 12345 "Thanks, ..."` |

## Workflow patterns

**Inbox triage:** `list-inbox` → present summary → user picks messages → `read`, `move`, `delete`, or `mark-read` as directed.

**Search then act:** `search` → present matches → user selects → `read` or `move`.

**Folder overview:** `list-folders` → present folder names and message counts.

**Reply flow:** `read <uid>` → compose reply text → present for confirmation → `reply <uid> <body>`.

**Compose flow:** user requests email → draft subject + body → present for confirmation → `send <to> <subject> <body>`.

## Common folder names

| Folder | Yahoo IMAP path |
|---|---|
| Inbox | `INBOX` |
| Sent | `Sent` |
| Drafts | `Draft` |
| Trash | `Trash` |
| Spam | `Bulk Mail` |
| Archive | `Archive` |

When the user says "spam folder", use `"Bulk Mail"`. When they say "drafts", use `"Draft"`.

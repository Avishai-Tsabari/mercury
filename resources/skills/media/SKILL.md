---
name: media
description: Manage media files (inbox/outbox) — check disk usage and purge old files. Use when the user asks to clear files, free up space, or check storage.
---

## Commands

```bash
mrctl media clear              # Purge both inbox and outbox
mrctl media clear --inbox      # Purge inbox only (received files)
mrctl media clear --outbox     # Purge outbox only (produced files)
mrctl disk                     # Show disk usage per space (inbox/outbox breakdown)
mrctl disk --json              # Machine-readable storage info
```

## What is inbox / outbox?

- **inbox/** — Files received from users (images, voice notes, documents)
- **outbox/** — Files produced by the agent (generated images, reports, audio)

## When to purge

- User asks to "clear files", "free up space", "delete my files"
- Disk usage is high (`mrctl disk` shows large inbox/outbox)
- After a task that produced many temporary output files

Purging is **irreversible** — confirm with the user before running.

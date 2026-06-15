---
name: spaces
description: Manage spaces. Use when the user asks about spaces, wants to rename the current space, or delete space data.
---

## Commands

```bash
mrctl spaces list
mrctl spaces name [<name>]
mrctl spaces delete
```

## Details

- `list` — shows all spaces with display names (admin-only; members get 403)
- `name` — with no argument, shows current space name; with argument, renames
- `delete` — deletes the current space and all its data (irreversible)

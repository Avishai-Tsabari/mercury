---
name: permissions
description: View and manage role permissions. Use when the user asks about what permissions a role has, or wants to change what users can do.
---

## Commands

```bash
mrctl permissions show [--role <role>]
mrctl permissions set <role> <perm1,perm2,...>
```

## Built-in permissions

`prompt`, `stop`, `compact`, `tasks.list`, `tasks.create`, `tasks.pause`, `tasks.resume`, `tasks.delete`, `config.get`, `config.set`, `prefs.get`, `prefs.set`, `roles.list`, `roles.grant`, `roles.revoke`, `permissions.get`, `permissions.set`, `spaces.list`, `spaces.rename`, `spaces.delete`

Conversation management uses the existing space permissions: `spaces.list` for listing conversations, `spaces.rename` for linking/unlinking, and `spaces.delete` for deleting the current space.

Extension permissions are also available. Each extension adds its own permission (e.g., `napkin`). Extension CLIs are called directly in bash — permission enforcement is automatic.

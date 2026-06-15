---
name: roles
description: Manage user roles in the current space. Use when the user asks to grant or revoke permissions, make someone an admin, or check who has access.
---

## Commands

```bash
mrctl roles list
mrctl roles grant <platform-user-id> [--role <role>]
mrctl roles revoke <platform-user-id>
```

## Roles

- **admin** — full control over all features (default when granting)
- **member** — can chat with the assistant (default for new users)
- Custom roles can be created by assigning specific permissions

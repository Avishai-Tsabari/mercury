---
name: preferences
description: Manage per-space assistant preferences (sources, habits, domain rules). Use when the user asks to remember something for future replies, set default data sources, or change how you should behave in this space.
---

## Commands

```bash
mrctl prefs list
mrctl prefs get <key>
mrctl prefs set <key> <value...>
mrctl prefs delete <key>
```

- `set` joins all arguments after `<key>` as the value (multi-word text is OK).
- Keys must be short slugs: start with a letter or digit, then letters, digits, `.`, `_`, `-` (max 64 chars total).
- Examples: `stock-sources`, `supermarket-prices`, `locale.defaults`.

## Behavior

- Preferences are **stored per space** and **injected into your context automatically** on every run (you will see a `<preferences>` block). You do not need to `get` them before answering routine questions.
- Use `mrctl prefs` when the user wants to **add, change, remove, or list** what is stored.
- Only **admins** can set or delete (members can read). If the user lacks permission, say so clearly.

## Typical phrases

| User says | Action |
|-----------|--------|
| "Remember to always use X for Y" | Choose a slug key, `mrctl prefs set <key> <instruction>` |
| "What preferences are saved?" | `mrctl prefs list` |
| "Forget the rule about Z" | `mrctl prefs delete <key>` |

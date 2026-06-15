---
name: recall
description: Search past user and assistant messages in this space when the user asks what was said before, wants a fact from an earlier turn, or the current prompt does not include enough history. Use mrctl recall with keywords from the topic.
---

## Command

```bash
mrctl recall "<keywords or phrase>" [--limit N]
```

- Searches stored Mercury message history (case-insensitive substring match).
- Default `--limit` is 20 (max 100 on the server).
- Requires the same permission as `mrctl compact` (`compact`).

## When to use

- User references something from "earlier" or "before" and the pi session may be minimal or compacted.
- You need to verify an exact prior message without loading the full session into context.

## When not to use

- For durable notes and vault content, prefer `napkin search` (when the napkin extension is enabled).
- For the current conversation turn, rely on the user message and attached reply context first.

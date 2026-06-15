---
name: conversation-recap
description: Summarize or translate recent chat (including group ambient context) when the user explicitly asks for a recap, summary of today's conversation, or the same in Hebrew (e.g. סכם, תסכם, מה שאמרנו). Use only when they want history—not for normal questions.
---

## When to use

- User asks to **summarize**, **recap**, **wrap up**, or describe **what was said** (in this chat / today / the thread).
- Hebrew equivalents: **סכם**, **תסכם**, **סיכום השיחה**, **מה שאמרנו**, **מה נאמר היום**, etc.

## Behavior

Mercury usually answers from the **current message only** unless the user is **replying to your last message** (then full thread context loads) or their wording matches **history-style** requests (handled by the host classifier).

When this skill applies, **assume they need prior messages**: if you lack enough context in the current turn, say so briefly and suggest they **reply to your message** with the recap request, or rephrase using words like "summarize what we discussed" so the system loads full session and ambient group messages.

## Optional tools

If `mrctl` or session APIs are available in the environment, you may use them to inspect stored history only when the user clearly asked for a recap—not for unrelated tasks.

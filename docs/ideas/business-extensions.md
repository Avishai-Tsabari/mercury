---
name: business-extensions
description: Dedicated business extensions that wrap raw capabilities (GWS, etc.) with deterministic domain logic — e.g. a barber-appointments extension
metadata:
  type: idea
---

# Business Extensions

**Status**: Idea
**Created**: 2026-07-01

## Problem

Raw capability extensions (GWS Calendar, Gmail, web search) expose generic APIs. Business workflows (appointment booking, customer management) require deterministic logic — availability checks, double-booking prevention, confirmation flows — that can't be reliably delegated to the LLM via prompting alone.

Today the only options are: (1) let the LLM orchestrate raw APIs via system prompt instructions (not deterministic enough), or (2) build a full standalone application outside Mercury. Neither is ideal.

## Idea

A pattern for **business extensions** that wrap raw capabilities with domain-specific, deterministic logic and expose simplified CLIs to the agent.

Example: `barber-appointments` extension
- Wraps GWS Calendar internally
- Exposes: `book-appointment`, `list-availability`, `cancel-appointment`
- Enforces business rules in code: no double-booking, business hours only, minimum slot duration, confirmation required
- Registers as a single Mercury permission (`barber-appointments`)
- The LLM calls the simplified CLI; the extension handles the hard logic deterministically

This separates concerns:
- **Mercury** = platform (messaging, spaces, permissions, rate limits)
- **Capability extensions** = raw API access (GWS, web search, etc.) — admin-only or building blocks
- **Business extensions** = deterministic domain logic wrapping capabilities — customer-facing

## Why not just prompt engineering?

LLMs are non-deterministic. For a barber shop, a double-booked appointment or a cancelled-without-confirmation is a real-world problem. Business rules must be enforced in code, not hoped for via prompts.

## Open questions

- Should business extensions be a separate category in the extension system, or just a convention?
- How do business extensions declare their dependency on capability extensions (e.g., `barber-appointments` needs `gws`)?
- Should there be a template/scaffold for creating business extensions?
- How does this relate to "profiles" — is a profile = business extension + config preset?

## First candidate

`barber-appointments` — Calendar-based appointment booking for a barber shop. Quick win for first customer impression. Gmail integration deferred.

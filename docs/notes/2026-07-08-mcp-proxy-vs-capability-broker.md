# MCP Proxy vs Mercury Capability Broker

**Date**: 2026-07-08
**Context**: Discussion about whether Mercury should use MCP servers as an alternative to the profile-based capability broker pattern documented in `docs/authoring-profiles.md`.

---

## Summary

Compared two approaches for brokering external capabilities (Calendar, email, etc.) to agents: Mercury's built-in profile/capability broker and MCP (Model Context Protocol) proxy servers. The key takeaway is that they solve the same problem — keeping secrets off the agent container while exposing scoped actions — but Mercury's broker provides tighter multi-tenant security guarantees out of the box, while MCP offers protocol portability and ecosystem access.

## Findings

### Mercury Capability Broker (current approach)

- Agent calls `mrctl capability <name> <action> '{...}'` inside the container
- Host-side handler registered via `mercury.capability()` holds credentials
- `req.callerId` is token-derived, unspoofable — used for ownership enforcement
- `member_permissions` in `mercury-profile.yaml` is exhaustive and declarative
- Tightly integrated with spaces, permissions, and multi-tenant identity

### MCP Proxy (alternative)

- MCP server exposes operations as tools the LLM calls directly via the MCP protocol
- Credentials stay on the MCP server, not in the agent container
- Standard protocol — works natively with Claude Desktop, Claude Code, and other MCP clients
- Growing ecosystem of pre-built MCP servers for common APIs
- Does not include Mercury's permission manifest, callerId ownership, or space scoping — these would need to be reimplemented

### Where the MCP server can run

| Location | Use case | Security |
|---|---|---|
| Localhost / sidecar | Single Mercury instance, low latency | Credentials on same host |
| Cloud / remote | Shared capability across multiple Mercury instances | Needs authenticated endpoint |
| Inside agent container | Avoid this | Breaks the trust boundary — credentials exposed to agent |

### Recommended hybrid approach

Use MCP servers as **internal backends** that Mercury's capability handlers delegate to, rather than exposing them directly to the agent. This preserves the profile security model while gaining access to the MCP ecosystem.

```
Agent -> mrctl capability -> Mercury broker (host) -> MCP server -> External API
```

The broker remains the trust boundary. MCP servers become pluggable capability implementations behind it.

## Decisions

- Keep the profile/broker as the security and permission layer facing the agent
- MCP servers, if used, should sit behind the broker as capability backends — never exposed directly to the container

## Open Questions

- [ ] Should Mercury support declaring MCP server backends in `mercury-profile.yaml` (e.g. an `mcp_backends` section)?
- [ ] Is there value in exposing Mercury's broker itself as an MCP server for non-Mercury clients?

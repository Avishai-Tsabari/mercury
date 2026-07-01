# Bug: Strict YAML schema crashes Mercury on unknown config keys

**Status**: In-Progress
**Severity**: major
**Slug**: strict-yaml-schema-crash
**Reported**: 2026-07-01
**Last updated**: 2026-07-01

---

## Summary
`mercuryFileSchema` uses `.strict()` on all Zod objects, causing Mercury to crash on startup when `mercury.yaml` contains any unrecognized key — a typo, a key from a newer version, or a renamed field. Combined with PM2's default unlimited restarts and Baileys' session-based auth, this creates a cascade: config error → crash loop → WhatsApp session revoked → extended downtime requiring manual QR re-scan.

## Steps to Reproduce
1. Add any unrecognized key to `mercury.yaml`, e.g. `dm_auto_space: { admin_numbers: ["123"] }` (renamed to `admin_ids` in 0.4.27)
2. Start Mercury (`mercury run` or `mercury service install`)
3. Mercury crashes with `Invalid mercury.yaml: dm_auto_space: Unrecognized key: "admin_numbers"`
4. PM2 restarts Mercury in a crash loop, each restart fails identically
5. Crash loop causes WhatsApp session to expire (reason=401), requiring re-authentication

## Expected Behavior
Mercury should log a warning about the unknown key and continue starting normally. Invalid *values* (wrong type, out of range) should still crash — the distinction is between "unknown key" (safe to ignore) and "invalid value" (can't run correctly).

## Actual Behavior
Mercury throws an unhandled error and exits. PM2 restart loop compounds the damage by expiring the WhatsApp session.

## Impact
- **Service downtime** — entire Mercury instance goes down, no messages processed
- **WhatsApp session loss** — crash loop causes Baileys auth to expire, requiring manual QR re-scan
- **Version upgrade risk** — any field rename between versions (like `admin_numbers` → `admin_ids`) crashes deployments that haven't updated their yaml
- **Typo intolerance** — a single typo in mercury.yaml takes down the whole service

## Root Cause Analysis

Two separate concerns are conflated by `.strict()`:

1. **Unknown keys** (typo, version mismatch, renamed field) — should warn, not crash. The config isn't invalid, it's just unrecognized. Even with WABA, crashing because of a typo is wrong.
2. **Invalid values** (wrong type, out of range) — should crash. If `port: "abc"`, the service can't run correctly. Fail fast is correct.

The Baileys crash-loop cascade is a separate but compounding problem — on the unofficial WhatsApp protocol, rapid reconnect attempts trigger session revocation by Meta. This makes *any* crash loop catastrophic, not just config-related ones.

## Suspected Location
- `src/config-file.ts` — `mercuryFileSchema` (line 25) and all nested objects use `.strict()`, which rejects unknown keys
- `src/config-file.ts` — `mergeRawMercuryConfig()` (line 352) calls `safeParse` but throws on failure instead of warning

## Fix Plan

### Phase 1 — Short term (now)

**Config resilience:** Remove `.strict()` from `mercuryFileSchema` and all nested objects (Zod default behavior strips unknown keys silently). Add a post-parse diff that logs warnings for any stripped keys so operators notice typos without crashing.

**PM2 restart limit:** Configure `max_restarts` and `min_uptime` in the PM2 ecosystem config so a crash loop stops after N attempts instead of running forever. Send an alert when the limit is hit.

### Phase 2 — Medium term

**Circuit breaker for container errors:** Container failures (model API errors, malformed responses) should not crash the host process. The host should log the error, reply to the user with a friendly message, and continue.

### Phase 3 — Long term (WABA)

With WABA, auth is a permanent API token — crash loops no longer revoke auth. At that point, strict validation on values remains correct (fail fast on truly invalid config), while unknown keys should still warn-not-crash regardless of the WhatsApp transport.

## Notes
- Industry standard (Kubernetes, OpenCode/SST) is to warn on unknown keys, not crash. Zod's default behavior is `.strip()` (silently remove unknown keys) — Mercury explicitly opted into `.strict()` which is the most aggressive mode.
- OpenCode hit the same bug and fixed it by switching to passthrough + warnings (github.com/sst/opencode/issues/6145).
- The Baileys session loss is a known risk of the unofficial protocol — Meta actively discourages bot usage on consumer WhatsApp. WABA eliminates this class of risk entirely.

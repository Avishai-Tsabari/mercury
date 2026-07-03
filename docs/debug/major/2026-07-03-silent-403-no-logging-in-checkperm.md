# Bug: Silent 403 on capability routes — checkPerm logs nothing

**Status**: Fixed
**Severity**: major
**Slug**: silent-403-no-logging-in-checkperm
**Reported**: 2026-07-03
**Last updated**: 2026-07-03

---

## Post-Mortem

### Investigation
Read `src/core/api-types.ts` (lines 44-58) and confirmed `checkPerm()` returns a 403 JSON response with no logging call. Read `src/core/routes/capability.ts` (lines 30-70) and confirmed the only log point is the `catch` block at line 60 — no request-level or permission-denial logging exists.

### Root Cause
`checkPerm()` is a shared permission guard used by 14 route files. It returns a 403 response directly without any `logger.warn` or similar call. The capability route also lacks request-entry logging, so operators have no trace of incoming requests or why they were denied.

### Fix
- `src/core/api-types.ts`: imported `logger` and added `logger.warn("Permission denied", { spaceId, role, permission })` inside the `if (!hasPermission(...))` block, before the 403 response.
- `src/core/routes/capability.ts`: added `logger.info("Capability request", { capability, action, callerId, spaceId })` at the top of the POST handler, before the permission check.

### Lessons
- Permission guards should always log denials at WARN level — a silent 403 is indistinguishable from "the request never happened" when debugging from host logs.
- Request-entry logging on broker routes (capabilities, tasks, etc.) is essential for production profiles where the operator cannot inspect container-internal traffic.

---

## Implementation Checklist
- [x] Add `logger.warn` to `checkPerm()` in `src/core/api-types.ts`
- [x] Add request-level `logger.info` to capability route in `src/core/routes/capability.ts`
- [x] Typecheck passes
- [x] Session code review

---

## Summary
`checkPerm()` returns a 403 response with zero logging, making permission denials invisible to operators.

## Steps to Reproduce
1. Deploy a profile with a capability handler (e.g. `barber-appointments`)
2. Have the agent inside the container call `mrctl capability barber my-appointments`
3. Arrange for the caller to lack the required permission (e.g. stale DB rows after upgrade)
4. Check host-side Mercury logs

## Expected Behavior
A warning-level log line indicating the permission denial, including the space, role, and permission name.

## Actual Behavior
No log output at all. The 403 JSON response is returned silently. Operators cannot distinguish between "the agent didn't call the capability" and "the call was denied."

## Impact
- Operators are blind to permission denials on all routes that use `checkPerm()` (14 route files)
- First production profile deployment wasted ~2 hours debugging a silent 403
- The only way to discover the denial is to instruct the agent to report the raw HTTP error or intercept traffic inside the container

## Suspected Location
- `src/core/api-types.ts:44-58` — `checkPerm()` returns 403 with no `logger.warn`
- `src/core/routes/capability.ts:30-40` — no request-level logging before `checkPerm`

## Notes
- Fix is ~5 lines: add `logger.warn("Permission denied", { spaceId, role, permission })` inside the `if` block in `checkPerm`
- Discovered during the first production deployment of the `barber-appointments` profile on Hetzner VPS running Mercury v0.5.11
- Related to Issue 3 (capability request logging) — both address observability gaps in the capability route

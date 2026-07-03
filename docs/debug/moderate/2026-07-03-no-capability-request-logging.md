# Bug: No capability request logging on success path

**Status**: Fixed (resolved by silent-403-no-logging-in-checkperm)
**Severity**: moderate
**Slug**: no-capability-request-logging
**Reported**: 2026-07-03
**Last updated**: 2026-07-03

---

## Resolution

Closed as already fixed. The request-entry `logger.info("Capability request", ...)` added in commit `992de55` (fix for `silent-403-no-logging-in-checkperm`) covers the important part — operators can see what came in. Response-level logging for every successful call was intentionally omitted: it's noisy for production and not worth adding now. If needed later for auditing, it can be added then.

---

## Summary
The capability route logs nothing on the success path — only handler crashes produce a log line, leaving operators with no visibility into normal capability usage.

## Steps to Reproduce
1. Deploy a profile with a capability handler
2. Have the agent call `mrctl capability <name> <action>` successfully
3. Check host-side Mercury logs

## Expected Behavior
INFO-level log lines at request entry (capability name, action, caller, space) and after successful handler return (status code).

## Actual Behavior
No log output. Only the `catch` block at `capability.ts:60` logs anything, and only on handler exceptions. Successful calls are invisible.

## Impact
- Operators cannot answer basic questions: "Did the agent call `book` or `availability`?" / "Is the capability being used?"
- No audit trail for production profiles handling real customer data (e.g. appointment bookings)
- Debugging requires adding custom `console.error` calls inside the profile's handler code

## Suspected Location
- `src/core/routes/capability.ts:30-70` — no `logger.info` between the permission check and the handler call, and none after a successful return

## Notes
- Fix is ~10 lines: add `logger.info("Capability request", {...})` at handler entry and `logger.info("Capability response", {...})` after successful return
- Related to the silent-403 bug — both address the same observability gap in the capability route, but this one covers the success path
- Discovered during the first production deployment of `barber-appointments` on Hetzner VPS

# Bug: Napkin distill fails to find pi CLI on npm-installed systems

**Status**: In-Progress
**Severity**: moderate
**Slug**: napkin-distill-pi-not-found-npm-install
**Reported**: 2026-07-03
**Last updated**: 2026-07-03

---

## Summary
The napkin `distill` job fails with `spawn failed: Executable not found in $PATH: "pi"` when Mercury is installed globally via npm, because `envWithPiOnPath()` doesn't include the npm global `node_modules/.bin` directory.

## Steps to Reproduce
1. Install Mercury globally via npm on a Linux server: `npm install -g mercury-agent`
2. Configure a Mercury project with the napkin extension enabled and at least one space with messages
3. Wait for the `napkin:distill` job to trigger (hourly) and attempt to distill a space with unprocessed dates

## Expected Behavior
The distill job spawns `pi` successfully and produces knowledge base notes from chat messages.

## Actual Behavior
The distill job fails with:
```
Distillation failed spaceId=dm-... date=2026-07-01 detail=spawn failed: Executable not found in $PATH: "pi"
```
`pi` exists at `/usr/lib/node_modules/mercury-agent/node_modules/.bin/pi` but is not on PATH and not found by the helper.

## Impact
- KB distillation is completely broken on any npm-installed Mercury instance
- Affects all spaces — no knowledge notes are produced, cross-session recall doesn't work
- Silent failure: the job logs an error but continues, so operators may not notice immediately

## Suspected Location
- `examples/extensions/napkin/index.ts` — `envWithPiOnPath()` function (lines 147-165)

## Notes
- Works on bun-installed systems because bun places `pi` in `~/.bun/bin/`, which the helper checks
- npm only symlinks **direct** dependency `bin` entries to the global bin dir; `pi` is a transitive dep (via `@earendil-works/pi-coding-agent`) so npm never creates a `/usr/bin/pi` symlink
- The helper currently only adds `~/.bun/bin` and `/usr/local/bin` — it should also resolve `pi` relative to Mercury's own `node_modules/.bin`
- Quick workaround: `ln -sf /usr/lib/node_modules/mercury-agent/node_modules/.bin/pi /usr/local/bin/pi`

# Bug: Napkin distill fails to find pi CLI on npm-installed systems

**Status**: Fixed
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
- `@earendil-works/pi-coding-agent` is a direct dependency that declares `bin.pi`, but npm global installs only link the top-level package's bins — dependency bins stay in `node_modules/.bin`
- The helper currently only adds `~/.bun/bin` and `/usr/local/bin` — it should also resolve `pi` relative to Mercury's own `node_modules/.bin`
- Quick workaround: `ln -sf /usr/lib/node_modules/mercury-agent/node_modules/.bin/pi /usr/local/bin/pi`

## Implementation Checklist
- [x] Resolve `node_modules/.bin` from package graph via `createRequire`
- [x] Add resolved `.bin` dir as first candidate in `envWithPiOnPath()`
- [x] Typecheck passes
- [x] Session code review

## Post-Mortem

### Investigation
SSH'd into the Hetzner VPS. Confirmed `pi` exists at `/usr/lib/node_modules/mercury-agent/node_modules/.bin/pi` but is not symlinked to `/usr/bin/pi`. Verified that `PATH=/usr/lib/node_modules/mercury-agent/node_modules/.bin:$PATH pi --version` succeeds (0.79.10). Traced `envWithPiOnPath()` which only adds `~/.bun/bin` and `/usr/local/bin` — neither contains `pi` on an npm-installed system.

### Root Cause
`envWithPiOnPath()` used a hardcoded list of well-known bin directories (`~/.bun/bin`, `/usr/local/bin`) to find `pi`. On npm global installs, `pi` is a dependency bin that lives in `node_modules/.bin/` under the Mercury package — npm only symlinks the top-level package's own `bin` entries (mercury, mercury-ctl) to the global bin dir, not dependency bins. The hardcoded list didn't include this path.

### Fix
Added `createRequire(import.meta.url).resolve("@earendil-works/pi-coding-agent/package.json")` to dynamically locate `pi`'s package, then derive the `node_modules/.bin` directory from it. This is added as the first PATH candidate, with a `try/catch` fallback so the existing candidates still work if resolution fails.

File: `examples/extensions/napkin/index.ts` — `envWithPiOnPath()` function.

### Lessons
- Global npm installs don't hoist dependency `bin` entries — only the top-level package's bins get symlinked. Code that spawns a dependency CLI must resolve it from the package graph, not rely on well-known directories.
- Scoped packages (`@org/pkg`) add an extra directory level — `dirname` depth must account for this when traversing from a resolved path back to `node_modules`.

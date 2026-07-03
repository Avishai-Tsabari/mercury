# Bug: No non-interactive `mercury profiles apply` command

**Status**: Fixed
**Severity**: major
**Slug**: no-profiles-apply-cli-command
**Reported**: 2026-07-03
**Last updated**: 2026-07-03

---

## Post-Mortem

### Investigation
Read `src/cli/mercury.ts` to find the profiles CLI — the bug report referenced `src/cli/profiles.ts` which doesn't exist. Found the `profilesCommand` block at line 2055 with `list`, `show`, and `export` subcommands but no `apply`. Also read `src/core/profiles.ts` to confirm `applyProfile()` and `resolveProfileSource()` exist and handle all source types (built-in, local path, git URL). Compared the `setup --profile` path (lines 844-858, older cosmetic copy) with `applyProfile()` (lines 135-173, full applicative activation including `active-profile.json` and capability validation) — confirmed `applyProfile` is the correct function to expose.

### Root Cause
The `profilesCommand` in `src/cli/mercury.ts` had `list`, `show`, and `export` subcommands but no `apply`. The only way to activate a profile was through the interactive `mercury setup --profile` wizard, which prompts for AI provider, model, API key, and platform — making it unusable in automated/headless environments.

### Fix
Added `profiles apply <source>` subcommand to `src/cli/mercury.ts` (after the `export` subcommand). Uses `resolveProfileSource()` to handle built-in names, local paths, and git URLs, then calls `loadProfileFromDir()` and `applyProfile()`. Error handling catches resolution/validation failures with a clean message, and `finally` ensures git-cloned temp dirs are cleaned up.

### Lessons
- New core functions (`applyProfile`) should ship with a CLI entry point from the start — the function existed but was only reachable through an interactive wizard, leaving automated consumers to reverse-engineer the internals.
- The bug report referenced a file (`src/cli/profiles.ts`) that doesn't exist — always verify suspected locations before starting the fix.

---

## Implementation Checklist
- [x] Add `apply <source>` subcommand to `src/cli/mercury.ts`
- [x] Typecheck passes
- [x] Session code review

---

## Summary
There is no non-interactive CLI command to apply an applicative profile; the only entry point (`mercury setup --profile`) launches the full interactive wizard, blocking automated deployments.

## Steps to Reproduce
1. SSH into a headless server running Mercury
2. Attempt to apply a profile directory (e.g. `./barber-appointments`) via the CLI
3. Try `mercury profiles apply ./barber-appointments` — command does not exist
4. Try `mercury setup --profile ./barber-appointments` — launches interactive wizard prompting for AI provider, model, etc.

## Expected Behavior
A `mercury profiles apply <source>` command that calls `applyProfile()` non-interactively and exits.

## Actual Behavior
No such command exists. The `mercury profiles` subcommand has `list`, `show`, and `export` — but no `apply`. The only way to apply a profile in a script is to reverse-engineer and replicate the 4 steps of `applyProfile()` in bash.

## Impact
- Blocks automated deployment of profiles via deploy scripts, CI/CD pipelines, and headless environments
- Workaround (manual bash replication of `applyProfile()`) is fragile — breaks silently if the function changes
- Every profile deployer must independently figure out the internal steps

## Suspected Location
- `src/cli/profiles.ts` — missing `apply` subcommand
- `src/core/profiles.ts` — `applyProfile()` function already exists and does the work (just not exposed via CLI)

## Notes
- Fix is ~15 lines: add an `apply <source>` subcommand to `src/cli/profiles.ts` that calls the existing `applyProfile()` from `src/core/profiles.ts`
- The function performs 4 steps: copy AGENTS.md, copy extensions, validate capabilities, write `active-profile.json`
- Discovered during first production deployment of `barber-appointments` profile

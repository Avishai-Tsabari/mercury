# Bug: No non-interactive `mercury profiles apply` command

**Status**: In-Progress
**Severity**: major
**Slug**: no-profiles-apply-cli-command
**Reported**: 2026-07-03
**Last updated**: 2026-07-03

---

## Implementation Checklist
- [ ] Add `apply <source>` subcommand to `src/cli/profiles.ts`
- [ ] Typecheck passes
- [ ] Session code review

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

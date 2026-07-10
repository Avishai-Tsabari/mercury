# Bug: Napkin distiller spawns pi without LLM credentials

**Status**: Fixed
**Severity**: major
**Slug**: napkin-distiller-missing-llm-credentials
**Reported**: 2026-07-10
**Last updated**: 2026-07-10

---

## Summary
Napkin's KB distillation job spawns `pi` as a host-side child process without injecting LLM provider credentials, causing every distillation run to fail with "Use /login to log into a provider."

## Steps to Reproduce
1. Set up a Mercury project on a Linux VPS
2. Run `mercury auth login anthropic` — credentials are saved to `<projectDir>/<dataDir>/global/auth.json`
3. Enable the napkin extension with distillation enabled
4. Wait for the distillation job to fire (hourly check)
5. Observe errors in logs for every space/date

## Expected Behavior
The distillation job should use the credentials saved by `mercury auth login` to authenticate pi's LLM calls, the same way the container runner injects `ANTHROPIC_OAUTH_TOKEN` for in-container agent runs.

## Actual Behavior
Every distillation attempt fails with:
```
[ERROR] Distillation failed spaceId=dm-... date=2026-07-01 detail=pi exited 1: Use /login to log into a provider via OAuth or API key.
```

The `envWithPiOnPath()` helper in `examples/extensions/napkin/index.ts` only augments PATH — it spreads `process.env` as-is, which does not contain `ANTHROPIC_API_KEY` or `ANTHROPIC_OAUTH_TOKEN`.

## Impact
- All napkin KB distillation is completely broken on any deployment that uses `mercury auth login` for credentials (i.e. not env-var-based auth)
- Knowledge vault never gets populated, so cross-session recall does not work

## Suspected Location
- `examples/extensions/napkin/index.ts` — `envWithPiOnPath()` (line ~145) and `runPromptAgent()` spawn (line ~196)
- `src/storage/pi-auth.ts` — existing `getApiKeyFromPiAuthFile()` helper that container-runner uses but napkin does not
- `src/agent/container-runner.ts` — reference implementation (line ~680) showing the correct pattern

## Notes
- Workaround: symlink Mercury's auth.json to `~/.pi/auth.json` so pi finds it natively — but this is fragile and undocumented
- The fix should call `getApiKeyFromPiAuthFile()` (or equivalent) and inject `ANTHROPIC_API_KEY` into the spawn env inside `envWithPiOnPath()` or at the `runPromptAgent` call site
- Must work cross-platform (Windows/Linux/macOS) — the existing helper and `node:path` joins already handle this

---

## Post-Mortem

### Investigation
Read `examples/extensions/napkin/index.ts` — `envWithPiOnPath()` (line 145) and `runPromptAgent()` (line 175). Confirmed the spawn env is `{ ...process.env, PATH: augmented }` with no API key injection. Compared with `src/agent/container-runner.ts` (line 680) which calls `getApiKeyFromPiAuthFile()` and injects `ANTHROPIC_OAUTH_TOKEN`. Traced `mercury auth login` in `src/cli/mercury.ts` (line 968) — writes to `<dataDir>/global/auth.json`, not `~/.pi/auth.json`. Confirmed the extension can import from `mercury-agent/*` via the loader's symlink in `src/extensions/loader.ts` (line 35-55).

### Root Cause
`mercury auth login anthropic` stores OAuth credentials in `<dataDir>/global/auth.json`. The container-runner resolves this into an API key and injects it as `ANTHROPIC_OAUTH_TOKEN` into the container env. But the napkin extension's host-side `pi` spawns (distillation + consolidation) only augmented PATH via `envWithPiOnPath()` — they never read Mercury's auth file or set any API key env var. Since pi's own auth file (`~/.pi/auth.json`) doesn't exist on the server, pi had no way to authenticate.

### Fix
1. Added `./storage/pi-auth` to `package.json` exports so extensions can import `getApiKeyFromPiAuthFile`.
2. Added `resolvePiAuthEnv()` in `examples/extensions/napkin/index.ts` — mirrors container-runner's credential resolution: checks `MERCURY_ANTHROPIC_API_KEY` / `MERCURY_ANTHROPIC_OAUTH_TOKEN` env vars first (stripping prefix), then falls back to `getApiKeyFromPiAuthFile()` for OAuth token refresh from Mercury's auth.json.
3. Added `extraEnv` parameter to `runPromptAgent()` and `runDistiller()`, spread into the spawn env.
4. Both the distill and consolidate jobs resolve credentials once per run and pass them to all pi spawns.

### Lessons
- Host-side child processes that need LLM access must explicitly receive credentials — they don't inherit container-runner's injection logic.
- When adding new pi spawn sites, check whether credentials are available in the spawn env.

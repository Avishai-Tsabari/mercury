# Bug: Napkin distiller spawns pi without LLM credentials

**Status**: In-Progress
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

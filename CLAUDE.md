# Mercury — Agent Instructions

Personal AI assistant for chat platforms. Runs agents in Docker containers using [pi](https://github.com/badlogic/pi) as the runtime.

## Commands

```bash
bun run check        # Typecheck + lint + test (run before PR)
bun run check:fix    # Same but auto-fix lint issues
bun test             # Tests only
bun run typecheck    # TypeScript only
bun run lint         # Biome only
```

## ⚠️ Safety Rules

- **Never kill processes by port** (e.g. `lsof -ti:8787 | xargs kill`). This can kill the agent process itself if it has an open connection to that port. Use `mercury service uninstall` to stop Mercury cleanly.
- **Never run `mercury run` directly** — always use `mercury service install`. Direct runs block the terminal and don't auto-restart.

## Running a Mercury Project

```bash
cd /path/to/mercury-project
mercury service install   # Installs and starts as a system service
```

The derived Docker image (with extension CLIs) is built automatically on startup if needed, cached by content hash. Do **not** run `mercury build` — that's only for developing the base image from source.

## Running in Background

```bash
mercury service install   # Install as launchd (macOS) or systemd (Linux)
mercury service status    # Check if running
mercury service logs -f   # Tail logs
mercury service uninstall # Remove service
```

## Conventions

- **Commits**: `feat:`, `fix:`, `docs:`, `refactor:`, `chore:`
- **Branches**: `issue-<num>-<slug>` for GitHub issues
- **Tests**: Co-located in `tests/`, use temp DBs
- **Config**: `loadConfig()` in `config.ts` — optional `mercury.yaml` + `MERCURY_*` env (env wins); see `docs/configuration.md`
- **Errors**: Use typed errors from `container-error.ts`

## Refactoring Workflow

Refactoring is audit-first and always behavior-preserving. Never refactor opportunistically inside a feature or bug session — file a finding instead.

```
docs/refactor/
  audits/{date}-{scope}.md    # /f-refactor-audit reports — scored findings, read-only
  {slug}.md                   # active refactor doc (contract, safety net, plan, log)
  archive/{date}-{slug}.md    # completed refactors with retrospective
```

1. **Audit** — `/f-refactor-audit [scope]` reads code (changes nothing) and writes a scored findings report
2. **Execute** — `/f-refactor-dev {audit} F{n}` runs one finding: behavior contract → characterization tests if coverage is thin → small steps with the check suite green after every step, in an isolated worktree
3. **Archive** — retrospective filled, doc moved to `archive/`, squash-merged like `/f-bug-fix`

Prime invariant: a refactor never changes observable behavior. Bugs found mid-refactor are preserved and filed via `/f-bug-report`, not fixed in place.

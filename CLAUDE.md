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

## Planning Workflow

> Added by agentic-project-boilerplate. See docs/ for templates and NEXT-STEPS.md for customization.

One file per feature. Status is tracked by folder and by the `Status` field inside the file.

| Stage | Command | Location |
|-------|---------|----------|
| Idea | `/f-feature-idea` | `docs/ideas/{slug}.md` |
| Planning | `/f-feature-planning` | `docs/backlog/{slug}.md` |
| Implementation | `/f-feature-dev` | `docs/in-progress/{slug}.md` |
| Archive | (automatic) | `docs/archive/{slug}.md` |
| Bug report | `/f-bug-report` | `docs/bugs/{slug}.md` |
| Bug fix | `/f-bug-fix` | `docs/debug/{severity}/` |
| QA | `/f-feature-qa` | — |
| Code review | `/f-review-session` | — |
| Notes | `/f-doc-note` | `docs/notes/` |
| Roadmap sync | `/f-doc-sync` | `docs/ROADMAP.md` |

# Contributing to Mercury

Thanks for your interest in improving Mercury! This guide covers the basics.

## Development setup

Mercury uses [Bun](https://bun.sh) (>= 1.2) as its runtime and [Docker](https://docs.docker.com/get-docker/)
for agent containers.

```bash
git clone https://github.com/Avishai-Tsabari/mercury.git
cd mercury
bun install
```

## Before you open a PR

Run the full check gate — this must pass (it's what CI runs):

```bash
bun run check        # typecheck + lint + tests + custom gates
bun run check:fix    # same, but auto-fixes lint issues
```

Individual steps:

```bash
bun run typecheck    # TypeScript only
bun run lint         # Biome only
bun test             # tests only
```

## Conventions

- **Commits**: Conventional Commits — `feat:`, `fix:`, `docs:`, `refactor:`, `chore:`
- **Branches**: `issue-<num>-<slug>` for GitHub issues
- **Tests**: co-located under `tests/`, use temp DBs (no shared/global state)
- **Config**: `loadConfig()` in `src/config.ts` — optional `mercury.yaml` + `MERCURY_*`
  env (env wins). See [docs/configuration.md](docs/configuration.md).
- **Errors**: use the typed errors from `src/container-error.ts`

## Custom lint gates

Beyond Biome + tsc, the repo enforces a few project-specific gates (run as part of
`bun run check`):

- `check:silent-catch` — no silently-swallowed errors
- `check:sync-calls` — no `spawnSync`/`execSync` reachable from the server event loop
- `check:dep-floors` — dependency version floors stay ahead of known-vuln ranges
- `check:no-hijack-verbs` — naming gate for agent-facing verbs

If a gate flags your change, read its message — each one exists because of a past
regression.

## Reporting issues

- **Bugs / features**: open a GitHub issue with clear repro steps or motivation.
- **Security vulnerabilities**: do **not** open a public issue — see [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).

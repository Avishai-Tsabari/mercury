# Publish Checklist

Before publishing a new version to npm:

1. **`bun run check`** — typecheck + lint + tests
2. **`mercury build`** — if you touched build path, Dockerfiles, or file-copy logic
3. **`mercury init` + `mercury service install`** in a test project — if you touched CLI flow, config loading, or service management
4. **Smoke test assistants** — send a message, verify they respond

## Version bump & publish

```bash
npm version patch --no-git-tag-version   # or minor/major
git add package.json
git commit -m "chore: bump version to $(node -p 'require("./package.json").version')"
git tag "v$(node -p 'require("./package.json").version')"
git push && git push --tags
npm publish
```

Always tag and publish together — `package.json` is the single source of truth for both npm and GitHub.

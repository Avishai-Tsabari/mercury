# Bug: mercury run fails when registry pull fails but local build exists

**Severity:** P1 — blocks users who build locally but have a registry image configured  
**Introduced in:** 0.4.22 (commit 75e8e71)  
**File:** `src/cli/mercury.ts`, `runAction()` (~line 187)

## Symptom

```
$ mercury build          # succeeds → mercury-agent:latest exists locally
$ mercury run
Image 'ghcr.io/avishai-tsabari/mercury-agent:latest' not found locally, pulling...
Error response from daemon: unauthorized

Error: Failed to pull 'ghcr.io/avishai-tsabari/mercury-agent:latest'.
If this is a private registry, authenticate first:
  docker login ghcr.io
```

The user has a working local image (`mercury-agent:latest`) from `mercury build`,
but `mercury run` exits with an error because the configured registry image
can't be pulled (private registry, no auth, offline, etc.).

## Root cause

The 0.4.22 change replaced the local-fallback logic with auto-pull. The old
code tried `mercury-agent:latest` as a fallback when the configured image
wasn't found. The new code attempts `docker pull` and hard-exits on failure —
it never checks whether a locally built image exists.

### Before (0.4.21)

```
configured image not found?
  → try mercury-agent:latest locally
    → found? use it (with warning)
    → not found? error: pull or build
```

### After (0.4.22)

```
configured image not found?
  → is registry image? attempt pull
    → pull fails? hard exit  ← BUG: should fall back to local
  → not registry? error: run mercury build
```

## Fix

After a failed pull of a registry image, check if `mercury-agent:latest`
exists locally before giving up. If it does, use it with a warning.

### Implementation (lines ~187–213 of `src/cli/mercury.ts`)

Replace the current block:

```typescript
if (imageCheck.status !== 0) {
    const isRegistryImage = imageName.includes("/");
    if (isRegistryImage) {
      console.log(`Image '${imageName}' not found locally, pulling...`);
      const pull = spawnSync("docker", ["pull", imageName], {
        stdio: "inherit",
      });
      if (pull.signal) {
        process.exit(1);
      }
      if (pull.status !== 0) {
        const firstSegment = imageName.split("/")[0];
        const registry = firstSegment.includes(".")
          ? firstSegment
          : "docker.io";
        console.error(`\nError: Failed to pull '${imageName}'.`);
        console.error(
          "If this is a private registry, authenticate first:\n" +
            `  docker login ${registry}`,
        );
        process.exit(1);
      }
    } else {
      console.error(`Error: Container image '${imageName}' not found.`);
      console.error("Run 'mercury build' to build it.");
      process.exit(1);
    }
  }
```

With:

```typescript
if (imageCheck.status !== 0) {
    const isRegistryImage = imageName.includes("/");
    let resolved = false;

    if (isRegistryImage) {
      console.log(`Image '${imageName}' not found locally, pulling...`);
      const pull = spawnSync("docker", ["pull", imageName], {
        stdio: "inherit",
      });
      if (pull.signal) {
        process.exit(1);
      }
      if (pull.status === 0) {
        resolved = true;
      }
    }

    // Fallback: if the configured image isn't available (pull failed, not a
    // registry image, or never pulled), try the local build tag.
    if (!resolved) {
      const localTag = "mercury-agent:latest";
      if (imageName !== localTag) {
        const localCheck = spawnSync("docker", ["image", "inspect", localTag], {
          stdio: "pipe",
        });
        if (localCheck.status === 0) {
          console.log(
            `\nℹ️  Using locally built ${localTag} (configured image unavailable)\n`,
          );
          process.env.MERCURY_AGENT_IMAGE = localTag;
          resolved = true;
        }
      }
    }

    if (!resolved) {
      if (isRegistryImage) {
        const firstSegment = imageName.split("/")[0];
        const registry = firstSegment.includes(".")
          ? firstSegment
          : "docker.io";
        console.error(`\nError: Failed to pull '${imageName}'.`);
        console.error(
          "If this is a private registry, authenticate first:\n" +
            `  docker login ${registry}\n` +
            "Or build locally:\n" +
            "  mercury build",
        );
      } else {
        console.error(`Error: Container image '${imageName}' not found.`);
        console.error("Run 'mercury build' to build it.");
      }
      process.exit(1);
    }
  }
```

### Behavior after fix

```
configured image not found?
  → is registry image? attempt pull
    → pull succeeds? use it ✓
    → pull fails? continue to fallback
  → try mercury-agent:latest locally
    → found? use it (with info message) ✓
    → not found? error with both suggestions (login + build) ✓
```

## How to verify

1. Build locally: `mercury build`
2. Ensure no GHCR auth: `docker logout ghcr.io`
3. Set `.env` to `MERCURY_AGENT_IMAGE=ghcr.io/avishai-tsabari/mercury-agent:latest`
4. Run `mercury run` — should fall back to local image with info message
5. Remove local image: `docker rmi mercury-agent:latest`
6. Run `mercury run` — should error with both `docker login` and `mercury build` suggestions

# Container Lifecycle

Mercury runs agent code inside Docker containers. This document covers how containers are managed, what happens when they fail, and how the system recovers.

## Deployment Topology

Mercury uses a two-layer container model. The layers differ between local and production deployments.

### Local (`mercury run`)

```
Local machine
└── mercury run  (host process)
    └── mercury-<ts>-<id>  (inner container, ephemeral --rm, one per message)
```

Mercury runs directly on the host. Each incoming message spawns a short-lived inner container to run the Claude agent, which is deleted automatically on exit (`--rm`).

### Production node

```
Production node
├── orchestrator                (manages the node — start/stop/update agents)
├── traefik                     (routes *.baseDomain → agent containers)
├── mercury-agent-<user1>       (outer container, persistent, one per tenant)
│   └── mercury-<ts>-<id>       (inner container, ephemeral --rm, one per message)
├── mercury-agent-<user2>       (outer container, persistent)
│   └── mercury-<ts>-<id>
└── ...
```

A single node hosts many tenants. Each user's Mercury process runs inside its own persistent outer container (`--restart=unless-stopped`). Inside that, per-message inner containers work exactly as they do locally.

### Why outer containers in production?

| Concern | How outer containers solve it |
|---|---|
| Tenant isolation | Each agent runs in its own container — can't interfere with others |
| Resource limits | `--memory` and `--cpus` enforced per-agent by the orchestrator |
| Routing | Traefik labels assign each container its own subdomain (`agentId.baseDomain`) |
| Independent lifecycle | orchestrator can start/stop/restart/update one agent without touching others |
| Persistent state | Named Docker volume per agent (`mercury-<agentId>-data`) holds SQLite DB, WhatsApp auth, and spaces |

### Comparison

| | Local (`mercury run`) | Production node |
|---|---|---|
| Mercury process | host process | `mercury-agent-<id>` container (`-d --restart=unless-stopped`) |
| Per-message agent | ephemeral container (`--rm`) | ephemeral container (`--rm`) inside the outer container |
| Logs | lost on exit | retained — `--log-opt max-size=20m --log-opt max-file=3` |
| State | host filesystem | named Docker volume |

### Debugging inner container logs

Inner containers are `--rm` and their logs are gone once they exit. To capture them you must stream live while the container runs:

```bash
# Watch for the container to appear
docker ps --filter "label=mercury.managed=true"

# Tail its logs while it runs
docker logs -f mercury-<ts>-<id>
```

On a production node, the outer container logs are always available via SSH:
```bash
docker logs mercury-agent-<agentId> -f
```

---

## Container Identity

Each container is tagged for tracking and cleanup:

| Property | Format | Purpose |
|----------|--------|---------|
| **Name** | `mercury-<timestamp>-<id>` | Unique identifier for logging/debugging |
| **Label** | `mercury.managed=true` | Identifies mercury-owned containers for cleanup |

Example:
```
docker ps --filter "label=mercury.managed=true"
CONTAINER ID   IMAGE              NAMES
a1b2c3d4e5f6   mercury-agent     mercury-1709312456789-1
```

## Timeout

Containers have a maximum runtime to prevent runaway processes.

| Config | Env Var | Default | Range |
|--------|---------|---------|-------|
| `containerTimeoutMs` | `MERCURY_CONTAINER_TIMEOUT_MS` | 5 minutes | 10s – 1h |

When a container exceeds the timeout:
1. Container is killed via `docker kill`
2. `ContainerError` thrown with `reason: "timeout"`
3. User sees: "Container timed out."
4. Queue unblocks, next message can proceed

The host always injects a resolved **model chain** into the container (after `MERCURY_*` passthrough) so retries and fallbacks use the same policy Mercury loaded at startup:

| In-container env | Source (host) | Purpose |
|------------------|---------------|---------|
| `MODEL_CHAIN` | `resolvedModelChain` (from `MERCURY_MODEL_CHAIN` or primary+fallback) | Ordered `{ provider, model }` legs (max 4) |
| `MODEL_RETRY_MAX_PER_LEG` | `MERCURY_MODEL_MAX_RETRIES_PER_LEG` | Extra attempts per leg for transient errors |
| `MODEL_CHAIN_BUDGET_MS` | `effectiveModelChainBudgetMs` | Wall-clock budget for the whole chain (clamped below container timeout) |

## Error Types

Container failures are classified by `ContainerError`:

| Reason | Exit Code | Cause | User Message |
|--------|-----------|-------|--------------|
| `timeout` | — | Exceeded `containerTimeoutMs` | "Container timed out." |
| `oom` | 137 | SIGKILL (OOM, resource limits, or manual kill) | "Container was killed (possibly out of memory)." |
| `aborted` | — | User sent `stop` command | "Stopped current run." |
| `error` | non-zero | Agent crashed or failed | *(error thrown, logged)* |

Exit code 137 = 128 + 9 (SIGKILL), typically from Docker's OOM killer.

## Orphan Cleanup

If the host process crashes or restarts while containers are running, those containers become orphans. On startup, mercury cleans them up:

```
Startup
  │
  └─► runtime.initialize()
        │
        └─► containerRunner.cleanupOrphans()
              │
              ├─► docker ps -a --filter "label=mercury.managed=true"
              ├─► docker rm -f <container-ids>
              └─► Log: "Cleaned up N orphaned container(s)"
```

This ensures:
- No zombie containers consuming resources
- No blocked space queues from previous runs
- Clean state before accepting new work

## Lifecycle Diagram

```
Message received
  │
  ├─► Queue (one per space)
  │
  ├─► Spawn container
  │     • --name mercury-<ts>-<id>
  │     • --label mercury.managed=true
  │     • --rm (auto-remove on exit)
  │
  ├─► Start timeout timer
  │
  ├─► Wait for completion
  │     │
  │     ├─► Success (exit 0) → parse reply + scan outbox/ → respond
  │     ├─► Timeout → kill container → ContainerError(timeout)
  │     ├─► OOM (exit 137) → ContainerError(oom)
  │     ├─► Aborted → ContainerError(aborted)
  │     └─► Other failure → ContainerError(error)
  │
  └─► Cleanup
        • Clear timeout timer
        • Remove from tracking map
        • Queue unblocks (finally block)
```

## Configuration

```bash
# Set container timeout to 10 minutes
export MERCURY_CONTAINER_TIMEOUT_MS=600000

# Use the preset image from GitHub Container Registry
export MERCURY_AGENT_IMAGE=ghcr.io/avishai-tsabari/mercury-agent:latest   # Full (default)
```

## Sandboxing (Bubblewrap)

Mercury uses a two-layer isolation model:

1. **Docker** — isolates the agent from the host
2. **Bubblewrap** — restricts the pi process within the container (defense-in-depth)

The pi agent runs inside `bwrap`, which creates a minimal mount namespace with only the paths needed for the agent: workspace (`/spaces`), app code (`/app`), docs (`/docs`), and runtime dirs (`/root`, `/usr`, `/etc`, `/proc`, `/dev`, `/tmp`). This limits blast radius if the agent is compromised.

| Env Var | Purpose |
|---------|---------|
| `MERCURY_CONTAINER_BWRAP_DOCKER_COMPAT=1` | **Host only.** Adds `docker run --security-opt seccomp=unconfined --cap-add SYS_ADMIN` so `bwrap` can nest inside the agent container (e.g. Docker Desktop). Keeps bubblewrap on. |
| `MERCURY_DISABLE_BUBBLEWRAP=1` | Disable bubblewrap; run pi directly (last resort / debugging) |

If you see `bwrap: Creating new namespace failed: Operation not permitted`, try **`MERCURY_CONTAINER_BWRAP_DOCKER_COMPAT=1`** first so you keep defense-in-depth. Only use `MERCURY_DISABLE_BUBBLEWRAP=1` if compat mode is not enough.

Custom images must install `bubblewrap` for sandboxing to work.

## Agent Image Preset

Mercury publishes an image preset to GitHub Container Registry:

| Preset | Size | Contents |
|--------|------|----------|
| `ghcr.io/avishai-tsabari/mercury-agent:latest` | ~2.8GB | Full devcontainer: Bun, Node.js, Python, Go, git, build tools |

Images are published on each release. Version-specific tags are also available (e.g., `:0.2.0`).

### Building Locally

To build the image locally instead of pulling from the registry:
```bash
./container/build.sh          # Full image (default)
```

Then use `mercury-agent:latest` (without the ghcr.io prefix).

## Custom Agent Images

You can use custom Docker images via `MERCURY_AGENT_IMAGE`.

### Requirements

Your image **must** have:
- `bun` runtime
- `pi` CLI (`@earendil-works/pi-coding-agent`)
- `bubblewrap` (for agent sandboxing)
- `mrctl` wrapper (copied during build)
Extension CLIs (e.g. `pinchtab`, `napkin`, `gws`) are installed in derived images at runtime based on `.mercury/extensions/*` declarations.

### Entry Point

The image must use this entrypoint:
```dockerfile
ENTRYPOINT ["bun", "run", "/app/src/agent/container-entry.ts"]
```

### Required Files

Copy these files into your image at `/app/`:
```dockerfile
COPY src/agent/container-entry.ts /app/src/agent/container-entry.ts
COPY src/agent/pi-failure-class.ts /app/src/agent/pi-failure-class.ts
COPY src/agent/pi-jsonl-parser.ts /app/src/agent/pi-jsonl-parser.ts
COPY src/agent/preferences-prompt.ts /app/src/agent/preferences-prompt.ts
COPY src/cli/mrctl.ts /app/src/cli/mrctl.ts
COPY src/cli/mrctl-http.ts /app/src/cli/mrctl-http.ts
COPY src/extensions/reserved.ts /app/src/extensions/reserved.ts
COPY src/types.ts /app/src/types.ts
```

### mrctl Setup

Create the mrctl wrapper:
```dockerfile
RUN echo '#!/bin/sh\nbun run /app/src/cli/mrctl.ts "$@"' > /usr/local/bin/mrctl && \
    chmod +x /usr/local/bin/mrctl
```

### Volume Mounts

Mercury mounts these paths into containers:
- `/spaces` — Space workspaces (read/write)
- `/home/mercury/.pi/agent` — Global agent config, skills, auth (read/write)
- `/docs/mercury/` — Self-documentation (read-only)

### Example Custom Dockerfile

```dockerfile
FROM your-base-image:tag

# Install Bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/home/mercury/.bun/bin:$PATH"

# Install required CLIs
RUN bun add -g @earendil-works/pi-coding-agent

# Optional: install Playwright/Chromium if your extensions need browser automation
RUN bunx playwright install chromium

WORKDIR /app

# Copy Mercury agent files
COPY src/agent/container-entry.ts /app/src/agent/container-entry.ts
COPY src/agent/pi-failure-class.ts /app/src/agent/pi-failure-class.ts
COPY src/agent/pi-jsonl-parser.ts /app/src/agent/pi-jsonl-parser.ts
COPY src/agent/preferences-prompt.ts /app/src/agent/preferences-prompt.ts
COPY src/cli/mrctl.ts /app/src/cli/mrctl.ts
COPY src/cli/mrctl-http.ts /app/src/cli/mrctl-http.ts
COPY src/extensions/reserved.ts /app/src/extensions/reserved.ts
COPY src/types.ts /app/src/types.ts

# Setup mrctl
RUN echo '#!/bin/sh\nbun run /app/src/cli/mrctl.ts "$@"' > /usr/local/bin/mrctl && \
    chmod +x /usr/local/bin/mrctl

ENTRYPOINT ["bun", "run", "/app/src/agent/container-entry.ts"]
```

### Validation

When using a custom image (not `mercury-agent:*`), Mercury logs a warning at startup:
```
WARN  Using custom agent image
      image: your-image:tag
      note: Ensure image has: bun, pi, bubblewrap, mrctl
```

## API

### `AgentContainerRunner`

```ts
runner.cleanupOrphans()     // Remove orphaned containers (called on startup)
runner.reply(input)         // Run container, returns ContainerResult (reply + outbox files)
runner.abort(spaceId)       // Kill container for a space
runner.killAll()            // Kill all running containers (shutdown)
runner.isRunning(spaceId)   // Check if container is active
runner.activeCount          // Number of running containers
```

### `MercuryCoreRuntime`

```ts
await runtime.initialize()  // Call before accepting work (runs orphan cleanup)
```

### `ContainerError`

```ts
import { ContainerError } from "./agent/container-error.js";

// Properties
error.reason    // "timeout" | "oom" | "aborted" | "error"
error.exitCode  // number | null
error.message   // Human-readable description

// Factory methods
ContainerError.timeout(spaceId)
ContainerError.oom(spaceId, exitCode)
ContainerError.aborted(spaceId)
ContainerError.error(exitCode, output)
```

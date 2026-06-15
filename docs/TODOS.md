# Mercury — Remaining TODOs

This document tracks gaps identified in the comprehensive code review that are not yet addressed. Items are ordered by priority (security first, then reliability, then polish).

---

## Security

### TODO-1: Protect dashboard root routes

**Status:** Open  
**Priority:** Medium  
**Files:** `src/server.ts`

**Issue:** `GET /` and `GET /dashboard` serve the dashboard HTML without authentication. Only `/dashboard/*` (htmx partials, API, SSE) is protected. Users can load the HTML shell without a token.

**Fix:** Apply the same auth middleware to `/` and `/dashboard`, or redirect unauthenticated requests to a login page. When `MERCURY_API_SECRET` is set, require Bearer token or `mercury_token` cookie for these routes.

---

### TODO-2: Harden permission guard

**Status:** Open  
**Priority:** Medium  
**Files:** `src/extensions/permission-guard.ts`

**Issue:** The permission guard blocks CLI names via regex on bash commands. It can be bypassed by:
- `env napkin search "query"`
- `` `which napkin` search "query" ``
- `python3 -c "import subprocess; subprocess.run(['napkin', ...])"`
- Path-based execution: `/root/.bun/bin/napkin`

**Fix options:**
1. Run denied CLIs through an allowlist/blocklist at the pi tool-call layer (if the pi API supports it)
2. Use a wrapper script that validates the command before execution
3. Document that this is defense-in-depth only; rely on extension trust model
4. Consider seccomp or additional bwrap restrictions to limit subprocess execution

**Note:** Bubblewrap limits filesystem access but does not prevent the agent from invoking allowed binaries. The permission guard remains the primary control for which CLIs run.

---

### TODO-3: Sanitize extension install commands

**Status:** Open  
**Priority:** Low  
**Files:** `src/extensions/image-builder.ts`

**Issue:** Extension `install` commands are interpolated directly into Dockerfile `RUN` statements. A malicious extension could inject shell commands that exfiltrate secrets or modify the image.

**Fix options:**
1. Validate install commands against an allowlist (e.g. `bun add -g X`, `npm install -g X`)
2. Run install commands in a sandboxed build step
3. Document that extensions are trusted by design (operator installs them); recommend auditing before `mercury add`

---

## Reliability

### TODO-4: Database migration system

**Status:** Open  
**Priority:** Medium  
**Files:** `src/storage/db.ts`, new `src/storage/migrations/`

**Issue:** Schema evolution uses `CREATE TABLE IF NOT EXISTS` only. Adding columns, changing types, or renaming tables has no migration path.

**Fix:** Implement a simple migration system:
1. Create `migrations/` directory with sequential SQL files (`001_initial.sql`, `002_add_mutes.sql`, …)
2. Add `schema_migrations` table to track applied migrations
3. On startup, run any migrations not yet applied
4. Document migration authoring in `docs/`

---

### TODO-5: Outbox scan race condition

**Status:** Open  
**Priority:** Low  
**Files:** `src/core/outbox.ts`, `src/agent/container-runner.ts`

**Issue:** Outbox scanning uses mtime comparison against `startTime`. Files written at exactly `startTime` or during clock skew could be missed or incorrectly included.

**Fix:** Use a more robust approach (e.g. track written files explicitly, or use a small time buffer). Document the current behavior and edge cases.

---

## Operations

### TODO-6: Run containers as non-root

**Status:** Open  
**Priority:** Low  
**Files:** `container/Dockerfile`, `container/Dockerfile.minimal`, `src/agent/container-runner.ts`

**Issue:** Containers run as root. Chromium uses `--no-sandbox` because it runs as root. This increases blast radius if the container is compromised.

**Fix:**
1. Create a non-root user in the Dockerfile
2. Run the entrypoint as that user (`USER mercury` or similar)
3. Ensure Chromium can run without `--no-sandbox` (may require `--user-data-dir` and other flags, or use a different approach)
4. Update `container-runner.ts` if `docker run` needs `--user` override

**Note:** Bubblewrap runs as the same user as the parent process. Moving the container to non-root would also make bwrap run as non-root, reducing privilege further.

---

### TODO-7: CORS configuration

**Status:** Open  
**Priority:** Low  
**Files:** `src/server.ts`

**Issue:** No CORS headers are set. When Mercury is behind a reverse proxy or accessed from a browser on another origin, cross-origin requests may fail or behave unexpectedly.

**Fix:** Add configurable CORS middleware (e.g. `MERCURY_CORS_ORIGINS`). Default to restrictive (same-origin or empty) for security.

---

## In-Memory State (Deferred)

### TODO-8: Crash-safe rate limiter and queue

**Status:** Deferred  
**Priority:** Low  
**Files:** `src/core/rate-limiter.ts`, `src/core/space-queue.ts`

**Issue:** Rate limiter and queue are in-memory. On crash, rate limit windows reset (allowing burst abuse) and queued work is lost.

**Fix:** Persist rate limit state and queue to SQLite or Redis. Adds complexity; may be acceptable for single-node deployments. Revisit if multi-instance or high-availability is required.

---

## Bubblewrap — What It Mitigates

Bubblewrap adds **defense-in-depth** inside the container:

| Risk | Mitigated by bubblewrap? |
|------|--------------------------|
| **Cross-space data access** | Partially — with per-space mount, `/spaces` only has one space. Bwrap further restricts the pi process to a minimal mount set. |
| **Arbitrary filesystem access** | Yes — pi only sees `/usr`, `/app`, `/etc`, `/docs`, `/spaces`, `/root`, `/proc`, `/dev`, `/tmp`. Cannot access other paths. |
| **Process isolation** | Yes — `--unshare-pid`, `--new-session`, `--die-with-parent` limit process visibility and lifecycle. |
| **Permission guard bypass** | No — bwrap limits *what* the agent can access, not *which commands* it runs. A bypassed guard could still invoke allowed binaries. |
| **Extension install injection** | No — that happens at image build time, before bwrap runs. |
| **Container non-root** | No — bwrap runs as the same user (root) as the container. Moving to non-root would improve both. |

**Summary:** Bubblewrap reduces blast radius if the agent is compromised. It does not replace the permission guard, API auth, or other controls. It is a valuable additional layer.

# Bug: bwrap fails to mount /proc on Linux Docker Engine (non-Desktop)

**Severity:** P1 — blocks all agent responses on standard Linux Docker hosts  
**Affected:** Linux servers running Docker Engine (not Docker Desktop, not gVisor)  
**File:** `src/agent/container-runner.ts`, bwrap compat branch (~line 980)

## Symptom

```
Container error: Container failed (exit code 1): Error: pi CLI failed (1):
bwrap: Can't mount proc on /newroot/proc: Operation not permitted
```

Happens on Linux servers (e.g. Hetzner, AWS EC2, DigitalOcean) running
Docker Engine with the default kernel config. The existing bwrap Docker compat
flags (`seccomp=unconfined`, `apparmor=unconfined`, `CAP_SYS_ADMIN`) are not
sufficient for bwrap to mount `/proc` inside the container.

## Root cause

On Linux Docker Engine, the default seccomp + AppArmor + capability set does
not allow `mount(2)` inside a user namespace, even with:
- `--security-opt seccomp=unconfined`
- `--security-opt apparmor=unconfined`
- `--cap-add SYS_ADMIN`

This is a known limitation: Docker's default behavior strips many mount-related
permissions that `--privileged` restores (device cgroup rules, all capabilities,
full /sys and /proc access).

**Verified:** `--privileged` makes bwrap work:
```bash
# Fails:
docker run --rm --entrypoint bwrap \
  --security-opt seccomp=unconfined --security-opt apparmor=unconfined \
  --cap-add SYS_ADMIN mercury-agent:latest \
  --ro-bind /usr /usr --proc /proc --dev /dev --unshare-pid echo hello
# → bwrap: Can't mount proc on /newroot/proc: Operation not permitted

# Works:
docker run --rm --entrypoint bwrap --privileged mercury-agent:latest \
  --ro-bind /usr /usr --proc /proc --dev /dev --unshare-pid echo hello
# → execvp echo: No such file or directory  (bwrap ran fine, echo just not in /usr)
```

## Fix

### Option A: Add `--privileged` flag to bwrap compat (recommended short-term)

In `container-runner.ts` (~line 985), replace the current compat flags with
`--privileged` when `containerBwrapDockerCompat` is explicitly set to `true`:

```typescript
    } else if (this.config.containerBwrapDockerCompat || isDockerDesktop()) {
      logger.info("Enabling bwrap Docker compat (seccomp/apparmor/SYS_ADMIN)", {
        configFlag: this.config.containerBwrapDockerCompat,
        dockerDesktop: isDockerDesktop(),
      });
      if (this.config.containerBwrapDockerCompat) {
        // Explicit opt-in: Linux Docker Engine needs --privileged for bwrap
        // to mount /proc inside a user namespace. The finer-grained flags
        // (seccomp=unconfined + apparmor=unconfined + SYS_ADMIN) are not
        // sufficient on standard Linux kernels.
        args.push("--privileged");
      } else {
        // Docker Desktop auto-detection: use the lighter-weight flags
        // (Docker Desktop's VM has a more permissive kernel config)
        args.push(
          "--security-opt",
          "seccomp=unconfined",
          "--security-opt",
          "apparmor=unconfined",
          "--cap-add",
          "SYS_ADMIN",
        );
      }
    }
```

This keeps the lighter flags for Docker Desktop (where they work) and uses
`--privileged` only when the user explicitly opted in via
`MERCURY_CONTAINER_BWRAP_DOCKER_COMPAT=true`.

### Option B: Add a separate `MERCURY_CONTAINER_PRIVILEGED` config flag

If you prefer to keep the compat flag behavior unchanged, add a new flag:

In `config.ts`, add:
```typescript
containerPrivileged: boolean; // default: false
```

In `config-file.ts`, add the env mapping:
```typescript
containerPrivileged: "MERCURY_CONTAINER_PRIVILEGED",
```

In `container-runner.ts`, after the existing compat block:
```typescript
    if (this.config.containerPrivileged) {
      args.push("--privileged");
    }
```

User sets `MERCURY_CONTAINER_PRIVILEGED=true` in `.env`.

### Option C: Auto-detect and use --privileged as fallback

Run a probe container on startup to test if bwrap works with the lighter
flags. If it fails, automatically escalate to `--privileged` and log a
warning. This is the most user-friendly but adds startup latency.

## Workaround (immediate)

Until the fix is in place, users can work around this by manually running
mercury with Docker's `--privileged` flag. However, since `mercury run`
doesn't expose extra Docker args, the only current workaround is to
modify `MERCURY_AGENT_IMAGE` to point to a locally-built image and skip
bwrap entirely by setting `MERCURY_CONTAINER_RUNTIME=runsc` (requires
gVisor installed), or to apply the code change.

## Linux server setup checklist

These sysctl settings are needed regardless of the fix above:

```bash
sysctl -w kernel.unprivileged_userns_clone=1
sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
cat > /etc/sysctl.d/99-bubblewrap.conf << 'EOF'
kernel.unprivileged_userns_clone=1
kernel.apparmor_restrict_unprivileged_userns=0
EOF
```

## How to verify

1. Set `MERCURY_CONTAINER_BWRAP_DOCKER_COMPAT=true` in `.env`
2. Start mercury: `pm2 restart all` or `mercury service install`
3. Run: `mercury chat 'hello'`
4. Check logs — should see successful container run, no bwrap errors

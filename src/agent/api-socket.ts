import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Per-agent inner→outer API unix socket.
 *
 * In gVisor (runsc) mode the outer agent container leaves the shared Docker
 * default bridge (docker0), so inner containers can no longer reach the API over
 * TCP. They reach it over a unix socket that lives in the per-agent data volume
 * — already visible to host-sibling inner containers through the
 * MERCURY_HOST_DATA_DIR host-path translation.
 *
 * The socket name is per-container-unique (`api-<hostname>.sock`) because during
 * a blue-green deploy the canonical container and its `-next` sibling mount the
 * *same* data volume simultaneously; a fixed name would collide on the second
 * bind. `<hostname>` is the Docker short container ID (the container's hostname),
 * so each outer process owns a distinct socket and injects its own name into the
 * inner containers it spawns.
 *
 * Requires the Docker daemon to register `runsc` with `--host-uds=open` so the
 * gVisor gofer will proxy `connect()` to the bind-mounted host socket — see
 * node-cloud-init.ts.
 */

/** Directory (relative to the agent data dir) holding per-container API sockets. */
export const API_SOCKET_SUBDIR = "run";

/** Mount point for the run dir inside inner gVisor containers. */
export const INNER_RUN_DIR = "/run/mercury";

/**
 * Sanitize a hostname into a filesystem-safe socket-name component. Docker sets
 * the container hostname to the short container ID (hex), but we defensively
 * strip anything outside `[a-zA-Z0-9_-]` in case of a custom `--hostname`.
 */
function sanitizeHostname(hostname: string): string {
  const cleaned = hostname.replace(/[^a-zA-Z0-9_-]/g, "");
  return cleaned || "default";
}

/** Per-container socket file name, e.g. `api-3f9c2a1b4d5e.sock`. */
export function apiSocketName(hostname: string = os.hostname()): string {
  return `api-${sanitizeHostname(hostname)}.sock`;
}

/** Run dir holding the API sockets, given a (resolved) data-dir base path. */
export function apiSocketDir(dataDir: string): string {
  return path.join(dataDir, API_SOCKET_SUBDIR);
}

/** Absolute path to this container's API socket inside the outer container. */
export function apiSocketPath(
  dataDir: string,
  hostname: string = os.hostname(),
): string {
  return path.join(apiSocketDir(dataDir), apiSocketName(hostname));
}

/**
 * Path an inner container uses to reach the socket (the bind-mounted run dir).
 * Always POSIX — this is a Linux-container path regardless of the host OS.
 */
export function innerApiSocketPath(hostname: string = os.hostname()): string {
  return path.posix.join(INNER_RUN_DIR, apiSocketName(hostname));
}

/**
 * Connect-test a socket: any HTTP response (even 503 "warming") means a server
 * is listening. A refused/timed-out connect means the socket is an orphan inode.
 */
export async function isApiSocketLive(socketPath: string): Promise<boolean> {
  try {
    const res = await fetch("http://localhost/health", {
      unix: socketPath,
      signal: AbortSignal.timeout(500),
    } as RequestInit & { unix: string });
    await res.body?.cancel();
    return true;
  } catch {
    return false;
  }
}

/**
 * Sweep orphan API sockets left on the persistent data volume by prior deploys.
 *
 * Each blue-green `-next` binds a fresh `api-<hostname>.sock`; the removed old
 * container leaves its 0-byte socket inode behind. On startup we connect-test
 * every `api-*.sock` except our own and unlink the dead ones. Safe during a
 * blue-green swap: a live sibling's socket answers the connect and is kept; a
 * sibling that is mid-startup (socket file present but not yet listening) may be
 * unlinked, but it re-creates the file on bind (unlink-stale-then-listen), so no
 * correctness issue. Orphans are inert if left — this is hygiene only.
 */
export async function sweepOrphanApiSockets(
  dataDir: string,
  keepName: string,
  log?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  },
  isLive: (socketPath: string) => Promise<boolean> = isApiSocketLive,
): Promise<void> {
  const dir = apiSocketDir(dataDir);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return; // run dir doesn't exist yet — nothing to sweep
  }
  for (const name of entries) {
    if (!name.startsWith("api-") || !name.endsWith(".sock")) continue;
    if (name === keepName) continue;
    const full = path.join(dir, name);
    if (await isLive(full)) continue; // live sibling — keep
    try {
      fs.unlinkSync(full);
      log?.info("Swept orphan API socket", { socket: full });
    } catch (err) {
      log?.warn("Failed to unlink orphan API socket", {
        socket: full,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

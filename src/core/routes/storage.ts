import { mkdirSync } from "node:fs";
import { readdir, stat, statfs } from "node:fs/promises";
import path from "node:path";

export type SpaceStorageInfo = {
  spaceId: string;
  inboxBytes: number;
  outboxBytes: number;
  totalBytes: number;
};

export type StorageResponse = {
  disk: {
    totalBytes: number;
    usedBytes: number;
    freeBytes: number;
    usedPercent: number;
  };
  spaces: SpaceStorageInfo[];
  databaseBytes: number;
};

/**
 * Runs a single `du -sb <path1> <path2> ...` and returns a map of path → bytes.
 * Missing paths are reported as 0 (du exits non-zero but still outputs what it can).
 * Linux/Docker only — GNU coreutils `du -sb` is always available in production.
 */
async function batchDirSizes(paths: string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (paths.length === 0) return result;
  try {
    const proc = Bun.spawn(["du", "-sb", ...paths], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    for (const line of out.split("\n")) {
      const tab = line.indexOf("\t");
      if (tab === -1) continue;
      const bytes = parseInt(line.slice(0, tab), 10);
      const p = line.slice(tab + 1).trim();
      if (!Number.isNaN(bytes) && p) result.set(p, bytes);
    }
  } catch {
    // du unavailable or all paths missing; leave map empty (callers default to 0)
  }
  return result;
}

/** Returns file size in bytes. Returns 0 if file is missing. */
async function fileSizeBytes(filePath: string): Promise<number> {
  try {
    const s = await stat(filePath);
    return s.size;
  } catch {
    return 0;
  }
}

export async function getStorageInfo(opts: {
  spacesDir: string;
  dbPath: string;
}): Promise<StorageResponse> {
  const { spacesDir, dbPath } = opts;

  // Filesystem-level stats
  let disk: StorageResponse["disk"] = {
    totalBytes: 0,
    usedBytes: 0,
    freeBytes: 0,
    usedPercent: 0,
  };
  try {
    const fs = await statfs(spacesDir);
    const totalBytes = fs.blocks * fs.bsize;
    const freeBytes = fs.bavail * fs.bsize; // available to non-root
    const usedBytes = totalBytes - freeBytes;
    const usedPercent = totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0;
    disk = { totalBytes, usedBytes, freeBytes, usedPercent };
  } catch {
    // statfs unavailable (e.g. spacesDir not yet created); leave zeroed
  }

  // Per-space breakdown — single du invocation for all inbox/outbox dirs
  let spaceDirs: string[] = [];
  try {
    const entries = await readdir(spacesDir, { withFileTypes: true });
    spaceDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    // spacesDir unreadable or doesn't exist yet
  }

  const allPaths: string[] = [];
  for (const spaceId of spaceDirs) {
    const base = path.join(spacesDir, spaceId);
    allPaths.push(path.join(base, "inbox"));
    allPaths.push(path.join(base, "outbox"));
  }

  const [sizes, databaseBytes] = await Promise.all([
    batchDirSizes(allPaths),
    fileSizeBytes(dbPath),
  ]);

  const spaces: SpaceStorageInfo[] = spaceDirs.map((spaceId) => {
    const base = path.join(spacesDir, spaceId);
    const inboxBytes = sizes.get(path.join(base, "inbox")) ?? 0;
    const outboxBytes = sizes.get(path.join(base, "outbox")) ?? 0;
    return {
      spaceId,
      inboxBytes,
      outboxBytes,
      totalBytes: inboxBytes + outboxBytes,
    };
  });

  return { disk, spaces, databaseBytes };
}

/**
 * Ensures the spaces directory exists. Call once at startup, not per-request.
 */
export function ensureSpacesDirExists(spacesDir: string): void {
  mkdirSync(spacesDir, { recursive: true });
}

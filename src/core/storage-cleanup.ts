import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { Db } from "../storage/db.js";

interface CleanupOpts {
  config: AppConfig;
  db: Db;
  log: Logger;
  isSpaceActive: (spaceId: string) => boolean;
}

interface CleanupResult {
  spacesScanned: number;
  spacesSkipped: number;
  filesDeleted: number;
  bytesFreed: number;
  attachmentsNullified: number;
}

/**
 * Scan all space directories and delete inbox/outbox files older than their TTL.
 * Skips spaces with active container runs.
 */
export async function runStorageCleanup(
  opts: CleanupOpts,
): Promise<CleanupResult> {
  const { config, db, log, isSpaceActive } = opts;
  const spacesDir = config.spacesDir;
  const inboxMaxAge = config.inboxTtlDays * 24 * 60 * 60 * 1000;
  const outboxMaxAge = config.outboxTtlDays * 24 * 60 * 60 * 1000;
  const now = Date.now();

  const result: CleanupResult = {
    spacesScanned: 0,
    spacesSkipped: 0,
    filesDeleted: 0,
    bytesFreed: 0,
    attachmentsNullified: 0,
  };

  let spaceDirs: string[];
  try {
    spaceDirs = fs
      .readdirSync(spacesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return result;
  }

  for (const spaceId of spaceDirs) {
    result.spacesScanned++;

    if (isSpaceActive(spaceId)) {
      result.spacesSkipped++;
      continue;
    }

    const spaceDir = path.join(spacesDir, spaceId);
    let inboxCleaned = false;

    const inboxResult = cleanDir(
      path.join(spaceDir, "inbox"),
      now,
      inboxMaxAge,
    );
    result.filesDeleted += inboxResult.deleted;
    result.bytesFreed += inboxResult.bytesFreed;
    if (inboxResult.deleted > 0) inboxCleaned = true;

    const outboxResult = cleanDir(
      path.join(spaceDir, "outbox"),
      now,
      outboxMaxAge,
    );
    result.filesDeleted += outboxResult.deleted;
    result.bytesFreed += outboxResult.bytesFreed;

    if (inboxCleaned) {
      const nullified = db.clearSpaceAttachments(spaceId);
      result.attachmentsNullified += nullified;
    }
  }

  if (result.filesDeleted > 0) {
    log.info("Storage cleanup complete", {
      spacesScanned: result.spacesScanned,
      spacesSkipped: result.spacesSkipped,
      filesDeleted: result.filesDeleted,
      bytesFreed: result.bytesFreed,
      attachmentsNullified: result.attachmentsNullified,
    });
  }

  return result;
}

function cleanDir(
  dir: string,
  now: number,
  maxAgeMs: number,
): { deleted: number; bytesFreed: number } {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { deleted: 0, bytesFreed: 0 };
  }

  let deleted = 0;
  let bytesFreed = 0;

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name.startsWith(".")) continue;

    const filePath = path.join(dir, entry.name);

    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }

    if (now - stat.mtimeMs < maxAgeMs) continue;

    try {
      fs.unlinkSync(filePath);
      deleted++;
      bytesFreed += stat.size;
    } catch {
      // File may have been deleted between stat and unlink
    }
  }

  return { deleted, bytesFreed };
}

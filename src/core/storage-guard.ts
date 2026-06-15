import { statfs } from "node:fs/promises";
import type { AppConfig } from "../config.js";

/**
 * Check whether the agent's data directory is over its disk quota.
 * Returns false (fail-open) when:
 *   - maxDiskMb is unset (local/self-hosted — no enforcement)
 *   - statfs fails (Windows, unmounted dir)
 *   - statfs returns 0 total bytes (unknown filesystem)
 */
export async function isOverQuota(config: AppConfig): Promise<boolean> {
  if (!config.maxDiskMb) return false;

  try {
    const fs = await statfs(config.spacesDir);
    const totalBytes = fs.blocks * fs.bsize;
    if (totalBytes === 0) return false;
    const freeBytes = fs.bavail * fs.bsize;
    const usedBytes = totalBytes - freeBytes;
    return usedBytes > config.maxDiskMb * 1024 * 1024;
  } catch {
    return false;
  }
}

import { rmSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import { checkPerm, type Env, getApiCtx, getAuth } from "../api-types.js";

export const media = new Hono<Env>();

/**
 * POST /media/purge — Remove files from inbox and/or outbox for the current space.
 * Body (optional): { inbox?: boolean, outbox?: boolean }
 * Defaults to purging both if neither is specified.
 */
media.post("/purge", async (c) => {
  const { spaceId } = getAuth(c);
  const denied = checkPerm(c, "media.purge");
  if (denied) return denied;

  const { config } = getApiCtx(c);

  let inbox = true;
  let outbox = true;
  try {
    const body = (await c.req.json()) as {
      inbox?: boolean;
      outbox?: boolean;
    };
    // If caller explicitly specifies, honour their choice
    if (body.inbox !== undefined || body.outbox !== undefined) {
      inbox = body.inbox ?? false;
      outbox = body.outbox ?? false;
    }
  } catch {
    // No body or invalid JSON → purge both (default)
  }

  const spaceDir = path.join(config.spacesDir, spaceId);
  const result: { inbox: number; outbox: number } = { inbox: 0, outbox: 0 };

  if (inbox) {
    result.inbox = await purgeDir(path.join(spaceDir, "inbox"));
  }
  if (outbox) {
    result.outbox = await purgeDir(path.join(spaceDir, "outbox"));
  }

  return c.json({
    purged: result,
    total: result.inbox + result.outbox,
  });
});

/** Remove all files inside a directory (non-recursive into subdirs). Returns count of removed entries. */
async function purgeDir(dir: string): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0; // directory doesn't exist
  }

  let count = 0;
  for (const entry of entries) {
    try {
      rmSync(path.join(dir, entry), { recursive: true, force: true });
      count++;
    } catch {
      // skip entries that can't be removed
    }
  }
  return count;
}

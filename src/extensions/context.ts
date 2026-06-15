/**
 * Factory for MercuryExtensionContext — keeps dashboard and runtime in sync.
 */

import type { AppConfig } from "../config.js";
import { hasPermission, resolveRole } from "../core/permissions.js";
import type { Logger } from "../logger.js";
import type { Db } from "../storage/db.js";
import type { MercuryExtensionContext } from "./types.js";

export function createMercuryExtensionContext(opts: {
  db: Db;
  config: AppConfig;
  log: Logger;
}): MercuryExtensionContext {
  const { db, config, log } = opts;
  return {
    db,
    config,
    log,
    hasCallerPermission(
      spaceId: string,
      callerId: string,
      permission: string,
    ): boolean {
      const seededAdmins = config.admins
        ? config.admins
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
      const role = resolveRole(db, spaceId, callerId, seededAdmins);
      return hasPermission(db, spaceId, role, permission);
    },
  };
}

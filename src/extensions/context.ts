/**
 * Factory for MercuryExtensionContext — keeps dashboard and runtime in sync.
 */

import type { AppConfig } from "../config.js";
import { hasPermission, resolveRole } from "../core/permissions.js";
import type { Logger } from "../logger.js";
import type { Db } from "../storage/db.js";
import {
  type ConfigRegistry,
  GLOBAL_CONFIG_SPACE_ID,
} from "./config-registry.js";
import type { MercuryExtensionContext } from "./types.js";

/**
 * Resolve an extension config value:
 * per-space → `@global` scope → mercury.yaml `extensions:` → registered default.
 */
export function resolveExtensionConfig(opts: {
  db: Db;
  config: AppConfig;
  configRegistry?: ConfigRegistry | null;
  spaceId: string;
  key: string;
}): string | null {
  const { db, config, configRegistry, spaceId, key } = opts;

  if (spaceId !== GLOBAL_CONFIG_SPACE_ID) {
    const spaceValue = db.getSpaceConfig(spaceId, key);
    if (spaceValue !== null) return spaceValue;
  }

  const globalValue = db.getSpaceConfig(GLOBAL_CONFIG_SPACE_ID, key);
  if (globalValue !== null) return globalValue;

  // Optional chaining: tests and older callers may pass a partial AppConfig.
  const yamlValue = config.parsedExtensionDefaults?.[key];
  if (yamlValue !== undefined) return yamlValue;

  return configRegistry?.get(key)?.default ?? null;
}

export function createMercuryExtensionContext(opts: {
  db: Db;
  config: AppConfig;
  log: Logger;
  configRegistry?: ConfigRegistry | null;
}): MercuryExtensionContext {
  const { db, config, log, configRegistry } = opts;
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
    getConfig(spaceId: string, key: string): string | null {
      return resolveExtensionConfig({
        db,
        config,
        configRegistry,
        spaceId,
        key,
      });
    },
  };
}

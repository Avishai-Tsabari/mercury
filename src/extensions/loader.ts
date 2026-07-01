/**
 * Extension discovery, loading, and registry.
 *
 * Scans `.mercury/extensions/` for directories with index.ts,
 * loads them, validates, and builds a registry.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "../logger.js";
import type { Db } from "../storage/db.js";
import { MercuryExtensionAPIImpl } from "./api.js";
import type { ConfigRegistry } from "./config-registry.js";
import { RESERVED_EXTENSION_NAMES } from "./reserved.js";
import type {
  CapabilityHandler,
  EventHandler,
  ExtensionMeta,
  JobDef,
  MercuryEvents,
} from "./types.js";

/** Extension names must be alphanumeric + hyphens. */
const VALID_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

const __loaderDir = path.dirname(fileURLToPath(import.meta.url));
/** Root of the mercury-agent package (parent of `src/`). */
const MERCURY_PACKAGE_ROOT = path.resolve(__loaderDir, "../..");

/**
 * Ensure `<extensionsDir>/node_modules/mercury-agent` resolves to this framework
 * package so extensions can `import ... from "mercury-agent"` (e.g. `mercury-agent/tts`).
 */
function ensurePackageLink(extensionsDir: string): void {
  const expectedRoot = path.resolve(MERCURY_PACKAGE_ROOT);
  const nmDir = path.join(extensionsDir, "node_modules");
  const linkPath = path.join(nmDir, "mercury-agent");

  try {
    if (fs.existsSync(linkPath) && fs.realpathSync(linkPath) === expectedRoot) {
      return;
    }
  } catch {
    /* broken symlink or unreadable — replace */
  }

  if (fs.lstatSync(linkPath, { throwIfNoEntry: false }) !== undefined) {
    fs.rmSync(linkPath, { recursive: true, force: true });
  }

  fs.mkdirSync(nmDir, { recursive: true });
  const linkType = process.platform === "win32" ? "junction" : "dir";
  fs.symlinkSync(expectedRoot, linkPath, linkType);
}

export class ExtensionRegistry {
  private readonly extensions = new Map<string, ExtensionMeta>();

  /**
   * Load all extensions from one or more directories.
   * The first directory is the primary (user extensions),
   * additional directories are for built-in extensions shipped with Mercury.
   *
   * `envOverride` replaces `process.env` for credential gate checks only —
   * used by the pre-build endpoint to simulate the target container's env.
   */
  async loadAll(
    extensionsDir: string,
    db: Db,
    log: Logger,
    configRegistry?: ConfigRegistry | null,
    extraDirs: string[] = [],
    envOverride?: Record<string, string>,
  ): Promise<void> {
    const dirs = [extensionsDir, ...extraDirs];
    for (const dir of dirs) {
      await this.loadFromDir(
        dir,
        db,
        log,
        configRegistry ?? undefined,
        envOverride,
      );
    }
  }

  private async loadFromDir(
    extensionsDir: string,
    db: Db,
    log: Logger,
    configRegistry?: ConfigRegistry,
    envOverride?: Record<string, string>,
  ): Promise<void> {
    if (!fs.existsSync(extensionsDir)) {
      log.debug(`Extensions directory not found: ${extensionsDir}`);
      return;
    }

    ensurePackageLink(extensionsDir);

    const entries = fs.readdirSync(extensionsDir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const name = entry.name;
      if (name === "node_modules") continue;

      const extDir = path.join(extensionsDir, name);

      // Validate name format
      if (!VALID_NAME_RE.test(name)) {
        log.warn(
          `Skipping extension "${name}": invalid name (must be lowercase alphanumeric + hyphens)`,
        );
        continue;
      }

      // Check reserved names
      if (RESERVED_EXTENSION_NAMES.has(name)) {
        throw new Error(`Extension "${name}" conflicts with built-in command`);
      }

      // Check for index.ts
      const indexPath = path.join(extDir, "index.ts");
      if (!fs.existsSync(indexPath)) {
        log.warn(
          `Skipping extension "${name}": no index.ts found in ${extDir}`,
        );
        continue;
      }

      // Skip if already loaded (user extensions take precedence over built-in)
      if (this.extensions.has(name)) {
        log.debug(`Skipping duplicate extension "${name}" (already loaded)`);
        continue;
      }

      try {
        const meta = await loadExtension(name, extDir, indexPath, db);

        // Credential gate: skip connection extensions whose credential env var is unset.
        // When envOverride is provided (pre-build simulation), check it instead of process.env.
        const credVar = meta.connection?.credentialEnvVar;
        const envToCheck = envOverride ?? process.env;
        if (credVar && !envToCheck[credVar]) {
          log.debug(
            `Skipping extension "${name}": connection credential env var ${credVar} is not set`,
          );
          continue;
        }

        // Register extension config keys in the config registry
        if (configRegistry) {
          for (const [key, def] of meta.configs) {
            configRegistry.register(name, key, def);
          }
        }
        this.extensions.set(name, meta);
        log.info(`Loaded extension: ${name}`);
      } catch (err) {
        log.error(
          `Failed to load extension "${name}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /** Get an extension by name. */
  get(name: string): ExtensionMeta | undefined {
    return this.extensions.get(name);
  }

  /** List all loaded extensions. */
  list(): ExtensionMeta[] {
    return [...this.extensions.values()];
  }

  /** Get extensions that declare a CLI. */
  getCliExtensions(): ExtensionMeta[] {
    return this.list().filter((ext) => ext.clis.length > 0);
  }

  /**
   * Find a registered host-side capability handler by name, with its owning
   * extension. Returns undefined when no extension registered it.
   */
  getCapability(
    name: string,
  ): { ext: ExtensionMeta; handler: CapabilityHandler } | undefined {
    for (const ext of this.extensions.values()) {
      const handler = ext.capabilities.get(name);
      if (handler) return { ext, handler };
    }
    return undefined;
  }

  /** Get all env var source names claimed by extensions (for passthrough filtering). */
  getClaimedEnvSources(): Set<string> {
    const sources = new Set<string>();
    for (const ext of this.extensions.values()) {
      for (const envDef of ext.envVars) {
        sources.add(envDef.from);
      }
    }
    return sources;
  }

  /** Get all hook handlers for a specific event, across all extensions. */
  getHookHandlers<E extends keyof MercuryEvents>(event: E): EventHandler<E>[] {
    const handlers: EventHandler<E>[] = [];
    for (const ext of this.extensions.values()) {
      const extHandlers = ext.hooks.get(event);
      if (extHandlers) {
        handlers.push(...(extHandlers as EventHandler<E>[]));
      }
    }
    return handlers;
  }

  /** Get all jobs across all extensions. */
  getJobs(): Array<{ extension: string; name: string; def: JobDef }> {
    const jobs: Array<{ extension: string; name: string; def: JobDef }> = [];
    for (const ext of this.extensions.values()) {
      for (const [name, def] of ext.jobs) {
        jobs.push({ extension: ext.name, name, def });
      }
    }
    return jobs;
  }

  /** Number of loaded extensions. */
  get size(): number {
    return this.extensions.size;
  }
}

/**
 * Load a single extension: import its index.ts, run the setup function,
 * and return the collected metadata.
 */
async function loadExtension(
  name: string,
  extDir: string,
  indexPath: string,
  db: Db,
): Promise<ExtensionMeta> {
  const mod = await import(indexPath);
  const setup = mod.default;

  if (typeof setup !== "function") {
    throw new Error(
      `Extension "${name}": index.ts must export a default function`,
    );
  }

  const api = new MercuryExtensionAPIImpl(name, extDir, db);
  await setup(api);
  const meta = api.getMeta();

  if (meta.connection) {
    if (!meta.permission) {
      throw new Error(
        `Extension "${name}": connection() requires permission() — credentials must be gated`,
      );
    }
    const { credentialEnvVar, statusCheck } = meta.connection;
    if (!credentialEnvVar && !statusCheck) {
      throw new Error(
        `Extension "${name}": connection requires at least one of credentialEnvVar or statusCheck`,
      );
    }
    if (credentialEnvVar) {
      const declared = meta.envVars.some((e) => e.from === credentialEnvVar);
      if (!declared) {
        throw new Error(
          `Extension "${name}": connection.credentialEnvVar "${credentialEnvVar}" is not declared via mercury.env()`,
        );
      }
    }
  }

  return meta;
}

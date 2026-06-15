/**
 * Config registry — extensions register per-group config keys
 * with descriptions, defaults, and optional validation.
 *
 * Keys are namespaced: extension "napkin" registering "enabled"
 * becomes "napkin.enabled" in the DB.
 */

import type { ConfigDef } from "./types.js";

export interface RegisteredConfig {
  /** Extension that owns this key. */
  extension: string;
  /** Full namespaced key (e.g., "napkin.enabled"). */
  key: string;
  /** Human-readable description. */
  description: string;
  /** Default value when not set. */
  default: string;
  /** Optional validator. */
  validate?: (value: string) => boolean;
}

export class ConfigRegistry {
  private readonly configs = new Map<string, RegisteredConfig>();

  /** Register a config key for an extension. */
  register(extension: string, key: string, def: ConfigDef): void {
    const fullKey = `${extension}.${key}`;
    if (this.configs.has(fullKey)) {
      throw new Error(`Config key "${fullKey}" already registered`);
    }
    this.configs.set(fullKey, {
      extension,
      key: fullKey,
      description: def.description,
      default: def.default,
      validate: def.validate,
    });
  }

  /** Get all registered configs. */
  getAll(): RegisteredConfig[] {
    return [...this.configs.values()];
  }

  /** Get configs for a specific extension. */
  getForExtension(name: string): RegisteredConfig[] {
    return [...this.configs.values()].filter((c) => c.extension === name);
  }

  /** Get a specific config by full key. */
  get(fullKey: string): RegisteredConfig | undefined {
    return this.configs.get(fullKey);
  }

  /** Check if a key is a registered extension config key. */
  isValidKey(key: string): boolean {
    return this.configs.has(key);
  }

  /**
   * Validate a value for a registered key.
   * Returns true if the key has no validator or the value passes.
   * Returns false if the key is unknown or validation fails.
   */
  validate(key: string, value: string): boolean {
    const config = this.configs.get(key);
    if (!config) return false;
    if (!config.validate) return true;
    return config.validate(value);
  }

  /** Number of registered config keys. */
  get size(): number {
    return this.configs.size;
  }

  /** Clear all registrations (for testing). */
  reset(): void {
    this.configs.clear();
  }
}

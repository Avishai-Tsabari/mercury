/**
 * MercuryExtensionAPI implementation.
 *
 * Each extension gets its own instance, scoped to its name.
 * The API collects declarations into ExtensionMeta during setup.
 */

import fs from "node:fs";
import path from "node:path";
import type { ModelCapabilityKey } from "../agent/model-capabilities.js";
import { registerPermission } from "../core/permissions.js";
import type { Db } from "../storage/db.js";
import type {
  CapabilityHandler,
  CliDef,
  ConfigDef,
  ConnectionCategory,
  ConnectionDef,
  EnvDef,
  EventHandler,
  ExtensionMeta,
  ExtensionStore,
  JobDef,
  MercuryEvents,
  MercuryExtensionAPI,
  PermissionDef,
  WidgetDef,
} from "./types.js";

const CONNECTION_CATEGORIES: ReadonlySet<ConnectionCategory> =
  new Set<ConnectionCategory>([
    "email",
    "drive",
    "calendar",
    "finance",
    "messaging",
    "docs",
    "workspace",
    "other",
  ]);

const CONNECTION_AUTH_TYPES = new Set([
  "oauth2",
  "apikey",
  "app-password",
  "credentials-file",
  "form",
  "custom",
]);

export class MercuryExtensionAPIImpl implements MercuryExtensionAPI {
  private readonly meta: ExtensionMeta;

  constructor(
    readonly name: string,
    private readonly dir: string,
    private readonly db: Db,
  ) {
    this.meta = {
      name,
      dir,
      clis: [],
      hooks: new Map(),
      jobs: new Map(),
      configs: new Map(),
      widgets: [],
      capabilities: new Map(),
      envVars: [],
    };
  }

  cli(opts: CliDef): void {
    if (!opts.name || !opts.install) {
      throw new Error(
        `Extension "${this.name}": cli() requires name and install`,
      );
    }
    const def = { ...opts };
    if (def.bin) {
      def.bin = path.resolve(this.meta.dir, def.bin);
    }
    this.meta.clis.push(def);
  }

  permission(opts: PermissionDef): void {
    if (this.meta.permission) {
      throw new Error(
        `Extension "${this.name}": permission() can only be called once`,
      );
    }
    if (!Array.isArray(opts.defaultRoles)) {
      throw new Error(
        `Extension "${this.name}": permission() requires defaultRoles array`,
      );
    }
    this.meta.permission = opts;
    registerPermission(this.name, opts);
  }

  env(def: EnvDef): void {
    if (!def.from) {
      throw new Error(
        `Extension "${this.name}": env() requires a "from" field`,
      );
    }
    this.meta.envVars.push(def);
  }

  skill(relativePath: string): void {
    const absPath = path.resolve(this.dir, relativePath);
    const skillMd = path.join(absPath, "SKILL.md");
    if (!fs.existsSync(skillMd)) {
      throw new Error(
        `Extension "${this.name}": SKILL.md not found at ${skillMd}`,
      );
    }
    this.meta.skillDir = absPath;
  }

  requires(capabilities: ModelCapabilityKey[]): void {
    if (!Array.isArray(capabilities) || capabilities.length === 0) {
      throw new Error(
        `Extension "${this.name}": requires() needs a non-empty capabilities array`,
      );
    }
    const allowed = new Set([
      "tools",
      "vision",
      "audio_input",
      "audio_output",
      "extended_thinking",
    ]);
    for (const c of capabilities) {
      if (!allowed.has(c)) {
        throw new Error(
          `Extension "${this.name}": requires() unknown capability "${c}"`,
        );
      }
    }
    this.meta.requires = [...capabilities];
  }

  on<E extends keyof MercuryEvents>(event: E, handler: EventHandler<E>): void {
    const handlers = this.meta.hooks.get(event);
    if (handlers) {
      handlers.push(handler as EventHandler<keyof MercuryEvents>);
    } else {
      this.meta.hooks.set(event, [
        handler as EventHandler<keyof MercuryEvents>,
      ]);
    }
  }

  job(name: string, def: JobDef): void {
    if (!name) {
      throw new Error(`Extension "${this.name}": job() requires a name`);
    }
    if (this.meta.jobs.has(name)) {
      throw new Error(
        `Extension "${this.name}": job "${name}" already registered`,
      );
    }
    if (!def.interval && !def.cron) {
      throw new Error(
        `Extension "${this.name}": job "${name}" requires interval or cron`,
      );
    }
    if (def.interval && def.cron) {
      throw new Error(
        `Extension "${this.name}": job "${name}" cannot have both interval and cron`,
      );
    }
    if (typeof def.run !== "function") {
      throw new Error(
        `Extension "${this.name}": job "${name}" requires a run function`,
      );
    }
    this.meta.jobs.set(name, def);
  }

  config(key: string, def: ConfigDef): void {
    if (!key) {
      throw new Error(`Extension "${this.name}": config() requires a key`);
    }
    if (this.meta.configs.has(key)) {
      throw new Error(
        `Extension "${this.name}": config key "${key}" already registered`,
      );
    }
    this.meta.configs.set(key, def);
  }

  widget(def: WidgetDef): void {
    if (!def.label) {
      throw new Error(`Extension "${this.name}": widget() requires a label`);
    }
    if (typeof def.render !== "function") {
      throw new Error(
        `Extension "${this.name}": widget() requires a render function`,
      );
    }
    this.meta.widgets.push(def);
  }

  connection(def: ConnectionDef): void {
    if (this.meta.connection) {
      throw new Error(
        `Extension "${this.name}": connection() can only be called once`,
      );
    }
    if (!def.displayName) {
      throw new Error(
        `Extension "${this.name}": connection() requires a displayName`,
      );
    }
    if (!CONNECTION_CATEGORIES.has(def.category)) {
      throw new Error(
        `Extension "${this.name}": connection() unknown category "${def.category}"`,
      );
    }
    if (!CONNECTION_AUTH_TYPES.has(def.authType)) {
      throw new Error(
        `Extension "${this.name}": connection() unknown authType "${def.authType}"`,
      );
    }
    if (
      def.statusCheck !== undefined &&
      typeof def.statusCheck !== "function"
    ) {
      throw new Error(
        `Extension "${this.name}": connection() statusCheck must be a function`,
      );
    }
    // At-least-one-signal and credentialEnvVar <-> envVars matching are
    // validated in the loader after setup() returns, because mercury.connection()
    // may legitimately be called before mercury.env() inside setup.
    this.meta.connection = def;
  }

  capability(name: string, handler: CapabilityHandler): void {
    if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      throw new Error(
        `Extension "${this.name}": capability() requires a lowercase alphanumeric name`,
      );
    }
    if (typeof handler !== "function") {
      throw new Error(
        `Extension "${this.name}": capability("${name}") requires a handler function`,
      );
    }
    if (this.meta.capabilities.has(name)) {
      throw new Error(
        `Extension "${this.name}": capability "${name}" already registered`,
      );
    }
    this.meta.capabilities.set(name, handler);
  }

  get store(): ExtensionStore {
    return {
      get: (key: string) => this.db.getExtState(this.name, key),
      set: (key: string, value: string) =>
        this.db.setExtState(this.name, key, value),
      delete: (key: string) => this.db.deleteExtState(this.name, key),
      list: () => this.db.listExtState(this.name),
    };
  }

  /** Called by the loader after setup — returns collected metadata. */
  getMeta(): ExtensionMeta {
    return this.meta;
  }
}

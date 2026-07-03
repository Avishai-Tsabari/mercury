/**
 * Mercury Extension System — Type Definitions
 *
 * All types for the extension API, events, metadata, and supporting structures.
 * No runtime code — types only.
 */

import type { ContainerError } from "../agent/container-error.js";
import type { ModelCapabilityKey } from "../agent/model-capabilities.js";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { Db } from "../storage/db.js";
import type { EgressFile, MessageAttachment } from "../types.js";

// ---------------------------------------------------------------------------
// Extension context — passed to event handlers and job runners
// ---------------------------------------------------------------------------

/** Context available to extension hooks and jobs at runtime. */
export interface MercuryExtensionContext {
  /** Database access. */
  readonly db: Db;
  /** Mercury configuration. */
  readonly config: AppConfig;
  /** Logger scoped to the extension. */
  readonly log: Logger;
  /**
   * True if the caller has the permission in this space (built-in or extension-registered).
   * Used by extensions in hooks to mirror container RBAC.
   */
  hasCallerPermission(
    spaceId: string,
    callerId: string,
    permission: string,
  ): boolean;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** All lifecycle events an extension can subscribe to. */
export interface MercuryEvents {
  /** Fired after all extensions are loaded and the runtime is ready. */
  startup: StartupEvent;
  /** Fired when Mercury is shutting down. */
  shutdown: ShutdownEvent;
  /** Fired when a space workspace directory is created or ensured. */
  workspace_init: WorkspaceInitEvent;
  /** Fired just before a container is spawned for a message. */
  before_container: BeforeContainerEvent;
  /** Fired after a container finishes (success or error). */
  after_container: AfterContainerEvent;
}

export type StartupEvent = Record<string, never>;

export type ShutdownEvent = Record<string, never>;

export interface WorkspaceInitEvent {
  /** The space this workspace belongs to. */
  spaceId: string;
  /** Absolute path to the workspace directory. */
  workspace: string;
  /** Container-relative path to the workspace (e.g. /spaces/main). */
  containerWorkspace: string;
}

export interface BeforeContainerEvent {
  /** The space the message belongs to. */
  spaceId: string;
  /** The user's prompt. */
  prompt: string;
  /** Platform-specific caller identifier. */
  callerId: string;
  /** Absolute path to the space workspace. */
  workspace: string;
  /** Container-relative path to the workspace (e.g. /spaces/main). */
  containerWorkspace: string;
  /** Incoming attachments (e.g. voice, images), if any. */
  attachments?: MessageAttachment[];
}

export interface AfterContainerEvent {
  /** The space the message belongs to. */
  spaceId: string;
  /** Absolute path to the space workspace on the host. */
  workspace: string;
  /** Platform user id for this turn (same as container `CALLER_ID`). */
  callerId: string;
  /** User prompt for this turn (includes any `promptAppend` from `before_container`). */
  prompt: string;
  /** The agent's reply (empty string on error). */
  reply: string;
  /** How long the container ran, in milliseconds. */
  durationMs: number;
  /** Present if the container failed. */
  error?: ContainerError;
}

// ---------------------------------------------------------------------------
// Event return types — mutations hooks can apply
// ---------------------------------------------------------------------------

/**
 * Return value from a `before_container` handler.
 * All fields are optional — return only what you want to mutate.
 */
export interface BeforeContainerResult {
  /** Extra text appended to the system prompt inside the container. */
  systemPrompt?: string;
  /** Text appended to the user prompt (newline-joined across handlers). */
  promptAppend?: string;
  /** Extra environment variables passed to the container. */
  env?: Record<string, string>;
  /** If set, blocks the container from running entirely. */
  block?: { reason: string };
}

/**
 * Return value from an `after_container` handler.
 * All fields are optional — return only what you want to mutate.
 */
export interface AfterContainerResult {
  /** Replace the agent's reply. */
  reply?: string;
  /** If true, suppress the reply (don't send it to the chat). */
  suppress?: boolean;
  /**
   * Extra egress files to attach (e.g. host-generated audio). Appended after
   * container outbox files; order is concatenation of handlers in registration order.
   */
  files?: EgressFile[];
}

/** Maps event names to their allowed return types. */
export type EventResult<E extends keyof MercuryEvents> =
  E extends "before_container"
    ? BeforeContainerResult | undefined
    : E extends "after_container"
      ? AfterContainerResult | undefined
      : undefined;

/** A typed event handler for a specific event. */
export type EventHandler<E extends keyof MercuryEvents> = (
  event: MercuryEvents[E],
  ctx: MercuryExtensionContext,
) => Promise<EventResult<E>>;

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

/** Definition for a background job registered by an extension. */
export interface JobDef {
  /** Run on a fixed interval (milliseconds). Mutually exclusive with `cron`. */
  interval?: number;
  /** Run on a cron schedule (5-field expression). Mutually exclusive with `interval`. */
  cron?: string;
  /** The function to execute on each tick. */
  run: (ctx: MercuryExtensionContext) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Definition for a per-space config key registered by an extension. */
export interface ConfigDef {
  /** Human-readable description shown in `mrctl config get`. */
  description: string;
  /** Default value when not explicitly set. */
  default: string;
  /** Optional validator — return true if value is acceptable. */
  validate?: (value: string) => boolean;
}

// ---------------------------------------------------------------------------
// Widgets
// ---------------------------------------------------------------------------

/** Definition for a dashboard widget registered by an extension. */
export interface WidgetDef {
  /** Display label shown in the dashboard. */
  label: string;
  /** Render function returning an HTML fragment. */
  render: (ctx: MercuryExtensionContext) => string;
}

// ---------------------------------------------------------------------------
// Capabilities — host-side broker actions invoked from the container
// ---------------------------------------------------------------------------

/** A single broker request, dispatched from `POST /api/capability/:name/:action`. */
export interface CapabilityRequest {
  /** Capability name (matches the required permission). */
  name: string;
  /** Sub-action within the capability (e.g. "book", "cancel"). */
  action: string;
  /**
   * The authoritative, token-derived caller id. Trustworthy for ownership
   * checks — NOT a container-supplied argument.
   */
  callerId: string;
  /** The space the call was made from. */
  spaceId: string;
  /** Parsed JSON request body (or null). */
  body: unknown;
}

/** Result returned by a capability handler. */
export interface CapabilityResult {
  /** HTTP status to return (default 200). */
  status?: number;
  /** JSON-serializable response payload. */
  data: unknown;
}

/**
 * Host-side handler for a capability. Runs in the Mercury host process with the
 * full extension context (credentials in host storage stay on the host). The
 * container never sees secrets — only the returned `data`.
 */
export type CapabilityHandler = (
  req: CapabilityRequest,
  ctx: MercuryExtensionContext,
) => Promise<CapabilityResult>;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** Scoped key-value store for extension-private persistent state. */
export interface ExtensionStore {
  /** Get a value by key, or null if not set. */
  get(key: string): string | null;
  /** Set a key-value pair (upsert). */
  set(key: string, value: string): void;
  /** Delete a key. Returns true if the key existed. */
  delete(key: string): boolean;
  /** List all key-value pairs for this extension. */
  list(): Array<{ key: string; value: string }>;
}

// ---------------------------------------------------------------------------
// Extension API — the object passed to each extension's setup function
// ---------------------------------------------------------------------------

/** The API surface available to extensions during setup. */
export interface MercuryExtensionAPI {
  /** The extension's name (directory name). */
  readonly name: string;

  /**
   * Declare a CLI tool to install in the derived container image.
   * Can only be called once per extension.
   *
   * @example
   * mercury.cli({ name: "napkin", install: "bun add -g napkin-ai" });
   */
  cli(opts: CliDef): void;

  /**
   * Register this extension's permission and set which roles get it by default.
   * The permission name is the extension name. Can only be called once.
   *
   * @example
   * mercury.permission({ defaultRoles: ["admin", "member"] });
   */
  permission(opts: PermissionDef): void;

  /**
   * Declare an environment variable this extension needs.
   * Only injected into containers when the caller has permission for this extension.
   * Can be called multiple times for multiple env vars.
   *
   * @example
   * mercury.env({ from: "MERCURY_GH_TOKEN" }); // injected as GH_TOKEN
   * mercury.env({ from: "MERCURY_GH_TOKEN", as: "GITHUB_TOKEN" }); // custom name
   */
  env(def: EnvDef): void;

  /**
   * Register a skill directory containing a SKILL.md for agent discovery.
   * Path is relative to the extension directory.
   *
   * @example
   * mercury.skill("./skill");
   */
  skill(relativePath: string): void;

  /**
   * Declare capability requirements for this extension's skill / CLI workflows.
   * If no model leg in the chain satisfies all listed capabilities, the extension
   * skill is not installed and a startup warning is logged.
   *
   * @example
   * mercury.requires(["tools"]);
   */
  requires(capabilities: ModelCapabilityKey[]): void;

  /**
   * Subscribe to a lifecycle event.
   *
   * @example
   * mercury.on("workspace_init", async (event, ctx) => {
   *   mkdirSync(join(event.workspace, "my-dir"), { recursive: true });
   * });
   */
  on<E extends keyof MercuryEvents>(event: E, handler: EventHandler<E>): void;

  /**
   * Register a background job that runs on the host.
   *
   * @example
   * mercury.job("cleanup", { interval: 3600_000, run: async (ctx) => { ... } });
   */
  job(name: string, def: JobDef): void;

  /**
   * Register a per-space config key. Namespaced to the extension automatically.
   *
   * @example
   * mercury.config("enabled", { description: "Enable for this group", default: "true" });
   * // Registers as "napkin.enabled" in the DB
   */
  config(key: string, def: ConfigDef): void;

  /**
   * Register a dashboard widget.
   *
   * @example
   * mercury.widget({ label: "Status", render: (ctx) => "<p>OK</p>" });
   */
  widget(def: WidgetDef): void;

  /**
   * Declare this extension as a personal service connection. Additive on top
   * of cli/env/skill; extensions that never call this are unaffected. Can
   * only be called once per extension.
   *
   * @example
   * mercury.connection({
   *   displayName: "Google Workspace",
   *   category: "workspace",
   *   authType: "credentials-file",
   *   credentialEnvVar: "MERCURY_GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE",
   * });
   */
  connection(def: ConnectionDef): void;

  /**
   * Register a host-side capability handler, invoked from the container via
   * `mrctl capability <name> <action> <json>` → `POST /api/capability/:name/:action`.
   * The caller must hold the `<name>` permission. Credentials used by the
   * handler stay on the host and never enter the agent container.
   *
   * @example
   * mercury.capability("rooms", async (req, ctx) => {
   *   if (req.action === "book") return { data: await bookRoom(req.callerId, req.body) };
   *   return { status: 400, data: { error: "unknown action" } };
   * });
   */
  capability(name: string, handler: CapabilityHandler): void;

  /** Scoped key-value store for persistent extension state. */
  readonly store: ExtensionStore;
}

// ---------------------------------------------------------------------------
// CLI + Permission definitions
// ---------------------------------------------------------------------------

/** Declaration for a CLI tool to install in the container image. */
export interface CliDef {
  /** CLI binary name (should match the extension name). */
  name: string;
  /** Shell command to install the CLI (runs as a Dockerfile RUN step). */
  install: string;
  /**
   * Absolute path to a local script to copy into `/usr/local/bin/{name}`.
   * Set by the extension loader from the extension's directory.
   */
  bin?: string;
}

/** Permission configuration for an extension. */
export interface PermissionDef {
  /** Roles that should have this permission by default. */
  defaultRoles: string[];
}

/** Environment variable declaration for an extension. */
export interface EnvDef {
  /** Env var name as it appears in .env (e.g. "MERCURY_GH_TOKEN"). */
  from: string;
  /** Env var name inside the container (e.g. "GH_TOKEN"). Defaults to `from` with MERCURY_ prefix stripped. */
  as?: string;
}

// ---------------------------------------------------------------------------
// Connection metadata — first-class personal service connections
// ---------------------------------------------------------------------------

/** Runtime status of a personal service connection. */
export type ConnectionStatus =
  | "connected"
  | "needs-reauth"
  | "broken"
  | "unknown";

/** Closed category taxonomy for connections (v1 — tags deferred). */
export type ConnectionCategory =
  | "email"
  | "drive"
  | "calendar"
  | "finance"
  | "messaging"
  | "docs"
  | "workspace"
  | "other";

/** How the connection authenticates. */
export type ConnectionAuthType =
  | "oauth2"
  | "apikey"
  | "app-password"
  | "credentials-file"
  | "form"
  | "custom";

/** Result of an on-request `statusCheck` probe. */
export interface ConnectionStatusResult {
  status: ConnectionStatus;
  /** Optional one-line explanation surfaced to the UI (e.g. "token expired 2h ago"). */
  detail?: string;
}

/**
 * Declaration for a personal service connection registered via
 * `mercury.connection()`. At least one of `credentialEnvVar` or `statusCheck`
 * must be set — enforced at load.
 */
export interface ConnectionDef {
  /** User-facing name (e.g. "Google Workspace"). */
  displayName: string;
  /** Optional icon URL surfaced to the console. */
  iconUrl?: string;
  /** Category used for grouping in the UI. */
  category: ConnectionCategory;
  /** Auth mechanism used by the upstream service. */
  authType: ConnectionAuthType;
  /**
   * Optional. If set, MUST match one of the env var names declared via
   * `mercury.env({ from })`. Validated at load. Used for the default
   * presence-check status when `statusCheck` is absent. Extensions that store
   * credentials in `extension_state` (e.g. tradestation OAuth) omit this and
   * rely on `statusCheck`.
   */
  credentialEnvVar?: string;
  /** Optional OAuth-style scope list (informational, surfaced to the UI). */
  scopes?: string[];
  /**
   * Optional probe. Runs on the host with the full extension context. The
   * caller enforces a 5-second timeout. Must be side-effect free.
   */
  statusCheck?: (
    ctx: MercuryExtensionContext,
  ) => Promise<ConnectionStatusResult>;
  /**
   * If true, this connection accesses personal/sensitive data (email, finance,
   * authenticated browser). In group-linked spaces, the runtime guard requires
   * explicit admin enablement and per-request confirmation before proceeding.
   */
  sensitive?: boolean;
}

// ---------------------------------------------------------------------------
// Extension metadata — collected after running the setup function
// ---------------------------------------------------------------------------

/** Fully resolved metadata for a loaded extension. */
export interface ExtensionMeta {
  /** Extension name (directory name). */
  name: string;
  /** Absolute path to the extension directory. */
  dir: string;
  /** CLI declarations (may be empty). */
  clis: CliDef[];
  /** Permission configuration, if any. */
  permission?: PermissionDef;
  /** If set, skill install requires these capabilities on at least one model chain leg. */
  requires?: ModelCapabilityKey[];
  /** Absolute path to the skill directory, if declared. */
  skillDir?: string;
  /** Event handlers keyed by event name. */
  hooks: Map<keyof MercuryEvents, EventHandler<keyof MercuryEvents>[]>;
  /** Background jobs keyed by job name. */
  jobs: Map<string, JobDef>;
  /** Config key definitions keyed by local key (not namespaced). */
  configs: Map<string, ConfigDef>;
  /** Dashboard widgets. */
  widgets: WidgetDef[];
  /** Host-side capability handlers, keyed by capability name. */
  capabilities: Map<string, CapabilityHandler>;
  /** Declared environment variables. */
  envVars: EnvDef[];
  /** Personal service connection metadata, if declared via `mercury.connection()`. */
  connection?: ConnectionDef;
}

// ---------------------------------------------------------------------------
// Extension setup function signature
// ---------------------------------------------------------------------------

/** The default export every extension must provide. */
export type ExtensionSetupFn = (api: MercuryExtensionAPI) => void;

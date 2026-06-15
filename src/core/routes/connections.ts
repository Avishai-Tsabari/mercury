import { Hono } from "hono";
import type { AppConfig } from "../../config.js";
import { createMercuryExtensionContext } from "../../extensions/context.js";
import type { ExtensionRegistry } from "../../extensions/loader.js";
import type {
  ConnectionDef,
  ConnectionStatus,
  ExtensionMeta,
  MercuryExtensionContext,
} from "../../extensions/types.js";
import { logger } from "../../logger.js";
import type { Db } from "../../storage/db.js";
import { type Env, getApiCtx } from "../api-types.js";

export const connections = new Hono<Env>();

const STATUS_CHECK_TIMEOUT_MS = 5000;

const VALID_STATUSES: ReadonlySet<ConnectionStatus> = new Set<ConnectionStatus>(
  ["connected", "needs-reauth", "broken", "unknown"],
);

interface ResolvedStatus {
  status: ConnectionStatus;
  detail: string | null;
  error: string | null;
}

async function resolveStatus(
  ext: ExtensionMeta,
  conn: ConnectionDef,
  ctx: MercuryExtensionContext,
): Promise<ResolvedStatus> {
  if (conn.statusCheck) {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        conn.statusCheck(ctx),
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(
            () =>
              reject(
                new Error(
                  `statusCheck timed out after ${STATUS_CHECK_TIMEOUT_MS}ms`,
                ),
              ),
            STATUS_CHECK_TIMEOUT_MS,
          );
        }),
      ]);
      if (!VALID_STATUSES.has(result.status)) {
        ctx.log.error(
          `Extension "${ext.name}": statusCheck returned invalid status`,
          { status: result.status },
        );
        return {
          status: "unknown",
          detail: null,
          error: "statusCheck returned invalid status",
        };
      }
      return {
        status: result.status,
        detail: result.detail ?? null,
        error: null,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error(`Extension "${ext.name}": statusCheck failed`, { err });
      return { status: "unknown", detail: null, error: message };
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  if (conn.credentialEnvVar) {
    const present = !!process.env[conn.credentialEnvVar];
    return {
      status: present ? "connected" : "unknown",
      detail: null,
      error: null,
    };
  }

  // Loader validation guarantees at least one signal, so this is defensive.
  return {
    status: "unknown",
    detail: null,
    error: "connection declares no signal",
  };
}

export interface ResolvedConnection {
  name: string;
  displayName: string;
  iconUrl: string | null;
  category: string;
  authType: string;
  scopes: string[];
  status: ConnectionStatus;
  detail: string | null;
  error: string | null;
  sensitive: boolean;
}

/**
 * Resolve the merged connection list for an agent. Shared between the internal
 * `/api/connections` route (caller-authed) and the `/api/console/connections`
 * route (Bearer-authed). Same shape — so the console merges runtime status
 * against its per-user `user_connections` rows without caring which endpoint
 * it hit.
 */
export async function resolveConnectionList(opts: {
  registry: ExtensionRegistry;
  db: Db;
  config: AppConfig;
}): Promise<ResolvedConnection[]> {
  const entries = opts.registry
    .list()
    .filter(
      (ext): ext is ExtensionMeta & { connection: ConnectionDef } =>
        !!ext.connection,
    );

  // Promise.allSettled is belt-and-suspenders: resolveStatus already catches
  // every internal failure, but if a future change regresses that we still
  // isolate one extension's crash from the rest of the response.
  const settled = await Promise.allSettled(
    entries.map(async (ext) => {
      const conn = ext.connection;
      const extCtx = createMercuryExtensionContext({
        db: opts.db,
        config: opts.config,
        log: logger.child({ extension: ext.name }),
      });
      const resolvedStatus = await resolveStatus(ext, conn, extCtx);
      return {
        name: ext.name,
        displayName: conn.displayName,
        iconUrl: conn.iconUrl ?? null,
        category: conn.category,
        authType: conn.authType,
        scopes: conn.scopes ?? [],
        status: resolvedStatus.status,
        detail: resolvedStatus.detail,
        error: resolvedStatus.error,
        sensitive: conn.sensitive ?? false,
      } satisfies ResolvedConnection;
    }),
  );

  return settled.map((result, i) => {
    if (result.status === "fulfilled") return result.value;
    const ext = entries[i];
    const message =
      result.reason instanceof Error
        ? result.reason.message
        : String(result.reason);
    logger.error(`connections route: resolver threw for "${ext.name}"`, {
      err: result.reason,
    });
    return {
      name: ext.name,
      displayName: ext.connection.displayName,
      iconUrl: ext.connection.iconUrl ?? null,
      category: ext.connection.category,
      authType: ext.connection.authType,
      scopes: ext.connection.scopes ?? [],
      status: "unknown" as ConnectionStatus,
      detail: null,
      error: message,
      sensitive: ext.connection.sensitive ?? false,
    };
  });
}

/** GET /connections — list all connection-enabled extensions with live status. */
connections.get("/", async (c) => {
  const apiCtx = getApiCtx(c);
  if (!apiCtx.registry) {
    logger.error("connections route: registry missing from apiCtx");
    return c.json({ error: "Extension registry not initialized" }, 500);
  }
  const resolved = await resolveConnectionList({
    registry: apiCtx.registry,
    db: apiCtx.db,
    config: apiCtx.config,
  });
  return c.json({ connections: resolved });
});

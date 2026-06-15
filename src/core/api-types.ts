import type { Context } from "hono";
import type { AgentContainerRunner } from "../agent/container-runner.js";
import type { AppConfig } from "../config.js";
import type { ConfigRegistry } from "../extensions/config-registry.js";
import type { ExtensionRegistry } from "../extensions/loader.js";
import type { Db } from "../storage/db.js";
import type { TradeStationFetch } from "../tradestation/host-api.js";
import { hasPermission } from "./permissions.js";
import type { SpaceQueue } from "./space-queue.js";
import type { TaskScheduler } from "./task-scheduler.js";

// ─── Context Types ────────────────────────────────────────────────────────

export interface ApiContext {
  db: Db;
  config: AppConfig;
  containerRunner: AgentContainerRunner;
  queue: SpaceQueue;
  scheduler: TaskScheduler;
  registry: ExtensionRegistry;
  configRegistry: ConfigRegistry;
  /** Optional mock for TradeStation HTTP in tests */
  tradeStationFetch?: TradeStationFetch;
}

export interface AuthContext {
  callerId: string;
  spaceId: string;
  role: string;
}

export type Env = {
  Variables: {
    auth: AuthContext;
    apiCtx: ApiContext;
  };
};

// ─── Helper Functions ─────────────────────────────────────────────────────

export const getAuth = (c: Context<Env>): AuthContext => c.get("auth");
export const getApiCtx = (c: Context<Env>): ApiContext => c.get("apiCtx");

export const checkPerm = (
  c: Context<Env>,
  permission: string,
): Response | null => {
  const { spaceId, role } = c.get("auth");
  const { db } = c.get("apiCtx");

  if (!hasPermission(db, spaceId, role, permission)) {
    return c.json(
      { error: `Forbidden: requires '${permission}' permission` },
      403,
    );
  }
  return null;
};

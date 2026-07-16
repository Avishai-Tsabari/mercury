import { Hono } from "hono";
import { createMercuryExtensionContext } from "../../extensions/context.js";
import { logger } from "../../logger.js";
import { checkPerm, type Env, getApiCtx, getAuth } from "../api-types.js";

/**
 * Host-side capability broker. Profiles register capability handlers via
 * `mercury.capability(name, handler)`; the agent invokes them from the
 * container with `mrctl capability <name> <action> <json>`.
 *
 * The handler runs here, on the host, with credentials that never enter the
 * agent container. Identity is the token-derived caller (see the auth
 * middleware), so handlers can enforce per-caller ownership safely.
 */
export const capability = new Hono<Env>();

type BroadStatus =
  | 200
  | 201
  | 400
  | 401
  | 403
  | 404
  | 409
  | 410
  | 422
  | 429
  | 500;

capability.post("/:name/:action", async (c) => {
  const name = c.req.param("name");
  const action = c.req.param("action");
  const { callerId, spaceId } = getAuth(c);
  const { db, config, registry, configRegistry } = getApiCtx(c);

  logger.info("Capability request", {
    capability: name,
    action,
    callerId,
    spaceId,
  });

  // Authorization reuses the permission whose name equals the capability, so a
  // single grant (e.g. "rooms" in member_permissions) gates both the CLI and
  // this route.
  const denied = checkPerm(c, name);
  if (denied) return denied;

  const found = registry.getCapability(name);
  if (!found) {
    return c.json({ error: `Unknown capability: ${name}` }, 404);
  }

  const body = await c.req.json().catch(() => null);
  const ctx = createMercuryExtensionContext({
    db,
    config,
    log: logger,
    configRegistry,
  });

  try {
    const result = await found.handler(
      { name, action, callerId, spaceId, body },
      ctx,
    );
    return c.json(
      result.data as Record<string, unknown>,
      (result.status ?? 200) as BroadStatus,
    );
  } catch (err) {
    logger.error("Capability handler failed", {
      capability: name,
      action,
      error: err instanceof Error ? err.message : String(err),
    });
    return c.json(
      { error: `Capability "${name}" failed to handle "${action}"` },
      500,
    );
  }
});

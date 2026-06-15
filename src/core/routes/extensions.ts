import { Hono } from "hono";
import type { ConnectionDef } from "../../extensions/types.js";
import { type Env, getApiCtx } from "../api-types.js";

export const extensions = new Hono<Env>();

/**
 * Project a ConnectionDef to the fields safe to serialize in the /ext response.
 * `credentialEnvVar` is a host-runtime implementation detail — never leaves
 * the host. `statusCheck` is a function and is not serializable anyway.
 */
function serializeConnection(conn: ConnectionDef) {
  return {
    displayName: conn.displayName,
    iconUrl: conn.iconUrl ?? null,
    category: conn.category,
    authType: conn.authType,
    scopes: conn.scopes ?? [],
  };
}

/** GET /ext — list all installed extensions */
extensions.get("/", (c) => {
  const { registry } = getApiCtx(c);

  const list = registry.list().map((ext) => ({
    name: ext.name,
    hasCli: ext.clis.length > 0,
    hasSkill: !!ext.skillDir,
    permission: ext.permission ? ext.name : null,
    ...(ext.connection
      ? { connection: serializeConnection(ext.connection) }
      : {}),
  }));

  return c.json({ extensions: list });
});

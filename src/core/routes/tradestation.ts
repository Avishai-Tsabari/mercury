import { Hono } from "hono";
import { z } from "zod";
import { logger } from "../../logger.js";
import {
  isLikelySimAccount,
  tradeStationAuthorizedJson,
} from "../../tradestation/host-api.js";
import {
  cleanupExpiredTradestationPending,
  createPendingOrderId,
  deletePendingOrder,
  loadPendingOrder,
  PENDING_ORDER_TTL_MS,
  type PendingOrderRecord,
  savePendingOrder,
  type TradeStationOrderRequestJson,
} from "../../tradestation/pending-orders.js";
import { checkPerm, type Env, getApiCtx, getAuth } from "../api-types.js";

export const tradestation = new Hono<Env>();

const tradeActionSchema = z.enum([
  "BUY",
  "SELL",
  "BUYTOCOVER",
  "SELLSHORT",
  "BUYTOOPEN",
  "BUYTOCLOSE",
  "SELLTOOPEN",
  "SELLTOCLOSE",
]);

const orderTypeSchema = z.enum(["Market", "Limit", "StopMarket", "StopLimit"]);

const orderBodySchema = z.object({
  confirm: z.boolean().optional(),
  pendingId: z.string().uuid().optional(),
  accountKey: z.string().min(1),
  symbol: z.string().min(1),
  quantity: z.union([z.string(), z.number()]).transform((q) => String(q)),
  tradeAction: tradeActionSchema,
  orderType: orderTypeSchema.default("Market"),
  /** Maps to TimeInForce.Duration (TradeStation v3). */
  timeInForceDuration: z.string().min(1).default("DAY"),
  timeInForceExpirationDate: z.string().optional(),
  route: z.string().min(1).default("Intelligent"),
  limitPrice: z.string().optional(),
  stopPrice: z.string().optional(),
});

function buildOrderRequest(
  parsed: z.infer<typeof orderBodySchema>,
): TradeStationOrderRequestJson {
  const tif: Record<string, string> = {
    Duration: parsed.timeInForceDuration,
  };
  if (
    parsed.timeInForceExpirationDate &&
    parsed.timeInForceExpirationDate.trim() !== ""
  ) {
    tif.ExpirationDate = parsed.timeInForceExpirationDate.trim();
  }
  const body: TradeStationOrderRequestJson = {
    AccountID: parsed.accountKey.trim(),
    Symbol: parsed.symbol.trim(),
    Quantity: parsed.quantity,
    OrderType: parsed.orderType,
    TradeAction: parsed.tradeAction,
    TimeInForce: tif,
    Route: parsed.route.trim(),
  };
  if (parsed.limitPrice !== undefined && parsed.limitPrice.trim() !== "") {
    body.LimitPrice = parsed.limitPrice.trim();
  }
  if (parsed.stopPrice !== undefined && parsed.stopPrice.trim() !== "") {
    body.StopPrice = parsed.stopPrice.trim();
  }
  return body;
}

function liveOrderBlocked(accountKey: string, allowLive: boolean): boolean {
  if (isLikelySimAccount(accountKey)) return false;
  return !allowLive;
}

function orderRequestsMatch(
  a: TradeStationOrderRequestJson,
  b: TradeStationOrderRequestJson,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

tradestation.post("/orders", async (c) => {
  const denied = checkPerm(c, "tradestation");
  if (denied) return denied;

  const { spaceId, callerId } = getAuth(c);
  const { db, config, tradeStationFetch } = getApiCtx(c);
  const fetchImpl = tradeStationFetch ?? fetch;

  cleanupExpiredTradestationPending(db);

  let bodyRaw: unknown;
  try {
    bodyRaw = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = orderBodySchema.safeParse(bodyRaw);
  if (!parsed.success) {
    return c.json(
      { error: "Invalid order payload", details: parsed.error.flatten() },
      400,
    );
  }

  const input = parsed.data;
  const confirm = input.confirm === true;
  const pendingId = input.pendingId;

  if (liveOrderBlocked(input.accountKey, config.tsAllowLiveOrders)) {
    return c.json(
      {
        error:
          "Live (non-SIM) account orders are disabled. Set MERCURY_TS_ALLOW_LIVE_ORDERS=true only if you accept real-money risk, or use a SIM account.",
      },
      403,
    );
  }

  if (confirm) {
    if (!pendingId) {
      return c.json({ error: "confirm requires pendingId" }, 400);
    }

    const pending = loadPendingOrder(db, pendingId);
    if (!pending) {
      return c.json(
        {
          error:
            "Unknown or expired pendingId — start again with confirm: false",
        },
        404,
      );
    }

    if (pending.expiresAt < Date.now()) {
      deletePendingOrder(db, pendingId);
      return c.json({ error: "pendingId expired" }, 410);
    }

    if (pending.spaceId !== spaceId || pending.callerId !== callerId) {
      return c.json(
        { error: "pendingId was issued for a different caller or space" },
        403,
      );
    }

    const replay = buildOrderRequest(input);
    if (!orderRequestsMatch(replay, pending.orderRequest)) {
      return c.json(
        {
          error:
            "Order fields do not match the pending proposal — use the same parameters as the first request",
        },
        400,
      );
    }

    const place = await tradeStationAuthorizedJson(
      db,
      {
        method: "POST",
        path: "/orderexecution/orders",
        body: pending.orderRequest,
      },
      fetchImpl,
    );

    deletePendingOrder(db, pendingId);

    logger.info("TradeStation order placed", {
      spaceId,
      callerId,
      accountKey: String(pending.orderRequest.AccountID),
      symbol: String(pending.orderRequest.Symbol),
      quantity: String(pending.orderRequest.Quantity),
      tradeAction: String(pending.orderRequest.TradeAction),
      orderType: String(pending.orderRequest.OrderType),
      tsStatus: place.status,
      ok: place.ok,
    });

    if (!place.ok) {
      const st = place.status >= 400 && place.status < 600 ? place.status : 502;
      return c.json(
        {
          error: "TradeStation order request failed",
          status: place.status,
          tradestation: place.data,
        },
        st as 400 | 401 | 403 | 404 | 409 | 410 | 422 | 429 | 500 | 502,
      );
    }

    return c.json({
      placed: true,
      tradestation: place.data,
      summary: pending.summary,
    });
  }

  // Propose: confirm is false or omitted
  const orderRequest = buildOrderRequest(input);

  const confirmRes = await tradeStationAuthorizedJson(
    db,
    {
      method: "POST",
      path: "/orderexecution/orderconfirm",
      body: orderRequest,
    },
    fetchImpl,
  );

  if (!confirmRes.ok) {
    const st =
      confirmRes.status >= 400 && confirmRes.status < 600
        ? confirmRes.status
        : 502;
    return c.json(
      {
        error: "TradeStation orderconfirm failed",
        status: confirmRes.status,
        tradestation: confirmRes.data,
      },
      st as 400 | 401 | 403 | 404 | 409 | 410 | 422 | 429 | 500 | 502,
    );
  }

  const id = createPendingOrderId();
  const summary = `${input.tradeAction} ${input.quantity} ${input.symbol} on account ${input.accountKey} (${input.orderType}, ${input.timeInForceDuration})`;

  const record: PendingOrderRecord = {
    v: 1,
    spaceId,
    callerId,
    createdAt: Date.now(),
    expiresAt: Date.now() + PENDING_ORDER_TTL_MS,
    orderRequest,
    summary,
  };
  savePendingOrder(db, id, record);

  return c.json({
    warning: true,
    pendingId: id,
    summary,
    confirmPreview: confirmRes.data,
    message:
      "STOP AND VERIFY. Only proceed if this order matches user intent. " +
      "Share the summary with the user on any chat platform. " +
      `To execute, send the same JSON fields with confirm: true and pendingId: "${id}" ` +
      `(e.g. mrctl tradestation order ... --confirm --pending-id ${id}). ` +
      `Or ask the user to reply with: CONFIRM ${id}`,
  });
});

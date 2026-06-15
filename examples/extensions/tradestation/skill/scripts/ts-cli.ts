#!/usr/bin/env bun
/**
 * Minimal TradeStation v3 CLI for the Mercury agent container.
 * Uses TRADESTATION_ACCESS_TOKEN and TRADESTATION_API_BASE from the host hook.
 */

const token = process.env.TRADESTATION_ACCESS_TOKEN;
const authErr = process.env.TRADESTATION_AUTH_ERROR;
const base = (
  process.env.TRADESTATION_API_BASE || "https://api.tradestation.com/v3"
).replace(/\/$/, "");

function usage(): never {
  console.error(`Usage:
  ts-cli.ts accounts
  ts-cli.ts balances <accountKey>
  ts-cli.ts positions <accountKey>
  ts-cli.ts bars <symbol> [barsback]

Environment: TRADESTATION_ACCESS_TOKEN (and optional TRADESTATION_API_BASE)`);
  process.exit(1);
}

async function apiGet(
  path: string,
  query?: Record<string, string>,
): Promise<unknown> {
  const url = new URL(path.replace(/^\//, ""), `${base}/`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, v);
    }
  }
  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    console.error(res.status, body);
    process.exit(1);
  }
  return body;
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  if (!cmd) usage();

  if (authErr) {
    console.error("TradeStation auth error:", authErr);
    process.exit(1);
  }
  if (!token) {
    console.error(
      "Missing TRADESTATION_ACCESS_TOKEN. This TradeStation integration is admin-only; check Mercury host configuration.",
    );
    process.exit(1);
  }

  switch (cmd) {
    case "accounts": {
      const data = await apiGet("/brokerage/accounts");
      console.log(JSON.stringify(data, null, 2));
      break;
    }
    case "balances": {
      const accountKey = rest[0];
      if (!accountKey) usage();
      const data = await apiGet(
        `/brokerage/accounts/${encodeURIComponent(accountKey)}/balances`,
      );
      console.log(JSON.stringify(data, null, 2));
      break;
    }
    case "positions": {
      const accountKey = rest[0];
      if (!accountKey) usage();
      const data = await apiGet(
        `/brokerage/accounts/${encodeURIComponent(accountKey)}/positions`,
      );
      console.log(JSON.stringify(data, null, 2));
      break;
    }
    case "bars": {
      const symbol = rest[0];
      if (!symbol) usage();
      const barsback = rest[1] ?? "20";
      const data = await apiGet(
        `/marketdata/barcharts/${encodeURIComponent(symbol)}`,
        {
          barsback,
        },
      );
      console.log(JSON.stringify(data, null, 2));
      break;
    }
    default:
      usage();
  }
}

await main();

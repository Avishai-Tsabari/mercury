#!/usr/bin/env bun

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { StorageResponse } from "../core/routes/storage.js";
import { buildRequestInit } from "./mrctl-http.js";

const API_URL = process.env.API_URL;
const CALLER_ID = process.env.CALLER_ID;
const SPACE_ID = process.env.SPACE_ID;
const API_SECRET = process.env.API_SECRET;
// Per-turn, caller-bound token. When present, the host derives identity from it
// instead of trusting the x-mercury-caller / x-mercury-space headers.
const CALLER_TOKEN = process.env.CALLER_TOKEN;
// gVisor mode: the outer container is off docker0, so reach the API over a
// per-agent unix socket instead of TCP. When set, host/port in API_URL are
// ignored (Bun routes the request through the socket). Unset for runc/local.
const API_SOCKET = process.env.API_SOCKET;

function fmtBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function fatal(msg: string): never {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

if (!API_URL) fatal("API_URL not set");
if (!CALLER_ID) fatal("CALLER_ID not set");
if (!SPACE_ID) fatal("SPACE_ID not set");

const headers: Record<string, string> = {
  "x-mercury-caller": CALLER_ID,
  "x-mercury-space": SPACE_ID,
  "content-type": "application/json",
};

if (API_SECRET) {
  headers.authorization = `Bearer ${API_SECRET}`;
}

if (CALLER_TOKEN) {
  headers["x-mercury-token"] = CALLER_TOKEN;
}

async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const res = await fetch(
    `${API_URL}${path}`,
    buildRequestInit(method, headers, body, API_SOCKET),
  );

  const data = (await res.json()) as Record<string, unknown>;

  if (!res.ok) {
    const msg =
      typeof data.error === "string" ? data.error : JSON.stringify(data);
    fatal(`${res.status} — ${msg}`);
  }

  return data;
}

function print(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

function usage(): never {
  process.stderr.write(`mrctl — manage mercury from inside the agent container

Built-in commands:
  mrctl whoami
  mrctl tasks list|create|pause|resume|run|delete
  mrctl config get|set
  mrctl prefs list|get|set|delete
  mrctl roles list|grant|revoke
  mrctl permissions show|set
  mrctl spaces list|name|delete
  mrctl conversations list
  mrctl mute <platform-user-id> <duration> [--reason <reason>]
  mrctl unmute <platform-user-id>
  mrctl mutes
  mrctl tradestation order --account <id> --symbol <sym> --quantity <n> \\
      --action BUY|SELL|... [--type Market] [--duration DAY] [--route Intelligent] \\
      [--limit-price p] [--stop-price p] [--expiration-date d] [--confirm] [--pending-id uuid]
  mrctl media clear [--inbox] [--outbox]
  mrctl disk [--json]
  mrctl stop
  mrctl compact
  mrctl clear
  mrctl recall <search text> [--limit N]
  mrctl character get|set|clear
  mrctl capability <name> <action> [json-body]
  mrctl tts synthesize --text "Hello" --out outbox/reply.mp3 \\
      [--language auto|he-IL|en-US] [--provider google|azure|auto]
Environment:
  API_URL       Host API base URL
  API_SOCKET    Unix socket to the host API (gVisor mode; overrides API_URL transport)
  CALLER_ID     Platform user ID of the caller
  SPACE_ID      Current space ID
`);
  process.exit(1);
}

function requireArg(args: string[], index: number, name: string): string {
  const val = args[index];
  if (!val) fatal(`Missing required argument: ${name}`);
  return val;
}

function parseFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) usage();

  const cmd = args[0];
  const sub = args[1];

  switch (cmd) {
    case "whoami": {
      print(await api("GET", "/api/whoami"));
      break;
    }

    case "character": {
      if (!sub) usage();
      switch (sub) {
        case "get": {
          const data = (await api("GET", "/api/character")) as {
            character: string | null;
          };
          if (data.character === null) {
            process.stdout.write("(not set)\n");
          } else {
            process.stdout.write(`${data.character}\n`);
          }
          break;
        }
        case "set": {
          const filePath = parseFlag(args, "--file");
          let text: string;
          if (filePath) {
            text = readFileSync(filePath, "utf-8");
          } else {
            const fileIdx = args.indexOf("--file");
            const words = args.slice(2).filter((_, i) => {
              const absIdx = i + 2;
              return absIdx !== fileIdx && absIdx !== fileIdx + 1;
            });
            if (words.length === 0) fatal("Missing text or --file <path>");
            text = words.join(" ");
          }
          print(await api("PUT", "/api/character", { text }));
          break;
        }
        case "clear":
          print(await api("DELETE", "/api/character"));
          break;
        default:
          fatal(`Unknown character subcommand: ${sub}`);
      }
      break;
    }

    case "capability": {
      // mrctl capability <name> <action> [json-body]
      const name = requireArg(args, 1, "capability name");
      const action = requireArg(args, 2, "action");
      const rawBody = args[3];
      let body: unknown;
      if (rawBody !== undefined) {
        try {
          body = JSON.parse(rawBody);
        } catch {
          fatal("body must be valid JSON");
        }
      }
      print(await api("POST", `/api/capability/${name}/${action}`, body));
      break;
    }

    case "tasks": {
      if (!sub) usage();
      switch (sub) {
        case "list":
          print(await api("GET", "/api/tasks"));
          break;
        case "create": {
          const cron = parseFlag(args, "--cron");
          const at = parseFlag(args, "--at");
          const prompt = parseFlag(args, "--prompt");
          const silent = args.includes("--silent");
          if (!prompt) fatal("Missing --prompt");
          if (!cron && !at) fatal("Must specify --cron or --at");
          if (cron && at) fatal("Cannot specify both --cron and --at");
          print(await api("POST", "/api/tasks", { cron, at, prompt, silent }));
          break;
        }
        case "pause": {
          const id = requireArg(args, 2, "task id");
          print(await api("POST", `/api/tasks/${id}/pause`));
          break;
        }
        case "resume": {
          const id = requireArg(args, 2, "task id");
          print(await api("POST", `/api/tasks/${id}/resume`));
          break;
        }
        case "run": {
          const id = requireArg(args, 2, "task id");
          print(await api("POST", `/api/tasks/${id}/run`));
          break;
        }
        case "delete": {
          const id = requireArg(args, 2, "task id");
          print(await api("DELETE", `/api/tasks/${id}`));
          break;
        }
        default:
          fatal(`Unknown tasks subcommand: ${sub}`);
      }
      break;
    }

    case "config": {
      if (!sub) usage();
      switch (sub) {
        case "get": {
          const data = (await api("GET", "/api/config")) as {
            config: Record<string, string>;
          };
          const key = args[2];
          if (key) {
            const value = data.config[key];
            if (value === undefined) fatal(`Config key not set: ${key}`);
            process.stdout.write(`${value}\n`);
          } else {
            print(data);
          }
          break;
        }
        case "set": {
          const key = requireArg(args, 2, "key");
          const value = requireArg(args, 3, "value");
          print(await api("PUT", "/api/config", { key, value }));
          break;
        }
        default:
          fatal(`Unknown config subcommand: ${sub}`);
      }
      break;
    }

    case "prefs": {
      if (!sub) usage();
      switch (sub) {
        case "list": {
          print(await api("GET", "/api/prefs"));
          break;
        }
        case "get": {
          const key = requireArg(args, 2, "key");
          const data = (await api(
            "GET",
            `/api/prefs/${encodeURIComponent(key)}`,
          )) as { key: string; value: string };
          process.stdout.write(`${data.value}\n`);
          break;
        }
        case "set": {
          const key = requireArg(args, 2, "key");
          const rest = args.slice(3);
          if (rest.length === 0) fatal("Missing value");
          const value = rest.join(" ");
          print(await api("PUT", "/api/prefs", { key, value }));
          break;
        }
        case "delete": {
          const key = requireArg(args, 2, "key");
          print(await api("DELETE", `/api/prefs/${encodeURIComponent(key)}`));
          break;
        }
        default:
          fatal(`Unknown prefs subcommand: ${sub}`);
      }
      break;
    }

    case "roles": {
      if (!sub) usage();
      switch (sub) {
        case "list":
          print(await api("GET", "/api/roles"));
          break;
        case "grant": {
          const userId = requireArg(args, 2, "platform-user-id");
          const role = parseFlag(args, "--role") ?? "admin";
          print(
            await api("POST", "/api/roles", { platformUserId: userId, role }),
          );
          break;
        }
        case "revoke": {
          const userId = requireArg(args, 2, "platform-user-id");
          print(
            await api("DELETE", `/api/roles/${encodeURIComponent(userId)}`),
          );
          break;
        }
        default:
          fatal(`Unknown roles subcommand: ${sub}`);
      }
      break;
    }

    case "permissions": {
      if (!sub) usage();
      switch (sub) {
        case "show": {
          const role = parseFlag(args, "--role");
          const query = role ? `?role=${encodeURIComponent(role)}` : "";
          print(await api("GET", `/api/permissions${query}`));
          break;
        }
        case "set": {
          const targetRole = requireArg(args, 2, "role");
          const permsStr = requireArg(args, 3, "permissions (comma-separated)");
          const permissions = permsStr
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          print(
            await api("PUT", "/api/permissions", {
              role: targetRole,
              permissions,
            }),
          );
          break;
        }
        default:
          fatal(`Unknown permissions subcommand: ${sub}`);
      }
      break;
    }

    case "spaces": {
      if (!sub) usage();
      switch (sub) {
        case "list": {
          const data = (await api("GET", "/api/spaces")) as {
            spaces: Array<{ id: string; name: string; tags: string | null }>;
          };
          for (const s of data.spaces) {
            const tags = s.tags ? ` [${s.tags}]` : "";
            process.stdout.write(`${s.id}\t${s.name}${tags}\n`);
          }
          break;
        }
        case "name": {
          const name = args[2];
          if (name) {
            print(await api("PUT", "/api/spaces/current/name", { name }));
          } else {
            const data = (await api("GET", "/api/spaces/current")) as {
              space: { id: string; name: string };
            };
            process.stdout.write(`${data.space.name}\n`);
          }
          break;
        }
        case "delete":
          print(await api("DELETE", "/api/spaces/current"));
          break;
        default:
          fatal(`Unknown spaces subcommand: ${sub}`);
      }
      break;
    }

    case "conversations": {
      const action = sub ?? "list";
      switch (action) {
        case "list": {
          const data = (await api("GET", "/api/conversations")) as {
            conversations: Array<{
              id: number;
              platform: string;
              externalId: string;
              kind: string;
              observedTitle: string | null;
              spaceId: string | null;
            }>;
          };
          for (const convo of data.conversations) {
            const title = convo.observedTitle || convo.externalId;
            const status = convo.spaceId ? `→ ${convo.spaceId}` : "(unlinked)";
            process.stdout.write(
              `${convo.id}\t${convo.platform}\t${title}\t${status}\n`,
            );
          }
          break;
        }
        default:
          fatal(`Unknown conversations subcommand: ${action}`);
      }
      break;
    }

    case "tradestation": {
      if (sub !== "order") {
        fatal("Expected: mrctl tradestation order --account ...");
      }
      const accountKey = parseFlag(args, "--account");
      const symbol = parseFlag(args, "--symbol");
      const quantity = parseFlag(args, "--quantity");
      const action = parseFlag(args, "--action");
      const orderType = parseFlag(args, "--type") ?? "Market";
      const duration = parseFlag(args, "--duration") ?? "DAY";
      const route = parseFlag(args, "--route") ?? "Intelligent";
      const limitPrice = parseFlag(args, "--limit-price");
      const stopPrice = parseFlag(args, "--stop-price");
      const expirationDate = parseFlag(args, "--expiration-date");
      const pendingId = parseFlag(args, "--pending-id");
      const confirm = args.includes("--confirm");

      if (!accountKey || !symbol || !quantity || !action) {
        fatal(
          "tradestation order requires --account, --symbol, --quantity, --action (e.g. SELL, BUY)",
        );
      }

      const body: Record<string, unknown> = {
        accountKey,
        symbol,
        quantity,
        tradeAction: action,
        orderType,
        timeInForceDuration: duration,
        route,
      };
      if (limitPrice !== undefined) body.limitPrice = limitPrice;
      if (stopPrice !== undefined) body.stopPrice = stopPrice;
      if (expirationDate !== undefined) {
        body.timeInForceExpirationDate = expirationDate;
      }
      if (confirm) body.confirm = true;
      if (pendingId !== undefined) body.pendingId = pendingId;

      const result = (await api("POST", "/api/tradestation/orders", body)) as {
        warning?: boolean;
        message?: string;
        pendingId?: string;
      };

      if (result.warning) {
        process.stdout.write(`${result.message}\n`);
        if (result.pendingId) {
          process.stdout.write(
            `\nAfter the user confirms, run the same mrctl command with --confirm --pending-id ${result.pendingId}\n`,
          );
        }
      } else {
        print(result);
      }
      break;
    }

    case "mute": {
      const userId = requireArg(args, 1, "platform-user-id");
      const duration = requireArg(args, 2, "duration (e.g. 10m, 1h, 24h)");
      const reason = parseFlag(args, "--reason");
      const confirm = args.includes("--confirm");

      const result = (await api("POST", "/api/mutes", {
        platformUserId: userId,
        duration,
        reason,
        confirm,
      })) as { warning?: boolean; message?: string };

      if (result.warning) {
        process.stdout.write(`${result.message}\n`);
        process.stdout.write(
          `\nTo confirm, run: mrctl mute ${userId} ${duration}${reason ? ` --reason "${reason}"` : ""} --confirm\n`,
        );
      } else {
        print(result);
      }
      break;
    }

    case "unmute": {
      const userId = requireArg(args, 1, "platform-user-id");
      print(await api("DELETE", `/api/mutes/${encodeURIComponent(userId)}`));
      break;
    }

    case "mutes": {
      print(await api("GET", "/api/mutes"));
      break;
    }

    case "stop": {
      print(await api("POST", "/api/stop"));
      break;
    }

    case "compact": {
      print(await api("POST", "/api/compact"));
      break;
    }

    case "clear": {
      print(await api("POST", "/api/clear"));
      break;
    }

    case "recall": {
      let end = args.length;
      const li = args.indexOf("--limit");
      let limit = "20";
      if (li !== -1) {
        limit = requireArg(args, li + 1, "limit value after --limit");
        end = li;
      }
      const query = args.slice(1, end).join(" ").trim();
      if (!query) fatal("Usage: mrctl recall <search text> [--limit N]");

      const qs = new URLSearchParams({ q: query, limit });
      const data = (await api(
        "GET",
        `/api/messages/search?${qs.toString()}`,
      )) as {
        messages?: Array<{
          role: string;
          content: string;
          createdAt: number;
        }>;
      };

      const list = data.messages ?? [];
      if (list.length === 0) {
        process.stdout.write("(no matches)\n");
        break;
      }
      for (const m of list) {
        const ts = new Date(m.createdAt).toISOString();
        process.stdout.write(`[${ts}] ${m.role}: ${m.content}\n`);
      }
      break;
    }

    case "tts": {
      if (sub !== "synthesize") usage();
      const text = parseFlag(args, "--text");
      const out = parseFlag(args, "--out");
      const language = parseFlag(args, "--language") as
        | "auto"
        | "he-IL"
        | "en-US"
        | undefined;
      const provider = parseFlag(args, "--provider") as
        | "google"
        | "azure"
        | "auto"
        | undefined;
      if (!text) fatal("Missing --text");
      if (!out) fatal("Missing --out");

      const spaceId = SPACE_ID as string;
      const spacePrefix = path.join("/spaces", spaceId);
      const resolvedOut = path.isAbsolute(out)
        ? (() => {
            const norm = path.normalize(out);
            const prefixWithSep = `${spacePrefix}${path.sep}`;
            if (norm !== spacePrefix && !norm.startsWith(prefixWithSep)) {
              fatal(`--out must be under ${spacePrefix}`);
            }
            return norm;
          })()
        : path.join(spacePrefix, out);

      mkdirSync(path.dirname(resolvedOut), { recursive: true });

      const payload: Record<string, unknown> = { text };
      if (language) payload.language = language;
      if (provider) payload.provider = provider;

      const data = (await api("POST", "/api/tts/synthesize", payload)) as {
        dataBase64?: string;
        filename?: string;
        mimeType?: string;
        sizeBytes?: number;
        error?: string;
      };

      if (!data.dataBase64) {
        fatal(data.error ?? "TTS response missing audio");
      }

      writeFileSync(resolvedOut, Buffer.from(data.dataBase64, "base64"));
      process.stderr.write(
        `Wrote ${String(data.sizeBytes ?? "?")} bytes → ${resolvedOut} (${data.mimeType ?? "audio"})\n`,
      );
      break;
    }

    case "media": {
      if (sub !== "clear") {
        fatal("Expected: mrctl media clear [--inbox] [--outbox]");
      }
      const inboxFlag = args.includes("--inbox");
      const outboxFlag = args.includes("--outbox");
      const body: Record<string, boolean> = {};
      if (inboxFlag || outboxFlag) {
        body.inbox = inboxFlag;
        body.outbox = outboxFlag;
      }
      print(await api("POST", "/api/media/purge", body));
      break;
    }

    case "disk": {
      const jsonFlag = args.includes("--json");
      const data = (await api(
        "GET",
        "/api/console/storage",
      )) as StorageResponse;

      if (jsonFlag) {
        print(data);
        break;
      }

      const { disk, spaces, databaseBytes } = data;
      process.stdout.write(
        `Disk: ${fmtBytes(disk.totalBytes)} total · ${fmtBytes(disk.usedBytes)} used (${disk.usedPercent.toFixed(1)}%) · ${fmtBytes(disk.freeBytes)} free\n`,
      );
      if (spaces.length > 0) {
        process.stdout.write("\nSpaces:\n");
        for (const s of spaces) {
          process.stdout.write(
            `  ${s.spaceId.padEnd(14)} inbox: ${fmtBytes(s.inboxBytes).padStart(8)}   outbox: ${fmtBytes(s.outboxBytes).padStart(8)}   total: ${fmtBytes(s.totalBytes)}\n`,
          );
        }
      }
      process.stdout.write(`\nDatabase: ${fmtBytes(databaseBytes)}\n`);
      break;
    }

    case "help":
    case "--help":
    case "-h":
      usage();
      break;

    default:
      // Should not reach here since non-builtins are handled above
      fatal(`Unknown command: ${cmd}`);
  }
}

main().catch((err) => {
  fatal(String(err));
});

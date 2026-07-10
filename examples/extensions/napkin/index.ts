import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { getApiKeyFromPiAuthFile } from "mercury-agent/storage/pi-auth";

const KNOWLEDGE_DIR = "knowledge";
const VAULT_DIRS = ["people", "projects", "references", "daily", "episodes", "weekly", "monthly", "templates"];
// Entity categories shown in the NAPKIN.md vault map (excludes scaffold/output dirs).
const MAP_DIRS = ["people", "projects", "references", "episodes", "daily"];
// Daily distillation. Distilled memory serves cross-session, weeks-old recall —
// recent facts are already in live context — so daily (vs hourly) cadence cuts
// the LLM bill ~24× at near-zero user-visible cost.
const DEFAULT_DISTILL_INTERVAL_MS = "86400000"; // 24h

// ---------------------------------------------------------------------------
// Obsidian configs
// ---------------------------------------------------------------------------

const DAILY_NOTES_CONFIG = JSON.stringify(
  { folder: "daily", format: "YYYY-MM-DD", template: "templates/Daily Note" },
  null,
  2,
);

const TEMPLATES_CONFIG = JSON.stringify({ folder: "templates" }, null, 2);

const DAILY_TEMPLATE = `---
tags:
  - daily
---

## Conversations

## Learned

## Tasks

- [ ]
`;

// ---------------------------------------------------------------------------
// KB Distillation prompt — versioned file, loaded at runtime
// ---------------------------------------------------------------------------

// The distillation prompt is a dedicated, version-controlled file so its
// behavior is reviewable in git diffs rather than buried in a string literal.
// It ships alongside this extension via the `git:...#examples/extensions/napkin`
// install, so `import.meta.dir` resolves to the installed extension directory.
const KB_DISTILLER_PROMPT_PATH = join(
  import.meta.dir,
  "prompts",
  "kb-distillation.md",
);

const WEEKLY_CONSOLIDATION_PROMPT_PATH = join(
  import.meta.dir,
  "prompts",
  "consolidation-weekly.md",
);

const MONTHLY_CONSOLIDATION_PROMPT_PATH = join(
  import.meta.dir,
  "prompts",
  "consolidation-monthly.md",
);

// ---------------------------------------------------------------------------
// Distillation helpers
// ---------------------------------------------------------------------------

interface MessageRow {
  role: string;
  content: string;
  createdAt: number;
}

function formatDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function todayDate(): string {
  return formatDate(Date.now());
}

function md5(content: string): string {
  return new Bun.CryptoHasher("md5").update(content).digest("hex");
}

function exportMessages(
  db: Database,
  spaceId: string,
  messagesDir: string,
): Set<string> {
  mkdirSync(messagesDir, { recursive: true });

  const rows = db
    .query(
      `SELECT role, content, created_at as createdAt
       FROM messages
       WHERE space_id = ?
       ORDER BY id ASC`,
    )
    .all(spaceId) as MessageRow[];

  const byDate = new Map<string, Array<{ ts: number; role: string; content: string }>>();
  for (const row of rows) {
    const date = formatDate(row.createdAt);
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date)!.push({ ts: row.createdAt, role: row.role, content: row.content });
  }

  const changed = new Set<string>();
  for (const [date, messages] of byDate) {
    const filePath = join(messagesDir, `${date}.jsonl`);
    const newContent = `${messages.map((m) => JSON.stringify(m)).join("\n")}\n`;

    const oldHash = existsSync(filePath) ? md5(readFileSync(filePath, "utf-8")) : "";
    writeFileSync(filePath, newContent);
    const newHash = md5(newContent);

    if (oldHash !== newHash) {
      changed.add(date);
    }
  }

  return changed;
}

/**
 * Build a child env whose PATH also contains directories where the `pi` CLI
 * may live. A global npm install only links the top-level package's bins
 * (mercury, mercury-ctl) — dependency bins like `pi` stay in node_modules/.bin.
 * We resolve that .bin dir from the package graph first, then fall back to
 * well-known global-bin dirs (~/.bun/bin, /usr/local/bin).
 */
function envWithPiOnPath(): NodeJS.ProcessEnv {
  const isWindows = process.platform === "win32";
  const base = process.env.PATH ?? process.env.Path ?? "";
  const home = homedir();

  let piNodeModulesBin: string | undefined;
  try {
    const req = createRequire(import.meta.url);
    const pkgJson = req.resolve("@earendil-works/pi-coding-agent/package.json");
    piNodeModulesBin = join(dirname(dirname(dirname(pkgJson))), ".bin");
  } catch {}

  const candidates = [
    piNodeModulesBin,
    join(home, ".bun", "bin"),
    isWindows
      ? join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "npm")
      : "/usr/local/bin",
  ].filter(Boolean) as string[];
  // PATH entries are case-insensitive on Windows, case-sensitive on POSIX.
  const normalize = (p: string) => (isWindows ? p.toLowerCase() : p);
  const existing = new Set(base.split(delimiter).map(normalize).filter(Boolean));
  const additions = candidates.filter((c) => c && !existing.has(normalize(c)));
  const path = [base, ...additions].filter(Boolean).join(delimiter);
  // On Windows also set `Path`: process.env keys are case-sensitive but the
  // Windows env is not, so a stale `Path` could otherwise shadow our `PATH`.
  return { ...process.env, PATH: path, ...(isWindows ? { Path: path } : {}) };
}

function runPromptAgent(
  vaultDir: string,
  promptPath: string,
  instruction: string,
  extraEnv?: Record<string, string>,
): Promise<{ ok: boolean; detail?: string }> {
  let promptText: string;
  try {
    promptText = readFileSync(promptPath, "utf-8");
  } catch (err) {
    // Prompt file missing/unreadable — fail safe: the day is not marked
    // distilled, so it retries on a later run rather than silently no-op'ing.
    return Promise.resolve({
      ok: false,
      detail: `prompt unreadable: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  const promptFile = join(tmpdir(), `kb-distiller-${process.pid}.md`);
  writeFileSync(promptFile, promptText);

  return new Promise((resolve) => {
    let stderr = "";
    const child = spawn(
      "pi",
      [
        "--print",
        "--no-session",
        "--tools",
        "read,bash,write",
        "--append-system-prompt",
        promptFile,
        instruction,
      ],
      {
        cwd: vaultDir,
        env: { ...envWithPiOnPath(), ...extraEnv },
        // Capture stderr (a background job has no console to inherit usefully):
        // the captured tail is what makes a non-zero exit diagnosable in logs.
        stdio: ["ignore", "inherit", "pipe"],
      },
    );

    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      try { unlinkSync(promptFile); } catch {}
      if (code === 0) {
        resolve({ ok: true });
        return;
      }
      const tail = stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 300);
      resolve({ ok: false, detail: `pi exited ${code}${tail ? `: ${tail}` : ""}` });
    });
    child.on("error", (err) => {
      try { unlinkSync(promptFile); } catch {}
      resolve({ ok: false, detail: `spawn failed: ${err.message}` });
    });
  });
}

function runDistiller(
  vaultDir: string,
  dateFile: string,
  extraEnv?: Record<string, string>,
): Promise<{ ok: boolean; detail?: string }> {
  return runPromptAgent(
    vaultDir,
    KB_DISTILLER_PROMPT_PATH,
    `Distill knowledge from: ${dateFile}`,
    extraEnv,
  );
}

/**
 * Deterministic 32-bit hash of a space id (FNV-1a). Used to stagger each
 * space's first distillation so many tenants don't all hit the LLM API in the
 * same tick.
 */
function hashSpaceId(spaceId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < spaceId.length; i++) {
    h ^= spaceId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Read a note's frontmatter `summary:` for the vault map preview. Best-effort:
 * returns an empty string if the file is unreadable or has no summary.
 */
function readSummary(filePath: string): string {
  try {
    const text = readFileSync(filePath, "utf-8");
    const raw = text.match(/^summary:\s*(.+)$/m)?.[1];
    return raw ? raw.trim().replace(/^["']|["']$/g, "") : "";
  } catch {
    return "";
  }
}

/**
 * Regenerate `NAPKIN.md` — the Level-0 vault map — by scanning the category
 * directories. Deterministic (no LLM), so it cannot drift or hallucinate; run
 * after each distillation so the map always reflects what is actually on disk.
 */
function regenerateNapkinMap(knowledgeDir: string): void {
  const lines: string[] = [
    "# Knowledge Vault",
    "",
    "Auto-generated map of this space's memory (regenerated after each distillation run — do not edit).",
    "The current value of any fact lives in a note's frontmatter and `## Current View`; `## History` holds superseded values.",
    "",
  ];

  for (const dir of MAP_DIRS) {
    const dirPath = join(knowledgeDir, dir);
    let files: string[];
    try {
      files = readdirSync(dirPath)
        .filter((f) => f.endsWith(".md"))
        .sort();
    } catch {
      continue; // category dir absent
    }
    if (files.length === 0) continue;

    const heading = dir.charAt(0).toUpperCase() + dir.slice(1);
    lines.push(`## ${heading}`);
    if (dir === "daily") {
      // Daily notes are dated logs — list newest first, no summary.
      for (const file of files.slice().reverse()) {
        lines.push(`- ${file.replace(/\.md$/, "")}`);
      }
    } else {
      for (const file of files) {
        const slug = file.replace(/\.md$/, "");
        const summary = readSummary(join(dirPath, file));
        lines.push(summary ? `- [[${slug}]] — ${summary}` : `- [[${slug}]]`);
      }
    }
    lines.push("");
  }

  lines.push(`_Last updated: ${todayDate()}_`);
  writeFileSync(join(knowledgeDir, "NAPKIN.md"), `${lines.join("\n")}\n`);
}

// ---------------------------------------------------------------------------
// Extension setup
// ---------------------------------------------------------------------------

export default function (mercury: {
  cli(opts: { name: string; install: string }): void;
  permission(opts: { defaultRoles: string[] }): void;
  skill(relativePath: string): void;
  on(event: string, handler: (event: any, ctx: any) => Promise<any>): void;
  job(name: string, def: { interval?: number; cron?: string; run: (ctx: any) => Promise<void> }): void;
  config(key: string, def: { description: string; default: string; validate?: (v: string) => boolean }): void;
  widget(def: { label: string; render: (ctx: any) => string }): void;
  store: { get(key: string): string | null; set(key: string, value: string): void };
}) {
  mercury.cli({ name: "napkin", install: "bun add -g napkin-ai" });
  mercury.permission({ defaultRoles: ["admin", "member"] });
  mercury.skill("./skill");

  // ---------------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------------

  mercury.config("distill_interval_ms", {
    description:
      "KB distillation interval in milliseconds (0 = disabled). Default: 86400000 (daily)",
    default: DEFAULT_DISTILL_INTERVAL_MS,
    validate: (v) => {
      const n = Number.parseInt(v, 10);
      return !Number.isNaN(n) && n >= 0;
    },
  });

  mercury.config("distill_backfill_days", {
    description: "How far back (in days) to look for unprocessed dates on first enable. Default: 90",
    default: "90",
    validate: (v) => {
      const n = Number.parseInt(v, 10);
      return !Number.isNaN(n) && n >= 0;
    },
  });

  // ---------------------------------------------------------------------------
  // Hooks
  // ---------------------------------------------------------------------------

  mercury.on("workspace_init", async ({ workspace }) => {
    const knowledgeDir = join(workspace, KNOWLEDGE_DIR);
    const obsidianDir = join(knowledgeDir, ".obsidian");
    const napkinDir = join(knowledgeDir, ".napkin");

    mkdirSync(obsidianDir, { recursive: true });
    mkdirSync(napkinDir, { recursive: true });
    for (const dir of VAULT_DIRS) {
      mkdirSync(join(knowledgeDir, dir), { recursive: true });
    }

    const dailyNotesConfig = join(obsidianDir, "daily-notes.json");
    if (!existsSync(dailyNotesConfig)) {
      writeFileSync(dailyNotesConfig, DAILY_NOTES_CONFIG, "utf8");
    }

    const templatesConfig = join(obsidianDir, "templates.json");
    if (!existsSync(templatesConfig)) {
      writeFileSync(templatesConfig, TEMPLATES_CONFIG, "utf8");
    }

    const dailyTemplatePath = join(knowledgeDir, "templates", "Daily Note.md");
    if (!existsSync(dailyTemplatePath)) {
      writeFileSync(dailyTemplatePath, DAILY_TEMPLATE, "utf8");
    }

    return undefined;
  });

  mercury.on("before_container", async ({ containerWorkspace }) => {
    return {
      env: { NAPKIN_VAULT: join(containerWorkspace, KNOWLEDGE_DIR) },
    };
  });

  // ---------------------------------------------------------------------------
  // LLM credential resolution for host-side pi spawns
  // ---------------------------------------------------------------------------

  async function resolvePiAuthEnv(config: {
    authPath?: string;
    globalDir: string;
    modelProvider: string;
  }): Promise<Record<string, string>> {
    const env: Record<string, string> = {};

    // 1. Explicit env vars (strip MERCURY_ prefix, matching container-runner)
    if (process.env.MERCURY_ANTHROPIC_API_KEY) {
      env.ANTHROPIC_API_KEY = process.env.MERCURY_ANTHROPIC_API_KEY;
    }
    if (process.env.MERCURY_ANTHROPIC_OAUTH_TOKEN) {
      env.ANTHROPIC_API_KEY = process.env.MERCURY_ANTHROPIC_OAUTH_TOKEN;
    }

    // 2. Fall back to Mercury's auth.json (OAuth token refresh)
    if (!env.ANTHROPIC_API_KEY) {
      const authPath = config.authPath ?? join(config.globalDir, "auth.json");
      const key = await getApiKeyFromPiAuthFile({
        provider: config.modelProvider,
        authPath,
      });
      if (key) env.ANTHROPIC_API_KEY = key;
    }

    return env;
  }

  // ---------------------------------------------------------------------------
  // KB Distillation job
  // ---------------------------------------------------------------------------

  mercury.job("distill", {
    interval: 3600_000, // check every hour
    async run(ctx) {
      ctx.log.info("Running KB distillation");

      try {
        const dbPath = join(ctx.config.dataDir, "state.db");
        const spacesDir = join(ctx.config.dataDir, "spaces");

        if (!existsSync(dbPath)) {
          ctx.log.error("Database not found", { dbPath });
          return;
        }

        const piAuthEnv = await resolvePiAuthEnv(ctx.config);

        const db = new Database(dbPath, { readonly: true });

        const spaces = db
          .query("SELECT DISTINCT space_id as spaceId FROM messages")
          .all() as { spaceId: string }[];

        const today = todayDate();
        let totalEnabled = 0;
        let distilledTodayCount = 0;

        for (const { spaceId } of spaces) {
          const spaceWorkspace = join(spacesDir, spaceId);
          const knowledgeDir = join(spaceWorkspace, KNOWLEDGE_DIR);
          const messagesDir = join(spaceWorkspace, ".messages");

          if (!existsSync(spaceWorkspace)) continue;

          // Ensure knowledge dir exists
          if (!existsSync(knowledgeDir)) continue;

          // --- Step 1: Read per-space distill interval ---
          // getSpaceConfig returns only an explicit per-space override (or
          // null) — it does NOT surface the registered mercury.config default,
          // so the fallback here must mirror that default. An env var still
          // wins for operators who want to override globally.
          const spaceIntervalRaw = ctx.db.getSpaceConfig(spaceId, "napkin.distill_interval_ms");
          const intervalMs = Number.parseInt(
            spaceIntervalRaw ??
              process.env.MERCURY_KB_DISTILL_INTERVAL_MS ??
              DEFAULT_DISTILL_INTERVAL_MS,
            10,
          );
          // Treat a non-finite interval (NaN from a corrupted config value)
          // as disabled too — otherwise it slips past `<= 0` and later
          // `new Date(NaN).toISOString()` throws, killing the whole job.
          if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
            ctx.log.debug("Distillation disabled for space", { spaceId });
            continue;
          }

          totalEnabled++;

          // --- Step 2: Interval throttle ---
          const lastDistillAt = mercury.store.get(`last_distill_at:${spaceId}`);
          if (lastDistillAt) {
            const elapsed = Date.now() - new Date(lastDistillAt).getTime();
            if (elapsed < intervalMs) {
              ctx.log.debug("Skipping space — too soon", { spaceId, elapsed, intervalMs });
              continue;
            }
          } else {
            // First time we've seen this space: stagger its first run by a
            // deterministic per-space offset (0..intervalMs) so many tenants
            // don't all distill in the same tick. We back-date a synthetic
            // last_distill_at so the space becomes eligible after the offset;
            // subsequent runs are then naturally spread by their varied
            // completion times.
            const offset = hashSpaceId(spaceId) % intervalMs;
            const seed = Date.now() - (intervalMs - offset);
            mercury.store.set(`last_distill_at:${spaceId}`, new Date(seed).toISOString());
            ctx.log.debug("Staggering first distill for space", {
              spaceId,
              offsetMs: offset,
            });
            continue;
          }

          // --- Step 3: Backfill window ---
          const backfillDaysRaw = ctx.db.getSpaceConfig(spaceId, "napkin.distill_backfill_days");
          const backfillDays = Number.parseInt(backfillDaysRaw ?? "90", 10);
          const cutoffDate = formatDate(Date.now() - backfillDays * 86_400_000);

          // --- Step 4: Load distilled set ---
          let distilledSet: Set<string>;
          const distilledRaw = mercury.store.get(`distilled:${spaceId}`);
          if (distilledRaw) {
            try {
              distilledSet = new Set(JSON.parse(distilledRaw) as string[]);
            } catch {
              ctx.log.warn("Corrupted distilled set for space — resetting", { spaceId });
              distilledSet = new Set();
            }
          } else {
            distilledSet = new Set();
          }

          // --- Step 5: Export messages and find eligible dates ---
          const changed = exportMessages(db, spaceId, messagesDir);

          // Collect all known dates from the messages dir
          let allDates: string[];
          try {
            allDates = readdirSync(messagesDir)
              .filter((f) => f.endsWith(".jsonl"))
              .map((f) => f.replace(".jsonl", ""));
          } catch {
            allDates = [];
          }

          const eligibleDates: string[] = [];
          for (const date of allDates) {
            if (date === today) {
              // Today: re-distill if in changed set
              if (changed.has(date)) {
                eligibleDates.push(date);
              }
            } else {
              // Past dates: eligible if >= cutoff AND not already distilled
              if (date >= cutoffDate && !distilledSet.has(date)) {
                eligibleDates.push(date);
              }
            }
          }

          // Sort ascending (oldest first)
          eligibleDates.sort();

          if (eligibleDates.length === 0) {
            ctx.log.debug("No dates to distill", { spaceId });
            // Self-heal an empty/missing vault map even when nothing changed,
            // so a previously-drifted vault (empty NAPKIN.md) gets populated.
            const napkinMap = join(knowledgeDir, "NAPKIN.md");
            const mapEmpty =
              !existsSync(napkinMap) ||
              readFileSync(napkinMap, "utf-8").trim().length === 0;
            if (mapEmpty) {
              try {
                regenerateNapkinMap(knowledgeDir);
              } catch (err) {
                ctx.log.warn("Failed to regenerate NAPKIN.md", {
                  spaceId,
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            }
            mercury.store.set(`last_distill_at:${spaceId}`, new Date().toISOString());
            continue;
          }

          ctx.log.info("Distilling space", { spaceId, dates: eligibleDates });

          // --- Step 6: Distill each eligible date ---
          for (const date of eligibleDates) {
            const dateFile = join(messagesDir, `${date}.jsonl`);
            const result = await runDistiller(knowledgeDir, dateFile, piAuthEnv);
            if (result.ok) {
              ctx.log.info("Distillation complete", { spaceId, date });
              // Only persist past dates to distilled set (today will always be re-checked)
              if (date !== today) {
                distilledSet.add(date);
                mercury.store.set(`distilled:${spaceId}`, JSON.stringify([...distilledSet]));
              }
              if (date === today) {
                distilledTodayCount++;
              }
            } else {
              ctx.log.error("Distillation failed", {
                spaceId,
                date,
                detail: result.detail,
              });
              // Do NOT add to distilled set — retry next run
            }
          }

          // Regenerate the Level-0 vault map from what's now on disk.
          try {
            regenerateNapkinMap(knowledgeDir);
          } catch (err) {
            ctx.log.warn("Failed to regenerate NAPKIN.md", {
              spaceId,
              error: err instanceof Error ? err.message : String(err),
            });
          }

          mercury.store.set(`last_distill_at:${spaceId}`, new Date().toISOString());
        }

        db.close();

        const now = new Date().toISOString();
        mercury.store.set("last-distill", now);
        mercury.store.set("last-distill-status", "success");
        mercury.store.set("last-distill-total-enabled", String(totalEnabled));
        mercury.store.set("last-distill-distilled-today", String(distilledTodayCount));
        ctx.log.info("KB distillation complete", { totalEnabled, distilledTodayCount });
      } catch (err) {
        mercury.store.set("last-distill", new Date().toISOString());
        mercury.store.set("last-distill-status", "failed");
        ctx.log.error(
          "KB distillation failed",
          err instanceof Error ? err : undefined,
        );
      }
    },
  });

  // ---------------------------------------------------------------------------
  // Consolidation job (weekly + monthly)
  // ---------------------------------------------------------------------------

  const WEEKLY_INTERVAL_MS = 604_800_000; // 7 days
  const MONTHLY_INTERVAL_MS = 2_592_000_000; // ~30 days

  function isoWeek(dateStr: string): string {
    const d = new Date(`${dateStr}T00:00:00Z`);
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil(
      ((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7,
    );
    return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
  }

  mercury.job("consolidate", {
    interval: 3600_000,
    async run(ctx) {
      ctx.log.info("Running consolidation check");

      try {
        const spacesDir = join(ctx.config.dataDir, "spaces");

        const dbPath = join(ctx.config.dataDir, "state.db");
        if (!existsSync(dbPath)) return;

        const piAuthEnv = await resolvePiAuthEnv(ctx.config);

        const db = new Database(dbPath, { readonly: true });

        const spaces = db
          .query("SELECT DISTINCT space_id as spaceId FROM messages")
          .all() as { spaceId: string }[];

        for (const { spaceId } of spaces) {
          const spaceWorkspace = join(spacesDir, spaceId);
          const knowledgeDir = join(spaceWorkspace, KNOWLEDGE_DIR);
          const dailyDir = join(knowledgeDir, "daily");
          const weeklyDir = join(knowledgeDir, "weekly");
          const monthlyDir = join(knowledgeDir, "monthly");

          if (!existsSync(knowledgeDir) || !existsSync(dailyDir)) continue;

          // --- Weekly consolidation ---
          const lastWeekly = mercury.store.get(`last_consolidation_weekly:${spaceId}`);
          const weeklyElapsed = lastWeekly ? Date.now() - new Date(lastWeekly).getTime() : Infinity;

          if (weeklyElapsed >= WEEKLY_INTERVAL_MS) {
            let dailyFiles: string[];
            try {
              dailyFiles = readdirSync(dailyDir)
                .filter((f) => f.endsWith(".md"))
                .map((f) => f.replace(/\.md$/, ""))
                .sort();
            } catch {
              dailyFiles = [];
            }

            const datesByWeek = new Map<string, string[]>();
            for (const date of dailyFiles) {
              const week = isoWeek(date);
              if (!datesByWeek.has(week)) datesByWeek.set(week, []);
              datesByWeek.get(week)!.push(date);
            }

            let existingWeekly: Set<string>;
            try {
              existingWeekly = new Set(
                readdirSync(weeklyDir)
                  .filter((f) => f.endsWith(".md"))
                  .map((f) => f.replace(/\.md$/, "")),
              );
            } catch {
              existingWeekly = new Set();
            }

            const missingWeeks = [...datesByWeek.keys()]
              .filter((w) => !existingWeekly.has(w))
              .sort()
              .slice(0, 4);

            for (const week of missingWeeks) {
              const dates = datesByWeek.get(week)!;
              const dailyPaths = dates
                .map((d) => `daily/${d}.md`)
                .join(", ");
              const instruction = `Consolidate week ${week} from daily files: ${dailyPaths}. End date of this week for lifecycle calculations: ${dates[dates.length - 1]}.`;
              ctx.log.info("Running weekly consolidation", { spaceId, week });
              const result = await runPromptAgent(
                knowledgeDir,
                WEEKLY_CONSOLIDATION_PROMPT_PATH,
                instruction,
                piAuthEnv,
              );
              if (result.ok) {
                ctx.log.info("Weekly consolidation complete", { spaceId, week });
              } else {
                ctx.log.error("Weekly consolidation failed", {
                  spaceId,
                  week,
                  detail: result.detail,
                });
              }
            }

            mercury.store.set(
              `last_consolidation_weekly:${spaceId}`,
              new Date().toISOString(),
            );
          }

          // --- Monthly consolidation ---
          const lastMonthly = mercury.store.get(`last_consolidation_monthly:${spaceId}`);
          const monthlyElapsed = lastMonthly ? Date.now() - new Date(lastMonthly).getTime() : Infinity;

          if (monthlyElapsed >= MONTHLY_INTERVAL_MS) {
            let weeklyFiles: string[];
            try {
              weeklyFiles = readdirSync(weeklyDir)
                .filter((f) => f.endsWith(".md"))
                .sort();
            } catch {
              weeklyFiles = [];
            }

            if (weeklyFiles.length > 0) {
              const currentMonth = todayDate().slice(0, 7);
              const monthlyPath = join(monthlyDir, `${currentMonth}.md`);

              if (!existsSync(monthlyPath)) {
                const relevantWeekly = weeklyFiles.filter((f) => {
                  const weekStr = f.replace(/\.md$/, "");
                  const m = weekStr.match(/^(\d{4})-W(\d{2})$/);
                  if (!m) return false;
                  const year = Number.parseInt(m[1], 10);
                  const week = Number.parseInt(m[2], 10);
                  const jan4 = new Date(Date.UTC(year, 0, 4));
                  const weekStart = new Date(
                    jan4.getTime() -
                      ((jan4.getUTCDay() || 7) - 1) * 86_400_000 +
                      (week - 1) * 7 * 86_400_000,
                  );
                  const ym = `${weekStart.getUTCFullYear()}-${String(weekStart.getUTCMonth() + 1).padStart(2, "0")}`;
                  return ym === currentMonth;
                });
                if (relevantWeekly.length === 0) {
                  mercury.store.set(
                    `last_consolidation_monthly:${spaceId}`,
                    new Date().toISOString(),
                  );
                  continue;
                }
                const weeklyPaths = relevantWeekly
                  .map((f) => `weekly/${f}`)
                  .join(", ");
                const instruction = `Consolidate month ${currentMonth} from weekly files: ${weeklyPaths}. Today's date: ${todayDate()}.`;
                ctx.log.info("Running monthly consolidation", {
                  spaceId,
                  month: currentMonth,
                });
                const result = await runPromptAgent(
                  knowledgeDir,
                  MONTHLY_CONSOLIDATION_PROMPT_PATH,
                  instruction,
                  piAuthEnv,
                );
                if (result.ok) {
                  ctx.log.info("Monthly consolidation complete", {
                    spaceId,
                    month: currentMonth,
                  });
                } else {
                  ctx.log.error("Monthly consolidation failed", {
                    spaceId,
                    month: currentMonth,
                    detail: result.detail,
                  });
                }
              }
            }

            mercury.store.set(
              `last_consolidation_monthly:${spaceId}`,
              new Date().toISOString(),
            );
          }
        }

        db.close();
        ctx.log.info("Consolidation check complete");
      } catch (err) {
        ctx.log.error(
          "Consolidation failed",
          err instanceof Error ? err : undefined,
        );
      }
    },
  });

  // ---------------------------------------------------------------------------
  // Dashboard widget
  // ---------------------------------------------------------------------------

  mercury.widget({
    label: "Knowledge Vault",
    render: () => {
      const lastDistill = mercury.store.get("last-distill") ?? "never";
      const lastStatus = mercury.store.get("last-distill-status") ?? "—";
      const totalEnabled = mercury.store.get("last-distill-total-enabled") ?? "0";
      const distilledToday = mercury.store.get("last-distill-distilled-today") ?? "0";
      return `<div><strong>Last distill:</strong> ${lastDistill}<br><strong>Status:</strong> ${lastStatus}<br><strong>Spaces enabled:</strong> ${totalEnabled}<br><strong>Distilled today:</strong> ${distilledToday}</div>`;
    },
  });
}

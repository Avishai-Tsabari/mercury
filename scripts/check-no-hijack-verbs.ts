#!/usr/bin/env bun
/**
 * CI gate — fail the build if any source under the given directory reaches for
 * a Docker hijack-required verb. The Bun body-proxy cannot carry HTTP/1.1
 * hijack streams (Linux Bun's `upgrade` event swallows raw socket writes, and
 * the fetch-based forwarder cannot abort upstream on client disconnect); any
 * call to `docker attach`, an interactive `docker exec`, `docker run -i`/`-a`,
 * `docker start -a`, or an `attach({stream:true})` SDK call hangs to
 * Bun's idleTimeout and dies silently. This gate stops the trap before it
 * ships.
 *
 * Usage:  bun run /<repo-root>/scripts/check-no-hijack-verbs.ts <directory>
 *
 * The allowlist lives at /<repo-root>/scripts/hijack-verb-allowlist.txt as
 * one repo-root-relative path glob per line (lines starting with `#` are
 * comments). The script resolves the allowlist relative to itself, so it
 * works no matter what cwd the caller invokes it from.
 *
 * Exit codes:
 *   0  clean — no forbidden patterns outside the allowlist
 *   1  one or more violations (printed as file:line — matched text)
 *   2  usage error (bad arg) or allowlist file missing/unreadable
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

interface Rule {
  name: string;
  // RegExp executed per line.
  re: RegExp;
  // Optional secondary predicate over the matched line (e.g. "and NOT followed
  // by -d/--detach"). Returns true if the match should be reported.
  shouldReport?: (line: string) => boolean;
}

/**
 * Forbidden patterns. Each `re` is line-anchored (no `g` flag) so we can
 * iterate file content line-by-line and emit a precise line number. The
 * `docker exec` rule excludes detached forms (`-d`/`--detach`) which do not
 * hijack — that is the only legitimate exec the body-proxy can carry.
 */
const RULES: Rule[] = [
  { name: "docker attach", re: /\bdocker\s+attach\b/ },
  {
    name: "docker exec (non-detached)",
    re: /\bdocker\s+exec\b/,
    shouldReport: (line) => !/\bdocker\s+exec\b[^|]*?(\s-d\b|\s--detach\b)/.test(line),
  },
  {
    name: "docker run -i / --interactive",
    re: /\bdocker\s+run\b[^|]*?(\s-i\b|\s--interactive\b)/,
  },
  { name: "docker run -a", re: /\bdocker\s+run\b[^|]*?\s-a\b/ },
  { name: "docker start -a", re: /\bdocker\s+start\b[^|]*?\s-a\b/ },
  {
    name: ".attach({stream:true}) SDK call",
    re: /\.attach\s*\(\s*\{[^}]*\bstream\s*:\s*true/,
  },
  {
    name: '"Detach": false in exec body',
    re: /["']Detach["']\s*:\s*false\b/,
  },
  {
    name: 'hardcoded "Upgrade:" header on Docker request',
    re: /["']Upgrade["']\s*:\s*["']/,
  },
];

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const ALLOWLIST_PATH = resolve(SCRIPT_DIR, "hijack-verb-allowlist.txt");

async function loadAllowlist(): Promise<string[]> {
  try {
    const raw = await readFile(ALLOWLIST_PATH, "utf-8");
    return raw
      .split(/\r?\n/)
      .map((l) => l.replace(/#.*$/, "").trim())
      .filter((l) => l.length > 0);
  } catch (err) {
    console.error(`[check-no-hijack-verbs] cannot read allowlist at ${ALLOWLIST_PATH}`);
    console.error(String((err as Error).message ?? err));
    process.exit(2);
  }
}

/** Convert a glob pattern (supports **, *, ?) to an anchored RegExp. */
function globToRegExp(glob: string): RegExp {
  const normalized = glob.replace(/\\/g, "/");
  let re = "^";
  let i = 0;
  while (i < normalized.length) {
    const c = normalized[i];
    if (c === "*") {
      if (normalized[i + 1] === "*") {
        re += ".*";
        i += 2;
        if (normalized[i] === "/") i += 1;
      } else {
        re += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      re += "[^/]";
      i += 1;
    } else if (/[.+^${}()|[\]\\]/.test(c ?? "")) {
      re += `\\${c}`;
      i += 1;
    } else {
      re += c;
      i += 1;
    }
  }
  re += "$";
  return new RegExp(re);
}

function isAllowlisted(repoRelPath: string, patterns: RegExp[]): boolean {
  const normalized = repoRelPath.replace(/\\/g, "/");
  return patterns.some((re) => re.test(normalized));
}

async function* walkSource(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = `${dir}${sep}${entry.name}`;
    if (entry.isDirectory()) {
      yield* walkSource(full);
    } else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) {
      yield full;
    }
  }
}

async function scanFile(path: string, rules: Rule[]): Promise<Array<{ line: number; rule: string; text: string }>> {
  const text = await readFile(path, "utf-8");
  const lines = text.split(/\r?\n/);
  const findings: Array<{ line: number; rule: string; text: string }> = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    for (const rule of rules) {
      if (!rule.re.test(line)) continue;
      if (rule.shouldReport && !rule.shouldReport(line)) continue;
      findings.push({ line: i + 1, rule: rule.name, text: line.trim() });
    }
  }
  return findings;
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg) {
    console.error("usage: bun run check-no-hijack-verbs.ts <directory>");
    process.exit(2);
  }
  const rootDir = resolve(process.cwd(), arg);
  try {
    const s = await stat(rootDir);
    if (!s.isDirectory()) {
      console.error(`[check-no-hijack-verbs] not a directory: ${rootDir}`);
      process.exit(2);
    }
  } catch {
    console.error(`[check-no-hijack-verbs] not a directory: ${rootDir}`);
    process.exit(2);
  }

  const allowGlobs = await loadAllowlist();
  const allowPatterns = allowGlobs.map(globToRegExp);

  let totalFindings = 0;
  for await (const file of walkSource(rootDir)) {
    const repoRel = relative(REPO_ROOT, file).replace(/\\/g, "/");
    if (isAllowlisted(repoRel, allowPatterns)) continue;
    const findings = await scanFile(file, RULES);
    for (const f of findings) {
      console.error(`${repoRel}:${f.line}  [${f.rule}]  ${f.text}`);
      totalFindings += 1;
    }
  }

  if (totalFindings > 0) {
    console.error(
      `\n[check-no-hijack-verbs] ${totalFindings} forbidden hijack-verb hit(s). ` +
        `Convert to the file-mount IO workaround or add the file to scripts/hijack-verb-allowlist.txt.`,
    );
    process.exit(1);
  }
  console.error(`[check-no-hijack-verbs] clean (${rootDir})`);
}

await main();

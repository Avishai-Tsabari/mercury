// Sync-call gate.
//
// `spawnSync` / `execSync` inside a long-running HTTP server freeze the entire
// Bun/Hono event loop for the duration of the child process — up to 5 minutes
// on a cold Docker image pull. No other request (health check, agent start,
// rolling deploy) can be served while one is running. See
// docs/debug/moderate/2026-05-11-node-agent-capture-sync-blocks-event-loop.md.
//
// This gate bans `spawnSync(` / `execSync(` in code that runs inside the server
// event loop. The original scope was path-based — route handlers only — but a
// sync `execSync("docker build")` in src/extensions/image-builder.ts (build
// code, *not* a route file, yet reachable from a request handler via
// container-runner.ts) slipped through and stalled the event loop for ~4
// minutes on the first message after every deploy. See
// docs/debug/moderate/2026-05-14-first-message-after-deploy-blocked-by-sync-ext-rebuild.md.
//
// So the scan now covers all of src/ EXCEPT src/cli/. A full call-graph
// reachability analyzer is still deferred; this is a wider but still static
// scope. src/cli/ is excluded because the `mercury` CLI is a separate,
// short-lived process (the `bin` entry in package.json) — a blocking sync call
// there never touches the server event loop and is not the bug class this gate
// guards against. Do not re-narrow or re-widen this scope without that reason.
//
// Existing violations are recorded per-file in sync-calls-baseline.json so the
// gate blocks *new* ones immediately. Burn the baseline down by converting a
// call to its async equivalent (`spawn` / `exec` with a promise wrapper) and
// lowering the count. The baseline only ever goes down.

import { Glob } from "bun";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const SRC = path.join(ROOT, "src");
const BASELINE_PATH = path.join(import.meta.dir, "sync-calls-baseline.json");

// Whole-src scan; src/cli/ is excluded explicitly in the scan loop below.
const SCAN_PATTERNS = ["**/*.{ts,tsx}"];

// `spawnSync(` or `execSync(` as a call. `\b` keeps `execFileSync` and the
// bare `import { spawnSync }` specifier (no following `(`) from matching.
const SYNC_CALL = /\b(?:spawnSync|execSync)\s*\(/g;

function countMatches(text: string): number {
  return text.match(SYNC_CALL)?.length ?? 0;
}

const baseline: Record<string, number> = await Bun.file(BASELINE_PATH)
  .json()
  .catch(() => ({}));

const actual: Record<string, number> = {};
const seen = new Set<string>();
for (const pattern of SCAN_PATTERNS) {
  const glob = new Glob(pattern);
  for await (const rel of glob.scan(SRC)) {
    const key = rel.replaceAll("\\", "/");
    // src/cli/ is a separate short-lived process, not the server event loop —
    // sync calls there are harmless. Explicit prefix skip, not a glob negation:
    // Bun's Glob negation support is unreliable.
    if (key.startsWith("cli/")) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    const text = await Bun.file(path.join(SRC, rel)).text();
    const n = countMatches(text);
    if (n > 0) actual[key] = n;
  }
}

const regressions: string[] = [];
for (const [file, count] of Object.entries(actual)) {
  const allowed = baseline[file] ?? 0;
  if (count > allowed) {
    regressions.push(
      `  ${file}: ${count} sync call(s), baseline allows ${allowed}`,
    );
  }
}

// A file whose count dropped should have its baseline lowered — flag it so the
// baseline can only ratchet down, never silently drift back up later.
const stale: string[] = [];
for (const [file, allowed] of Object.entries(baseline)) {
  const count = actual[file] ?? 0;
  if (count < allowed) {
    stale.push(`  ${file}: now ${count}, baseline still ${allowed} — lower it`);
  }
}

if (regressions.length > 0) {
  console.error(
    "[check-sync-calls] New spawnSync/execSync violations in src/ (excluding src/cli/):\n" +
      regressions.join("\n") +
      "\n\nReplace the sync call with an async equivalent (`spawn` / `exec` " +
      "wrapped in a promise). Any sync child-process call in src/ can run " +
      "inside the server event loop — even build/startup code, if it's " +
      "reachable from a request handler (see image-builder.ts) — and freezes " +
      "every other request while the child runs. If this call genuinely only " +
      "runs in the standalone `mercury` CLI, it belongs under src/cli/.",
  );
  process.exit(1);
}

if (stale.length > 0) {
  console.error(
    "[check-sync-calls] Baseline is stale (counts dropped — ratchet it down):\n" +
      stale.join("\n") +
      `\n\nUpdate ${path.relative(ROOT, BASELINE_PATH)} to the current counts.`,
  );
  process.exit(1);
}

console.log(
  `[check-sync-calls] OK — ${Object.values(actual).reduce((a, b) => a + b, 0)} baselined, 0 new.`,
);

// Silent-catch gate.
//
// The "silent failure / swallowed error" pattern is the only bug class present
// in all four post-mortem syntheses (docs/debug/summarization/). This gate
// blocks the two unambiguous, grep-detectable shapes from spreading further:
//
//   1. `.catch(() => {})`        — a promise rejection discarded with zero trace
//   2. `catch (e) {}` / `catch {}` — an empty catch block
//
// It does NOT flag `.catch(() => null)` / `.catch(() => fallback)` — those
// return a handled fallback the caller inspects (e.g. `req.json().catch(() => null)`
// then Zod-validates). The `null` is the signal, not a swallow.
//
// Existing violations are recorded per-file in silent-catch-baseline.json so the
// gate blocks *new* ones immediately. Burn the baseline down by replacing a
// swallow with a logged variant (`.catch((e) => console.warn("...", e))`) and
// lowering the count. The baseline only ever goes down.

import { Glob } from "bun";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const SRC = path.join(ROOT, "src");
const BASELINE_PATH = path.join(import.meta.dir, "silent-catch-baseline.json");

// `.catch(() => {})` with arbitrary inner whitespace, optional `async`.
const VOID_CATCH = /\.catch\(\s*(?:async\s*)?\(\s*\)\s*=>\s*\{\s*\}\s*\)/g;
// `catch {}` or `catch (e) {}` with an empty body.
const EMPTY_CATCH = /catch\s*(?:\([^)]*\))?\s*\{\s*\}/g;

function countMatches(text: string): number {
  return (
    (text.match(VOID_CATCH)?.length ?? 0) +
    (text.match(EMPTY_CATCH)?.length ?? 0)
  );
}

const baseline: Record<string, number> = await Bun.file(BASELINE_PATH)
  .json()
  .catch(() => ({}));

const actual: Record<string, number> = {};
const glob = new Glob("**/*.{ts,tsx}");
for await (const rel of glob.scan(SRC)) {
  const text = await Bun.file(path.join(SRC, rel)).text();
  const n = countMatches(text);
  if (n > 0) actual[rel.replaceAll("\\", "/")] = n;
}

const regressions: string[] = [];
for (const [file, count] of Object.entries(actual)) {
  const allowed = baseline[file] ?? 0;
  if (count > allowed) {
    regressions.push(
      `  ${file}: ${count} silent catch(es), baseline allows ${allowed}`,
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
    "[check-silent-catch] New silent-catch violations:\n" +
      regressions.join("\n") +
      "\n\nReplace `.catch(() => {})` / empty `catch {}` with a logged variant, " +
      "e.g. `.catch((e) => console.warn(\"<context>\", e))`. " +
      "A swallowed rejection with no trace is the #1 recurring bug class.",
  );
  process.exit(1);
}

if (stale.length > 0) {
  console.error(
    "[check-silent-catch] Baseline is stale (counts dropped — ratchet it down):\n" +
      stale.join("\n") +
      `\n\nUpdate ${path.relative(ROOT, BASELINE_PATH)} to the current counts.`,
  );
  process.exit(1);
}

console.log(
  `[check-silent-catch] OK — ${Object.values(actual).reduce((a, b) => a + b, 0)} baselined, 0 new.`,
);

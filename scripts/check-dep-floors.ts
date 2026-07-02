// Dependency-floor freshness gate.
//
// A stale semver floor on a *direct* dependency silently re-introduces a known
// CVE: `bun install` is free to resolve down to the declared floor, so if the
// floor itself sits inside a vulnerable range, the lockfile can carry the vuln
// until someone happens to regenerate it. This is exactly how the hono audit
// CVEs landed in a prior incident.
//
// This gate cross-references `bun audit --json` against the package's *direct*
// dependencies. For each advisory whose package is a direct dependency, it
// checks whether the declared semver floor falls inside the advisory's
// `vulnerable_versions` range. If so, the floor is stale — bump it.
//
// Transitive-only advisories are ignored on purpose: this project carries
// uncontrolled transitive CVEs (pi-ai, discord.js) that are why the CI
// `audit` job is non-blocking. This gate only
// fails on floors that are ours to fix.
//
// dep-floors-allowlist.json is a reviewed exception list: `{ "<pkg>": "<reason>" }`.
// An entry is an explicit, reviewed pass — not silent. It ratchets down only:
// an allowlist entry that no longer matches a real violation is flagged stale.

import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const PKG_PATH = path.join(ROOT, "package.json");
const ALLOWLIST_PATH = path.join(import.meta.dir, "dep-floors-allowlist.json");

function fail(msg: string): never {
  console.error(`[check-dep-floors] ${msg}`);
  process.exit(1);
}

interface Advisory {
  vulnerable_versions?: string;
  title?: string;
  severity?: string;
  url?: string;
}

const pkg = (await Bun.file(PKG_PATH).json()) as {
  dependencies?: Record<string, string>;
};
const directDeps: Record<string, string> = pkg.dependencies ?? {};

const allowlist: Record<string, string> = await Bun.file(ALLOWLIST_PATH)
  .json()
  .catch(() => ({}));

for (const [name, reason] of Object.entries(allowlist)) {
  if (typeof reason !== "string" || reason.trim() === "") {
    fail(
      `allowlist entry "${name}" must have a non-empty reason string — ` +
        "an exception without a documented reason is a silent pass.",
    );
  }
}

// `bun audit` exits non-zero when it finds anything, so exit code is not a
// usable signal here — capture stdout regardless and parse it.
const proc = Bun.spawnSync(["bun", "audit", "--json"], {
  cwd: ROOT,
  stdout: "pipe",
  stderr: "pipe",
});
const stdout = proc.stdout.toString().trim();
const stderr = proc.stderr.toString().trim();

const jsonStart = stdout.indexOf("{");
if (jsonStart === -1) {
  fail(
    "could not parse bun audit output — no JSON found. " +
      "bun audit may be offline, rate-limited, or its output format changed.\n" +
      `  stdout: ${stdout || "(empty)"}\n  stderr: ${stderr || "(empty)"}`,
  );
}

let parsed: unknown;
try {
  parsed = JSON.parse(stdout.slice(jsonStart));
} catch (err) {
  fail(
    "could not parse bun audit output as JSON: " +
      (err instanceof Error ? err.message : String(err)) +
      `\n  stderr: ${stderr || "(empty)"}`,
  );
}
if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
  fail(
    "bun audit --json did not return a JSON object at the top level — " +
      "its output format may have changed.",
  );
}
const audit = parsed as Record<string, Advisory[]>;

// First x.y.z token of a range string: "^4.12.16" -> "4.12.16",
// ">=1.15.1" -> "1.15.1", "7.0.0-rc.9" -> "7.0.0-rc.9".
function extractFloor(range: string): string | null {
  const m = range.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/);
  return m ? m[0] : null;
}

const violations: string[] = [];
const warnings: string[] = [];
const allowlistUsed = new Set<string>();

for (const [name, advisories] of Object.entries(audit)) {
  const range = directDeps[name];
  if (range === undefined) continue; // transitive-only — not ours to fix
  const floor = extractFloor(range);
  if (floor === null) {
    warnings.push(
      `  ${name}: range "${range}" has no semver floor — cannot assess`,
    );
    continue;
  }
  for (const adv of advisories) {
    const vuln = adv.vulnerable_versions;
    if (!vuln) continue;
    let vulnerable: boolean;
    try {
      vulnerable = Bun.semver.satisfies(floor, vuln);
    } catch {
      warnings.push(
        `  ${name}: could not evaluate vulnerable range "${vuln}"`,
      );
      continue;
    }
    if (!vulnerable) continue;
    if (name in allowlist) {
      allowlistUsed.add(name);
      continue;
    }
    violations.push(
      `  ${name} (${range}, floor ${floor}) is within vulnerable range ` +
        `"${vuln}" — ${adv.severity ?? "?"}: ${adv.title ?? adv.url ?? "advisory"}`,
    );
  }
}

const staleAllowlist = Object.keys(allowlist).filter(
  (name) => !allowlistUsed.has(name),
);

if (warnings.length > 0) {
  console.warn(
    "[check-dep-floors] warnings (not blocking):\n" + warnings.join("\n"),
  );
}

if (violations.length > 0) {
  console.error(
    "[check-dep-floors] Direct dependencies with stale semver floors:\n" +
      violations.join("\n") +
      "\n\nBump the floor in package.json to a patched release and run " +
      "`bun install` to regenerate the lockfile. If the floor must stay " +
      `(reviewed exception), add it to ${path.relative(ROOT, ALLOWLIST_PATH)} ` +
      'with a reason: `{ "<pkg>": "<why>" }`.',
  );
}

if (staleAllowlist.length > 0) {
  console.error(
    "[check-dep-floors] Stale allowlist entries (no longer match a real " +
      "violation — ratchet the allowlist down):\n" +
      staleAllowlist.map((n) => `  ${n}`).join("\n") +
      `\n\nRemove these entries from ${path.relative(ROOT, ALLOWLIST_PATH)}.`,
  );
}

if (violations.length > 0 || staleAllowlist.length > 0) {
  process.exit(1);
}

console.log(
  `[check-dep-floors] OK — ${Object.keys(directDeps).length} direct deps checked, ` +
    `${Object.keys(allowlist).length} allowlisted, 0 stale floors.`,
);

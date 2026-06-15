import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const manifestPath = path.join(ROOT, "resources/builtin-extensions.txt");
const examplesDir = path.join(ROOT, "examples/extensions");
const targetDir = path.join(ROOT, "resources/extensions");

const manifest = fs
  .readFileSync(manifestPath, "utf-8")
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean);

fs.mkdirSync(targetDir, { recursive: true });

for (const entry of fs.readdirSync(targetDir)) {
  if (entry === ".gitkeep") continue;
  fs.rmSync(path.join(targetDir, entry), { recursive: true, force: true });
}

for (const ext of manifest) {
  const src = path.join(examplesDir, ext);
  if (!fs.existsSync(src)) {
    console.error(`FATAL: ${ext} listed in builtin-extensions.txt but not found in examples/extensions/`);
    process.exit(1);
  }
  fs.cpSync(src, path.join(targetDir, ext), { recursive: true });
  console.log(`Copied ${ext}`);
}

console.log(`Done — ${manifest.length} extensions copied to resources/extensions/`);

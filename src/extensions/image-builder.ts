/**
 * Derived image builder.
 *
 * When extensions declare CLI tools via `mercury.cli()`, this module
 * generates a Dockerfile extending the base agent image with those
 * CLIs installed, builds it, and caches the result by content hash.
 *
 * Install commands are grouped by package manager (apt, pip, npm, bun)
 * into minimal RUN steps with BuildKit cache mounts for fast rebuilds.
 */

import { execFileSync, execSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Logger } from "../logger.js";
import type { ExtensionMeta } from "./types.js";

/** Parsed install command — either a known package manager or raw shell. */
export type ParsedInstall =
  | { type: "apt"; packages: string[] }
  | { type: "pip"; packages: string[] }
  | { type: "npm"; packages: string[] }
  | { type: "bun"; packages: string[] }
  | { type: "shell"; command: string };

/**
 * Split a command string on `&&` while respecting single and double quotes.
 * `&&` inside quoted strings is not treated as a separator.
 */
function splitOnAnd(cmd: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
    } else if (ch === "&" && cmd[i + 1] === "&" && !inSingle && !inDouble) {
      parts.push(current.trim());
      current = "";
      i++; // skip second &
    } else {
      current += ch;
    }
  }

  const last = current.trim();
  if (last) parts.push(last);

  return parts;
}

/**
 * Parse a single install command string into a typed representation.
 * Recognizes apt-get, pip, npm, and bun patterns. Falls back to shell.
 */
export function parseInstallCommand(cmd: string): ParsedInstall[] {
  const results: ParsedInstall[] = [];

  // Split on && respecting quotes
  const parts = splitOnAnd(cmd);

  // If the command mixes apt/pip/npm/bun with shell commands (e.g. repo setup
  // via curl/echo before apt-get install), keep the whole thing as a single
  // shell command to preserve ordering dependencies.
  const hasShellParts = parts.some(
    (p) =>
      p &&
      !p.match(/^apt-get\s/) &&
      !p.match(/^(?:python3\s+-m\s+)?pip\s+install/) &&
      !p.match(/^npm\s+install\s+-g/) &&
      !p.match(/^bun\s+add\s+-g/) &&
      !p.match(/^rm\s+-rf\s+\/var\/lib\/apt/),
  );
  const hasPackageManager = parts.some(
    (p) =>
      p &&
      (p.match(/^apt-get\s+install/) ||
        p.match(/^(?:python3\s+-m\s+)?pip\s+install/) ||
        p.match(/^npm\s+install\s+-g/) ||
        p.match(/^bun\s+add\s+-g/)),
  );
  if (hasShellParts && hasPackageManager) {
    return [{ type: "shell", command: cmd }];
  }

  for (const part of parts) {
    // apt-get install
    const aptMatch = part.match(
      /^apt-get\s+(?:update\s*$|install\s+(?:-\S+\s+)*(.+))/,
    );
    if (aptMatch) {
      if (aptMatch[1]) {
        // Extract package names (skip flags like -y --no-install-recommends)
        const packages = aptMatch[1]
          .split(/\s+/)
          .filter((s) => s && !s.startsWith("-"));
        if (packages.length > 0) {
          results.push({ type: "apt", packages });
        }
      }
      // Skip bare "apt-get update" and "rm -rf /var/lib/apt/lists/*"
      continue;
    }

    // rm -rf /var/lib/apt/lists/* (apt cleanup, skip)
    if (/^rm\s+-rf\s+\/var\/lib\/apt\/lists/.test(part)) {
      continue;
    }

    // pip install
    const pipMatch = part.match(
      /^(?:python3\s+-m\s+)?pip\s+install\s+(?:-\S+\s+)*(.+)/,
    );
    if (pipMatch) {
      const packages = pipMatch[1]
        .split(/\s+/)
        .filter((s) => s && !s.startsWith("-"));
      if (packages.length > 0) {
        results.push({ type: "pip", packages });
      }
      continue;
    }

    // npm install -g
    const npmMatch = part.match(/^npm\s+install\s+-g\s+(.+)/);
    if (npmMatch) {
      const packages = npmMatch[1]
        .split(/\s+/)
        .filter((s) => s && !s.startsWith("-"));
      if (packages.length > 0) {
        results.push({ type: "npm", packages });
      }
      continue;
    }

    // bun add -g
    const bunMatch = part.match(/^bun\s+add\s+-g\s+(.+)/);
    if (bunMatch) {
      const packages = bunMatch[1]
        .split(/\s+/)
        .filter((s) => s && !s.startsWith("-"));
      if (packages.length > 0) {
        results.push({ type: "bun", packages });
      }
      continue;
    }

    // Everything else is a shell command
    if (part) {
      results.push({ type: "shell", command: part });
    }
  }

  return results;
}

/**
 * Merge parsed install commands: group packages by manager, deduplicate.
 * Shell commands are preserved in order.
 */
export function mergeInstalls(parsed: ParsedInstall[]): ParsedInstall[] {
  const apt = new Set<string>();
  const pip = new Set<string>();
  const npm = new Set<string>();
  const bun = new Set<string>();
  const shell: string[] = [];
  const shellSeen = new Set<string>();

  for (const p of parsed) {
    if (p.type === "shell") {
      if (!shellSeen.has(p.command)) {
        shellSeen.add(p.command);
        shell.push(p.command);
      }
    } else {
      const set =
        p.type === "apt"
          ? apt
          : p.type === "pip"
            ? pip
            : p.type === "npm"
              ? npm
              : bun;
      for (const pkg of p.packages) set.add(pkg);
    }
  }

  const result: ParsedInstall[] = [];
  if (apt.size > 0) result.push({ type: "apt", packages: [...apt].sort() });
  if (pip.size > 0) result.push({ type: "pip", packages: [...pip].sort() });
  if (npm.size > 0) result.push({ type: "npm", packages: [...npm].sort() });
  if (bun.size > 0) result.push({ type: "bun", packages: [...bun].sort() });
  for (const cmd of shell) result.push({ type: "shell", command: cmd });

  return result;
}

/**
 * Convert merged installs into RUN lines with BuildKit cache mounts.
 */
export function toRunStatements(merged: ParsedInstall[]): string[] {
  const lines: string[] = [];

  for (const m of merged) {
    switch (m.type) {
      case "apt":
        lines.push(
          `RUN apt-get update && apt-get install -y --no-install-recommends ${m.packages.join(" ")} && ` +
            `rm -rf /var/lib/apt/lists/*`,
        );
        break;
      case "pip":
        lines.push(
          `RUN --mount=type=cache,target=/home/mercury/.cache/pip ` +
            `pip install --break-system-packages ${m.packages.join(" ")}`,
        );
        break;
      case "npm":
        lines.push(
          `RUN --mount=type=cache,target=/home/mercury/.npm ` +
            `PUPPETEER_SKIP_DOWNLOAD=true npm install -g ${m.packages.join(" ")}`,
        );
        break;
      case "bun":
        lines.push(
          `RUN --mount=type=cache,target=/home/mercury/.bun/install/cache ` +
            `bun add -g ${m.packages.join(" ")}`,
        );
        break;
      case "shell":
        lines.push(`RUN ${m.command}`);
        break;
    }
  }

  return lines;
}

/**
 * Generate a Dockerfile that extends the base image with extension CLI installs.
 * Returns null if no extensions declare CLIs.
 *
 * Install commands are parsed, merged by package manager, deduplicated,
 * and emitted as minimal RUN steps with BuildKit cache mounts.
 */
export function generateDockerfile(
  baseImage: string,
  extensions: ExtensionMeta[],
): string | null {
  const allClis = extensions.flatMap((e) => e.clis);
  if (allClis.length === 0) return null;

  // Parse all install commands
  const parsed = allClis.flatMap((cli) => parseInstallCommand(cli.install));

  // Merge by package manager
  const merged = mergeInstalls(parsed);

  // Collect local bin scripts to COPY into the image
  const binCopies = allClis
    .filter((cli) => cli.bin && fs.existsSync(cli.bin))
    .map((cli) => ({
      contextName: `bin-${cli.name}`,
      dest: `/usr/local/bin/${cli.name}`,
    }));

  // Generate Dockerfile
  // Base image ends with USER mercury; switch to root for installs, restore after.
  const lines = [
    `# syntax=docker/dockerfile:1`,
    `FROM ${baseImage}`,
    `USER root`,
  ];
  for (const bc of binCopies) {
    lines.push(`COPY ${bc.contextName} ${bc.dest}`);
    lines.push(`RUN chmod 755 ${bc.dest}`);
  }
  lines.push(...toRunStatements(merged));
  if (binCopies.length > 0 && merged.some((m) => m.type === "npm")) {
    lines.push(`RUN ln -sf $(npm root -g) /usr/local/bin/node_modules`);
  }
  lines.push(`RUN chown -R mercury:mercury /home/mercury`);
  lines.push(`USER mercury`);

  return lines.join("\n");
}

/**
 * Compute a deterministic hash for cache invalidation.
 * Based on the base image ref, resolved image id (content), and sorted install commands.
 */
export function computeImageHash(
  baseImage: string,
  baseImageId: string | null,
  extensions: ExtensionMeta[],
): string {
  const allClis = extensions.flatMap((e) => e.clis);
  const installCommands = allClis
    .map((c) => c.install)
    .sort()
    .join("\n");

  const h = createHash("sha256");
  h.update(`${baseImage}\n${baseImageId ?? ""}\n${installCommands}`);
  for (const cli of allClis) {
    if (cli.bin && fs.existsSync(cli.bin)) {
      h.update(fs.readFileSync(cli.bin));
    }
  }
  return h.digest("hex").slice(0, 12);
}

/**
 * Resolve the local Docker image id for a tag or name (e.g. `mercury-agent:latest`).
 * Used so derived images invalidate when the base image is rebuilt.
 */
export function resolveBaseImageId(baseImage: string): string | null {
  try {
    const id = execFileSync(
      "docker",
      ["image", "inspect", "-f", "{{.Id}}", baseImage],
      {
        encoding: "utf8",
        timeout: 10_000,
        stdio: ["pipe", "pipe", "pipe"],
      },
    ).trim();
    return id || null;
  } catch {
    return null;
  }
}

/**
 * Run `docker build` asynchronously so the event loop is never blocked.
 *
 * `execSync` would stall the single-threaded runtime for the entire build
 * (~4 min with Playwright), which silently defeats the fire-and-forget
 * background rebuild in container-runner's `replyWithRetry`. Using `spawn`
 * lets `ensureDerivedImage` actually yield at the build step.
 */
const DOCKER_BUILD_TIMEOUT_MS = 600_000;

function runDockerBuild(derivedTag: string, contextDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("docker", ["build", "-t", derivedTag, contextDir], {
      env: { ...process.env, DOCKER_BUILDKIT: "1" },
    });
    let stderrTail = "";
    // Drain stdout so the pipe buffer never fills and blocks docker.
    proc.stdout?.on("data", () => {});
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-4000);
    });
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(
        new Error(`docker build timed out after ${DOCKER_BUILD_TIMEOUT_MS}ms`),
      );
    }, DOCKER_BUILD_TIMEOUT_MS);
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      // code === null means the process never started or was killed — the
      // "error" handler (or the timeout) already rejected, so do nothing.
      if (code === null) return;
      reject(
        Object.assign(new Error(`docker build exited with code ${code}`), {
          stderr: stderrTail,
        }),
      );
    });
  });
}

/**
 * Check if a Docker image exists locally.
 */
function imageExists(tag: string): boolean {
  try {
    execSync(`docker image inspect ${tag}`, {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Derive the Docker repository name for an agent's derived image.
 * Multi-tenant hosts use per-agent repos (`mercury-agent-ext-{id}`) so
 * pruning one agent's stale images never touches another agent's images.
 */
function extImageRepo(agentId: string | undefined): string {
  return agentId ? `mercury-agent-ext-${agentId}` : "mercury-agent-ext";
}

/**
 * Remove all derived images for this agent except the one with `keepHash`.
 * Images still in use by a running container are skipped silently.
 */
function pruneStaleExtImages(
  keepHash: string,
  repo: string,
  log: Logger,
): void {
  try {
    const out = execFileSync(
      "docker",
      ["images", repo, "--format", "{{.Tag}}"],
      { encoding: "utf8", timeout: 30_000 },
    );
    const tags = out
      .split("\n")
      .map((t) => t.trim())
      .filter((t) => t && t !== "<none>");
    for (const tag of tags) {
      if (tag === keepHash) continue;
      try {
        execFileSync("docker", ["rmi", `${repo}:${tag}`], {
          encoding: "utf8",
          timeout: 30_000,
          stdio: ["ignore", "pipe", "pipe"],
        });
        log.info(`Pruned stale ext image ${repo}:${tag}`);
      } catch {
        // Image still in use by a container — skip silently
      }
    }
  } catch (err) {
    log.warn(
      `Could not list ext images for pruning: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Manages a background ext image build.
 * Fires ensureDerivedImage as a background task and exposes the best
 * available image at any point via currentImage(). While the build is
 * in progress (or if it fails), currentImage() returns baseImage.
 */
export class ExtImageBuildState {
  private resolvedImage: string;
  private _building = true;
  private readonly extensions: ExtensionMeta[];
  private readonly log: Logger;
  private readonly agentId?: string;

  constructor(
    readonly baseImage: string,
    extensions: ExtensionMeta[],
    log: Logger,
    agentId?: string,
  ) {
    this.extensions = extensions;
    this.log = log;
    this.agentId = agentId;
    this.resolvedImage = baseImage;
    ensureDerivedImage(baseImage, extensions, log, agentId).then(
      (image) => {
        this.resolvedImage = image;
        this._building = false;
      },
      (err) => {
        // ensureDerivedImage catches all errors internally — this is a safety net.
        log.warn(
          `ExtImageBuildState: unexpected rejection: ${err instanceof Error ? err.message : String(err)}`,
        );
        this._building = false;
      },
    );
  }

  get building(): boolean {
    return this._building;
  }

  currentImage(): string {
    return this.resolvedImage;
  }

  /**
   * Re-trigger a full derived image build. Resets resolvedImage to baseImage
   * immediately (so concurrent spawns fall back to base during the rebuild),
   * then builds and updates resolvedImage when done.
   * Returns the resulting image tag.
   */
  async rebuild(): Promise<string> {
    this.resolvedImage = this.baseImage;
    this._building = true;
    try {
      const image = await ensureDerivedImage(
        this.baseImage,
        this.extensions,
        this.log,
        this.agentId,
      );
      this.resolvedImage = image;
      return image;
    } catch (err) {
      // ensureDerivedImage catches build errors internally and falls back to
      // baseImage — this branch is a safety net for unexpected rejections.
      this.log.warn(
        `ExtImageBuildState rebuild failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
      );
      return this.baseImage;
    } finally {
      this._building = false;
    }
  }
}

/**
 * Build the derived image if needed. Returns the image name to use.
 *
 * - If no extensions declare CLIs, returns the base image unchanged.
 * - If a cached image exists (same hash), returns it.
 * - Otherwise builds a new image and returns its tag.
 * - On build failure, falls back to the base image with a warning.
 */
export async function ensureDerivedImage(
  baseImage: string,
  extensions: ExtensionMeta[],
  log: Logger,
  agentId?: string,
): Promise<string> {
  const dockerfile = generateDockerfile(baseImage, extensions);
  if (!dockerfile) {
    log.debug("No extension CLIs declared, using base image");
    return baseImage;
  }

  const cliCount = extensions.reduce((n, e) => n + e.clis.length, 0);
  const baseId = resolveBaseImageId(baseImage);
  if (!baseId) {
    log.warn(
      `Could not inspect Docker image ${baseImage}; derived image cache may not invalidate when the base image changes`,
    );
  }
  const hash = computeImageHash(baseImage, baseId, extensions);
  const repo = extImageRepo(agentId);
  const derivedTag = `${repo}:${hash}`;

  // Check cache
  if (imageExists(derivedTag)) {
    log.info(`Using cached agent image ${derivedTag}`);
    return derivedTag;
  }

  // Build
  log.info(
    `Building derived agent image (${cliCount} extension CLI${cliCount > 1 ? "s" : ""})...`,
  );
  for (const ext of extensions) {
    for (const cli of ext.clis) {
      log.info(`  ${ext.name}: ${cli.install}`);
    }
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-ext-"));
  try {
    fs.writeFileSync(path.join(tmpDir, "Dockerfile"), dockerfile);

    const allClis = extensions.flatMap((e) => e.clis);
    for (const cli of allClis) {
      if (cli.bin && fs.existsSync(cli.bin)) {
        fs.copyFileSync(cli.bin, path.join(tmpDir, `bin-${cli.name}`));
      }
    }

    log.debug(`Generated Dockerfile:\n${dockerfile}`);

    const startTime = Date.now();
    await runDockerBuild(derivedTag, tmpDir);
    const durationMs = Date.now() - startTime;

    log.info(`Built derived agent image ${derivedTag}`, { durationMs });
    pruneStaleExtImages(hash, repo, log);
    return derivedTag;
  } catch (err: unknown) {
    const stderr =
      err && typeof err === "object" && "stderr" in err
        ? String((err as { stderr: unknown }).stderr).slice(-2000)
        : "";
    const msg = err instanceof Error ? err.message : String(err);
    log.error(
      `Failed to build derived image, falling back to base image: ${msg}`,
    );
    if (stderr) {
      log.error(`Docker build stderr:\n${stderr}`);
    }
    return baseImage;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

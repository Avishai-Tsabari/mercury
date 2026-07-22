import { describe, expect, it } from "bun:test";
import {
  computeImageHash,
  type DockerRun,
  generateDockerfile,
  mergeInstalls,
  parseInstallCommand,
  pruneBuildCache,
  pruneStaleExtImages,
  toRunStatements,
} from "../src/extensions/image-builder.js";
import type { ExtensionMeta } from "../src/extensions/types.js";
import type { Logger } from "../src/logger.js";

/** Stable fake base image id for hash unit tests */
const TEST_BASE_ID =
  "sha256:0000000000000000000000000000000000000000000000000000000000000000";

function makeMeta(
  name: string,
  ...clis: { name: string; install: string }[]
): ExtensionMeta {
  return {
    name,
    dir: `/fake/${name}`,
    clis,
    hooks: new Map(),
    jobs: new Map(),
    configs: new Map(),
    widgets: [],
    capabilities: new Map(),
    envVars: [],
  };
}

// ---------------------------------------------------------------------------
// parseInstallCommand
// ---------------------------------------------------------------------------
describe("parseInstallCommand", () => {
  it("parses apt-get install", () => {
    const result = parseInstallCommand(
      "apt-get update && apt-get install -y --no-install-recommends ffmpeg imagemagick && rm -rf /var/lib/apt/lists/*",
    );
    expect(result).toEqual([
      { type: "apt", packages: ["ffmpeg", "imagemagick"] },
    ]);
  });

  it("parses pip install", () => {
    const result = parseInstallCommand(
      "pip install --break-system-packages yt-dlp",
    );
    expect(result).toEqual([{ type: "pip", packages: ["yt-dlp"] }]);
  });

  it("parses python3 -m pip install", () => {
    const result = parseInstallCommand(
      "python3 -m pip install --break-system-packages pypdf pdfplumber",
    );
    expect(result).toEqual([
      { type: "pip", packages: ["pypdf", "pdfplumber"] },
    ]);
  });

  it("parses npm install -g", () => {
    const result = parseInstallCommand("npm install -g charts-cli");
    expect(result).toEqual([{ type: "npm", packages: ["charts-cli"] }]);
  });

  it("parses bun add -g", () => {
    const result = parseInstallCommand("bun add -g napkin-ai");
    expect(result).toEqual([{ type: "bun", packages: ["napkin-ai"] }]);
  });

  it("keeps mixed command as shell when package manager + shell parts", () => {
    const result = parseInstallCommand(
      "npm install -g agent-browser && npx playwright install --with-deps chromium",
    );
    // Mixed npm + shell (npx) → entire command stays as shell to preserve ordering
    expect(result).toEqual([
      {
        type: "shell",
        command:
          "npm install -g agent-browser && npx playwright install --with-deps chromium",
      },
    ]);
  });

  it("handles complex pdf-tools install as shell (mixed types)", () => {
    const cmd =
      "apt-get update && apt-get install -y --no-install-recommends poppler-utils qpdf tesseract-ocr && python3 -m pip install --break-system-packages pypdf pdfplumber pdf2image Pillow reportlab pytesseract pypdfium2 && echo '#!/bin/sh' > /usr/local/bin/pdf && echo 'echo \"pdf extension dependencies installed.\"' >> /usr/local/bin/pdf && chmod +x /usr/local/bin/pdf && rm -rf /var/lib/apt/lists/*";
    const result = parseInstallCommand(cmd);
    // Mixed apt + pip + shell → entire command stays as shell
    expect(result).toEqual([{ type: "shell", command: cmd }]);
  });

  it("returns empty for empty string", () => {
    expect(parseInstallCommand("")).toEqual([]);
  });

  it("handles apt-get install with no packages (only flags)", () => {
    const result = parseInstallCommand(
      "apt-get install -y --no-install-recommends",
    );
    expect(result).toEqual([]);
  });

  it("handles bare apt-get update with no install", () => {
    const result = parseInstallCommand("apt-get update");
    expect(result).toEqual([]);
  });

  it("handles apt install (not apt-get)", () => {
    const result = parseInstallCommand("apt install -y ffmpeg");
    // Should fall to shell since we only match apt-get
    expect(result).toEqual([
      { type: "shell", command: "apt install -y ffmpeg" },
    ]);
  });

  it("handles pip3 instead of pip", () => {
    const result = parseInstallCommand("pip3 install yt-dlp");
    // Should fall to shell since we only match pip
    expect(result).toEqual([{ type: "shell", command: "pip3 install yt-dlp" }]);
  });

  it("handles pip with version specifiers", () => {
    const result = parseInstallCommand(
      "pip install --break-system-packages yt-dlp==2024.1.1 requests>=2.0",
    );
    expect(result).toEqual([
      { type: "pip", packages: ["yt-dlp==2024.1.1", "requests>=2.0"] },
    ]);
  });

  it("handles scoped npm packages", () => {
    const result = parseInstallCommand(
      "npm install -g @mermaid-js/mermaid-cli @googleworkspace/cli",
    );
    expect(result).toEqual([
      {
        type: "npm",
        packages: ["@mermaid-js/mermaid-cli", "@googleworkspace/cli"],
      },
    ]);
  });

  it("handles npm packages with version", () => {
    const result = parseInstallCommand("npm install -g charts-cli@1.2.3");
    expect(result).toEqual([{ type: "npm", packages: ["charts-cli@1.2.3"] }]);
  });

  it("handles curl pipe sh (falls to shell)", () => {
    const result = parseInstallCommand(
      "curl -fsSL https://d2lang.com/install.sh | sh",
    );
    expect(result).toEqual([
      {
        type: "shell",
        command: "curl -fsSL https://d2lang.com/install.sh | sh",
      },
    ]);
  });

  it("handles commands with pipes mixed with npm as shell", () => {
    const cmd =
      "curl -fsSL https://example.com/install.sh | bash && npm install -g mytool";
    const result = parseInstallCommand(cmd);
    // Mixed shell (curl) + npm → entire command stays as shell
    expect(result).toEqual([{ type: "shell", command: cmd }]);
  });

  it("handles && inside single-quoted strings", () => {
    const result = parseInstallCommand("echo 'run && done' > /tmp/test");
    expect(result).toEqual([
      { type: "shell", command: "echo 'run && done' > /tmp/test" },
    ]);
  });

  it("handles && inside double-quoted strings", () => {
    const result = parseInstallCommand('echo "hello && world" > /tmp/test');
    expect(result).toEqual([
      { type: "shell", command: 'echo "hello && world" > /tmp/test' },
    ]);
  });

  it("handles mixed quoted && and real && as shell", () => {
    const cmd = "echo 'a && b' > /tmp/x && npm install -g foo";
    const result = parseInstallCommand(cmd);
    // Mixed shell (echo) + npm → entire command stays as shell
    expect(result).toEqual([{ type: "shell", command: cmd }]);
  });

  it("handles multiple pip installs in one chain", () => {
    const result = parseInstallCommand(
      "pip install --break-system-packages foo && pip install --break-system-packages bar",
    );
    expect(result).toEqual([
      { type: "pip", packages: ["foo"] },
      { type: "pip", packages: ["bar"] },
    ]);
  });

  it("handles whitespace-only parts after split", () => {
    const result = parseInstallCommand(
      "npm install -g foo &&  && npm install -g bar",
    );
    expect(result).toEqual([
      { type: "npm", packages: ["foo"] },
      { type: "npm", packages: ["bar"] },
    ]);
  });
});

// ---------------------------------------------------------------------------
// mergeInstalls — edge cases
// ---------------------------------------------------------------------------
describe("mergeInstalls edge cases", () => {
  it("deduplicates same package across extensions", () => {
    const result = mergeInstalls([
      { type: "apt", packages: ["ffmpeg"] },
      { type: "apt", packages: ["ffmpeg"] },
    ]);
    expect(result).toEqual([{ type: "apt", packages: ["ffmpeg"] }]);
  });

  it("handles conflicting pip versions (both kept, last wins at install)", () => {
    const result = mergeInstalls([
      { type: "pip", packages: ["foo==1.0"] },
      { type: "pip", packages: ["foo==2.0"] },
    ]);
    // Both are kept as separate set entries since strings differ
    expect(result).toEqual([
      { type: "pip", packages: ["foo==1.0", "foo==2.0"] },
    ]);
  });

  it("handles empty input", () => {
    expect(mergeInstalls([])).toEqual([]);
  });

  it("handles only shell commands", () => {
    const result = mergeInstalls([
      { type: "shell", command: "echo a" },
      { type: "shell", command: "echo b" },
    ]);
    expect(result).toEqual([
      { type: "shell", command: "echo a" },
      { type: "shell", command: "echo b" },
    ]);
  });

  it("preserves shell command order", () => {
    const result = mergeInstalls([
      { type: "shell", command: "first" },
      { type: "npm", packages: ["foo"] },
      { type: "shell", command: "second" },
      { type: "shell", command: "third" },
    ]);
    const shellCmds = result
      .filter((r) => r.type === "shell")
      .map((r) => (r as { type: "shell"; command: string }).command);
    expect(shellCmds).toEqual(["first", "second", "third"]);
  });
});

// ---------------------------------------------------------------------------
// mergeInstalls
// ---------------------------------------------------------------------------
describe("mergeInstalls", () => {
  it("merges apt packages from multiple commands", () => {
    const result = mergeInstalls([
      { type: "apt", packages: ["ffmpeg"] },
      { type: "apt", packages: ["imagemagick", "gh", "git"] },
      { type: "apt", packages: ["ffmpeg"] }, // duplicate
    ]);
    expect(result).toEqual([
      {
        type: "apt",
        packages: ["ffmpeg", "gh", "git", "imagemagick"],
      },
    ]);
  });

  it("merges npm packages and deduplicates shell commands", () => {
    const result = mergeInstalls([
      { type: "npm", packages: ["agent-browser"] },
      {
        type: "shell",
        command: "npx playwright install --with-deps chromium",
      },
      { type: "npm", packages: ["@mermaid-js/mermaid-cli"] },
      {
        type: "shell",
        command: "npx playwright install --with-deps chromium",
      }, // duplicate
    ]);
    expect(result).toEqual([
      {
        type: "npm",
        packages: ["@mermaid-js/mermaid-cli", "agent-browser"],
      },
      {
        type: "shell",
        command: "npx playwright install --with-deps chromium",
      },
    ]);
  });

  it("outputs in order: apt, pip, npm, bun, shell", () => {
    const result = mergeInstalls([
      { type: "shell", command: "echo hello" },
      { type: "bun", packages: ["napkin-ai"] },
      { type: "npm", packages: ["charts-cli"] },
      { type: "pip", packages: ["yt-dlp"] },
      { type: "apt", packages: ["ffmpeg"] },
    ]);
    expect(result.map((r) => r.type)).toEqual([
      "apt",
      "pip",
      "npm",
      "bun",
      "shell",
    ]);
  });
});

// ---------------------------------------------------------------------------
// toRunStatements
// ---------------------------------------------------------------------------
describe("toRunStatements", () => {
  it("generates apt RUN without cache mount", () => {
    const lines = toRunStatements([
      { type: "apt", packages: ["ffmpeg", "git"] },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("--mount");
    expect(lines[0]).toContain(
      "apt-get install -y --no-install-recommends ffmpeg git",
    );
  });

  it("generates pip RUN with cache mount", () => {
    const lines = toRunStatements([{ type: "pip", packages: ["yt-dlp"] }]);
    expect(lines[0]).toContain(
      "--mount=type=cache,target=/home/mercury/.cache/pip",
    );
    expect(lines[0]).toContain("pip install --break-system-packages yt-dlp");
  });

  it("generates npm RUN with cache mount", () => {
    const lines = toRunStatements([{ type: "npm", packages: ["charts-cli"] }]);
    expect(lines[0]).toContain("--mount=type=cache,target=/home/mercury/.npm");
    expect(lines[0]).toContain("npm install -g charts-cli");
  });

  it("generates bun RUN with cache mount", () => {
    const lines = toRunStatements([{ type: "bun", packages: ["napkin-ai"] }]);
    expect(lines[0]).toContain(
      "--mount=type=cache,target=/home/mercury/.bun/install/cache",
    );
    expect(lines[0]).toContain("bun add -g napkin-ai");
  });

  it("generates plain RUN for shell", () => {
    const lines = toRunStatements([
      { type: "shell", command: "npx playwright install --with-deps chromium" },
    ]);
    expect(lines[0]).toBe("RUN npx playwright install --with-deps chromium");
  });
});

// ---------------------------------------------------------------------------
// generateDockerfile
// ---------------------------------------------------------------------------
describe("generateDockerfile", () => {
  it("returns null when no extensions have CLIs", () => {
    const exts = [makeMeta("a"), makeMeta("b")];
    expect(generateDockerfile("base:latest", exts)).toBeNull();
  });

  it("returns null for empty extensions", () => {
    expect(generateDockerfile("base:latest", [])).toBeNull();
  });

  it("generates correct Dockerfile for one CLI extension", () => {
    const exts = [
      makeMeta("napkin", {
        name: "napkin",
        install: "bun add -g napkin-ai",
      }),
    ];
    const df = generateDockerfile(
      "ghcr.io/avishai-tsabari/mercury-agent:latest",
      exts,
    );
    expect(df).toContain("# syntax=docker/dockerfile:1");
    expect(df).toContain("FROM ghcr.io/avishai-tsabari/mercury-agent:latest");
    expect(df).toContain("bun add -g napkin-ai");
  });

  it("merges apt packages across extensions", () => {
    const exts = [
      makeMeta("media", {
        name: "ffmpeg",
        install:
          "apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*",
      }),
      makeMeta("github", {
        name: "gh",
        install:
          "apt-get update && apt-get install -y --no-install-recommends gh git && rm -rf /var/lib/apt/lists/*",
      }),
    ];
    const df = generateDockerfile("base:v1", exts);
    if (!df) throw new Error("expected dockerfile");
    // Should have ONE apt-get RUN with all packages merged
    const aptLines = df
      .split("\n")
      .filter((l) => l.includes("apt-get install"));
    expect(aptLines).toHaveLength(1);
    expect(aptLines[0]).toContain("ffmpeg");
    expect(aptLines[0]).toContain("gh");
    expect(aptLines[0]).toContain("git");
  });

  it("merges npm packages across extensions", () => {
    const exts = [
      makeMeta("web-browser", {
        name: "agent-browser",
        install: "npm install -g agent-browser",
      }),
      makeMeta("diagrams", {
        name: "mmdc",
        install: "npm install -g @mermaid-js/mermaid-cli",
      }),
    ];
    const df = generateDockerfile("base:v1", exts);
    if (!df) throw new Error("expected dockerfile");
    // npm packages merged into one RUN
    const npmLines = df.split("\n").filter((l) => l.includes("npm install"));
    expect(npmLines).toHaveLength(1);
    expect(npmLines[0]).toContain("agent-browser");
    expect(npmLines[0]).toContain("@mermaid-js/mermaid-cli");
  });

  it("generates full realistic Dockerfile", () => {
    const exts = [
      makeMeta(
        "media",
        {
          name: "ffmpeg",
          install:
            "apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*",
        },
        {
          name: "convert",
          install:
            "apt-get update && apt-get install -y --no-install-recommends imagemagick && rm -rf /var/lib/apt/lists/*",
        },
        {
          name: "yt-dlp",
          install: "pip install --break-system-packages yt-dlp",
        },
      ),
      makeMeta("charts", {
        name: "charts",
        install: "npm install -g charts-cli",
      }),
      makeMeta("knowledge", {
        name: "napkin",
        install: "bun add -g napkin-ai",
      }),
      makeMeta("web-browser", {
        name: "agent-browser",
        install: "npm install -g agent-browser",
      }),
      makeMeta("no-cli"),
    ];
    const df = generateDockerfile("base:latest", exts);
    if (!df) throw new Error("expected dockerfile");
    const lines = df.split("\n");

    // Syntax directive + FROM + USER root + apt + pip + npm + bun + chown + USER mercury = 9 lines
    // (no bin scripts in this test → no node_modules symlink line)
    expect(lines).toHaveLength(9);
    expect(lines[0]).toBe("# syntax=docker/dockerfile:1");
    expect(lines[1]).toBe("FROM base:latest");
    expect(lines[2]).toBe("USER root");
    // apt: ffmpeg + imagemagick merged
    expect(lines[3]).toContain("ffmpeg");
    expect(lines[3]).toContain("imagemagick");
    // pip: yt-dlp
    expect(lines[4]).toContain("yt-dlp");
    // npm: agent-browser + charts-cli merged
    expect(lines[5]).toContain("agent-browser");
    expect(lines[5]).toContain("charts-cli");
    // bun: napkin-ai
    expect(lines[6]).toContain("napkin-ai");
    expect(lines[7]).toBe("RUN chown -R mercury:mercury /home/mercury");
    expect(lines[8]).toBe("USER mercury");
  });
});

// ---------------------------------------------------------------------------
// computeImageHash
// ---------------------------------------------------------------------------
describe("computeImageHash", () => {
  it("returns a 12-char hex string", () => {
    const exts = [
      makeMeta("napkin", {
        name: "napkin",
        install: "bun add -g napkin-ai",
      }),
    ];
    const hash = computeImageHash("base:latest", TEST_BASE_ID, exts);
    expect(hash).toHaveLength(12);
    expect(hash).toMatch(/^[0-9a-f]{12}$/);
  });

  it("is deterministic", () => {
    const exts = [
      makeMeta("napkin", {
        name: "napkin",
        install: "bun add -g napkin-ai",
      }),
    ];
    const h1 = computeImageHash("base:latest", TEST_BASE_ID, exts);
    const h2 = computeImageHash("base:latest", TEST_BASE_ID, exts);
    expect(h1).toBe(h2);
  });

  it("changes when base image id changes (rebuild)", () => {
    const exts = [
      makeMeta("napkin", {
        name: "napkin",
        install: "bun add -g napkin-ai",
      }),
    ];
    const h1 = computeImageHash(
      "base:latest",
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      exts,
    );
    const h2 = computeImageHash(
      "base:latest",
      "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      exts,
    );
    expect(h1).not.toBe(h2);
  });

  it("changes when base image ref changes", () => {
    const exts = [
      makeMeta("napkin", {
        name: "napkin",
        install: "bun add -g napkin-ai",
      }),
    ];
    const h1 = computeImageHash("base:v1", TEST_BASE_ID, exts);
    const h2 = computeImageHash("base:v2", TEST_BASE_ID, exts);
    expect(h1).not.toBe(h2);
  });

  it("changes when install commands change", () => {
    const e1 = [
      makeMeta("napkin", {
        name: "napkin",
        install: "bun add -g napkin-ai",
      }),
    ];
    const e2 = [
      makeMeta("napkin", {
        name: "napkin",
        install: "bun add -g napkin-ai@2.0",
      }),
    ];
    const h1 = computeImageHash("base:latest", TEST_BASE_ID, e1);
    const h2 = computeImageHash("base:latest", TEST_BASE_ID, e2);
    expect(h1).not.toBe(h2);
  });

  it("is order-independent (sorted internally)", () => {
    const e1 = [
      makeMeta("a", { name: "a", install: "install-a" }),
      makeMeta("b", { name: "b", install: "install-b" }),
    ];
    const e2 = [
      makeMeta("b", { name: "b", install: "install-b" }),
      makeMeta("a", { name: "a", install: "install-a" }),
    ];
    expect(computeImageHash("base:latest", TEST_BASE_ID, e1)).toBe(
      computeImageHash("base:latest", TEST_BASE_ID, e2),
    );
  });

  it("ignores extensions without CLIs", () => {
    const e1 = [
      makeMeta("napkin", {
        name: "napkin",
        install: "bun add -g napkin-ai",
      }),
    ];
    const e2 = [
      makeMeta("no-cli"),
      makeMeta("napkin", {
        name: "napkin",
        install: "bun add -g napkin-ai",
      }),
      makeMeta("also-no-cli"),
    ];
    expect(computeImageHash("base:latest", TEST_BASE_ID, e1)).toBe(
      computeImageHash("base:latest", TEST_BASE_ID, e2),
    );
  });
});

// ---------------------------------------------------------------------------
// Prune helpers (Docker disk hygiene)
// ---------------------------------------------------------------------------

/** Capturing fake logger satisfying the Logger interface. */
function makeFakeLogger(): {
  logger: Logger;
  infos: string[];
  warns: string[];
  debugs: string[];
} {
  const infos: string[] = [];
  const warns: string[] = [];
  const debugs: string[] = [];
  const logger: Logger = {
    level: "info",
    debug: (m: string) => debugs.push(m),
    info: (m: string) => infos.push(m),
    warn: (m: string) => warns.push(m),
    error: () => {},
    child: () => logger,
  };
  return { logger, infos, warns, debugs };
}

/** A scripted docker invocation: matcher on the joined args → behaviour. */
type Script = {
  match: (args: string[]) => boolean;
  out?: string;
  throws?: string;
};

/**
 * Build a fake DockerRun from an ordered script. Each call consumes the first
 * matching entry; unmatched calls throw so tests notice unexpected commands.
 * Records every invocation's args for assertions.
 */
function scriptedRun(scripts: Script[]): { run: DockerRun; calls: string[][] } {
  const calls: string[][] = [];
  const run: DockerRun = (args) => {
    calls.push(args);
    const s = scripts.find((x) => x.match(args));
    if (!s) throw new Error(`unexpected docker call: ${args.join(" ")}`);
    if (s.throws) throw new Error(s.throws);
    return s.out ?? "";
  };
  return { run, calls };
}

const argsHave =
  (...needles: string[]) =>
  (args: string[]) =>
    needles.every((n) => args.includes(n));

describe("pruneStaleExtImages", () => {
  const REPO = "mercury-agent-ext-t";

  it("removes a stale image directly when nothing pins it", () => {
    const { logger, infos, warns } = makeFakeLogger();
    const { run, calls } = scriptedRun([
      { match: argsHave("images", REPO), out: "keepme\nstale1\n" },
      { match: argsHave("rmi", `${REPO}:stale1`), out: "" },
    ]);

    pruneStaleExtImages("keepme", REPO, logger, run);

    // keepme is skipped; stale1 rmi'd; no container listing needed.
    expect(calls.some((c) => c.includes("keepme") && c.includes("rmi"))).toBe(
      false,
    );
    expect(calls.some((c) => c.includes("ps"))).toBe(false);
    expect(infos.some((m) => m.includes(`${REPO}:stale1`))).toBe(true);
    expect(warns).toHaveLength(0);
  });

  it("reaps stopped containers then retries when the image is pinned", () => {
    const { logger, infos, warns } = makeFakeLogger();
    let rmiAttempts = 0;
    const run: DockerRun = (args) => {
      if (argsHave("images", REPO)(args)) return "keepme\nstale1\n";
      if (argsHave("rmi", `${REPO}:stale1`)(args)) {
        rmiAttempts++;
        if (rmiAttempts === 1)
          throw new Error("image is being used by container");
        return ""; // second attempt (after reap) succeeds
      }
      if (argsHave("ps", "-aq")(args)) return "cont1\ncont2\n";
      if (argsHave("rm", "cont1", "cont2")(args)) return "";
      throw new Error(`unexpected: ${args.join(" ")}`);
    };

    pruneStaleExtImages("keepme", REPO, logger, run);

    expect(rmiAttempts).toBe(2);
    expect(
      infos.some((m) => m.includes("after reaping 2 stopped container")),
    ).toBe(true);
    expect(warns).toHaveLength(0);
  });

  it("warns (not silent) when a running container still pins the image", () => {
    const { logger, warns } = makeFakeLogger();
    const run: DockerRun = (args) => {
      if (argsHave("images", REPO)(args)) return "stale1\n";
      if (argsHave("rmi", `${REPO}:stale1`)(args))
        throw new Error("image is being used by running container");
      if (argsHave("ps", "-aq")(args)) return "running1\n";
      if (argsHave("rm", "running1")(args))
        throw new Error("cannot remove a running container"); // rm no -f fails
      throw new Error(`unexpected: ${args.join(" ")}`);
    };

    // Must not throw — the failure is logged, not propagated.
    pruneStaleExtImages("keepme", REPO, logger, run);

    expect(
      warns.some((m) => m.includes("Could not prune stale ext image")),
    ).toBe(true);
  });

  it("warns and bails when it can't even list images", () => {
    const { logger, warns } = makeFakeLogger();
    const run: DockerRun = () => {
      throw new Error("docker daemon not reachable");
    };
    pruneStaleExtImages("keepme", REPO, logger, run);
    expect(warns.some((m) => m.includes("Could not list ext images"))).toBe(
      true,
    );
  });
});

describe("pruneBuildCache", () => {
  const ENV_KEY = "MERCURY_BUILD_CACHE_RESERVED";

  function withEnv(value: string | undefined, fn: () => void) {
    const prev = process.env[ENV_KEY];
    if (value === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = value;
    try {
      fn();
    } finally {
      if (prev === undefined) delete process.env[ENV_KEY];
      else process.env[ENV_KEY] = prev;
    }
  }

  it("prunes with the modern --reserved-space flag and default size", () => {
    withEnv(undefined, () => {
      const { logger, infos } = makeFakeLogger();
      const { run, calls } = scriptedRun([
        {
          match: argsHave("builder", "prune", "--reserved-space=10GB"),
          out: "",
        },
      ]);
      pruneBuildCache(logger, run);
      expect(calls).toHaveLength(1);
      expect(infos.some((m) => m.includes("reserved-space=10GB"))).toBe(true);
    });
  });

  it("honours a configured reserved size", () => {
    withEnv("25GB", () => {
      const { logger, infos } = makeFakeLogger();
      const { run } = scriptedRun([
        {
          match: argsHave("builder", "prune", "--reserved-space=25GB"),
          out: "",
        },
      ]);
      pruneBuildCache(logger, run);
      expect(infos.some((m) => m.includes("reserved-space=25GB"))).toBe(true);
    });
  });

  it("falls back to legacy --keep-storage when --reserved-space is unknown", () => {
    withEnv(undefined, () => {
      const { logger, infos } = makeFakeLogger();
      const run: DockerRun = (args) => {
        if (args.includes("--reserved-space=10GB"))
          throw new Error("unknown flag: --reserved-space");
        if (args.includes("--keep-storage=10GB")) return "";
        throw new Error(`unexpected: ${args.join(" ")}`);
      };
      pruneBuildCache(logger, run);
      expect(infos.some((m) => m.includes("keep-storage=10GB"))).toBe(true);
    });
  });

  it("does not fall back on a non-flag error; warns instead", () => {
    withEnv(undefined, () => {
      const { logger, warns } = makeFakeLogger();
      const calls: string[][] = [];
      const run: DockerRun = (args) => {
        calls.push(args);
        throw new Error("failed to prune: daemon error");
      };
      pruneBuildCache(logger, run);
      // Only the modern flag was attempted (no legacy fallback on real errors).
      expect(calls).toHaveLength(1);
      expect(warns.some((m) => m.includes("Could not prune build cache"))).toBe(
        true,
      );
    });
  });

  it("is disabled when set to 'off'", () => {
    withEnv("off", () => {
      const { logger, debugs } = makeFakeLogger();
      const { run, calls } = scriptedRun([]);
      pruneBuildCache(logger, run);
      expect(calls).toHaveLength(0);
      expect(debugs.some((m) => m.includes("disabled"))).toBe(true);
    });
  });
});

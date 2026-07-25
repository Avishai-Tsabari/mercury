import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildPiAgentMountArgs } from "../src/agent/container-runner.js";

/**
 * The inner container gets pi's resource entries and nothing else. auth.json
 * holds the OAuth refresh token, which can mint access tokens long after the
 * container exits — the container only ever needs the short-lived access token
 * injected as ANTHROPIC_OAUTH_TOKEN.
 */
const tmpDirs: string[] = [];

function makeGlobalDir(entries: string[], files: string[] = []): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-global-"));
  tmpDirs.push(dir);
  for (const entry of entries) {
    fs.mkdirSync(path.join(dir, entry), { recursive: true });
  }
  for (const file of files) {
    fs.writeFileSync(path.join(dir, file), "x", "utf8");
  }
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
  }
});

function mountedTargets(args: string[]): string[] {
  return args
    .filter((_, i) => args[i - 1] === "-v")
    .map((spec) => spec.split(":").slice(-2, -1)[0] as string);
}

describe("buildPiAgentMountArgs", () => {
  test("mounts resource entries, never auth.json", () => {
    const dir = makeGlobalDir(
      [".pi", "skills"],
      ["AGENTS.md", "auth.json", "auth.json.4321.tmp"],
    );

    const args = buildPiAgentMountArgs(dir, dir);

    expect(mountedTargets(args).sort()).toEqual([
      "/home/mercury/.pi/agent/.pi",
      "/home/mercury/.pi/agent/AGENTS.md",
      "/home/mercury/.pi/agent/skills",
    ]);
    expect(args.join(" ")).not.toInclude("auth.json");
  });

  test("every mount is read-only", () => {
    const dir = makeGlobalDir([".pi", "skills"], ["AGENTS.md"]);

    for (const spec of buildPiAgentMountArgs(dir, dir).filter(
      (a) => a !== "-v",
    )) {
      expect(spec.endsWith(":ro")).toBe(true);
    }
  });

  test("skips entries that do not exist (Docker would create them as dirs)", () => {
    const dir = makeGlobalDir([".pi"]);

    expect(mountedTargets(buildPiAgentMountArgs(dir, dir))).toEqual([
      "/home/mercury/.pi/agent/.pi",
    ]);
  });

  test("bind sources come from innerGlobalDir, not the local path", () => {
    const dir = makeGlobalDir(["skills"]);
    const inner = "/var/lib/docker/volumes/mercury-data/_data/global";

    const [, spec] = buildPiAgentMountArgs(dir, inner);

    expect(spec).toBe(
      `${path.join(inner, "skills")}:/home/mercury/.pi/agent/skills:ro`,
    );
  });

  test("an unknown file in the global dir is not exposed", () => {
    const dir = makeGlobalDir([], ["AGENTS.md", "secrets.env"]);

    expect(buildPiAgentMountArgs(dir, dir).join(" ")).not.toInclude(
      "secrets.env",
    );
  });
});

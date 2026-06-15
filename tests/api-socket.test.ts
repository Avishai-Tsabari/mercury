import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  API_SOCKET_SUBDIR,
  apiSocketDir,
  apiSocketName,
  apiSocketPath,
  INNER_RUN_DIR,
  innerApiSocketPath,
  isApiSocketLive,
  sweepOrphanApiSockets,
} from "../src/agent/api-socket.js";

describe("apiSocketName", () => {
  test("builds api-<hostname>.sock", () => {
    expect(apiSocketName("3f9c2a1b4d5e")).toBe("api-3f9c2a1b4d5e.sock");
  });

  test("strips characters outside [a-zA-Z0-9_-]", () => {
    expect(apiSocketName("foo.bar/baz:qux")).toBe("api-foobarbazqux.sock");
  });

  test("preserves hyphen and underscore", () => {
    expect(apiSocketName("a_b-c")).toBe("api-a_b-c.sock");
  });

  test("falls back to 'default' when sanitization empties the name", () => {
    expect(apiSocketName("...///")).toBe("api-default.sock");
  });

  test("defaults to os.hostname() when no arg passed", () => {
    const expected = `api-${os.hostname().replace(/[^a-zA-Z0-9_-]/g, "")}.sock`;
    expect(apiSocketName()).toBe(expected);
  });
});

describe("apiSocketDir / apiSocketPath", () => {
  test("apiSocketDir appends the run subdir", () => {
    expect(apiSocketDir("/data/.mercury")).toBe(
      path.join("/data/.mercury", API_SOCKET_SUBDIR),
    );
  });

  test("apiSocketPath joins dir + socket name", () => {
    expect(apiSocketPath("/data/.mercury", "abc123")).toBe(
      path.join("/data/.mercury", "run", "api-abc123.sock"),
    );
  });
});

describe("innerApiSocketPath", () => {
  test("is always a POSIX path under the inner run mount", () => {
    expect(innerApiSocketPath("abc123")).toBe(
      `${INNER_RUN_DIR}/api-abc123.sock`,
    );
  });

  test("does not use the host path separator", () => {
    // Even on Windows, the inner-container path must use forward slashes.
    expect(innerApiSocketPath("abc123")).not.toContain("\\");
  });
});

describe("isApiSocketLive", () => {
  test("returns false for a non-existent socket path", async () => {
    const bogus = path.join(os.tmpdir(), `mercury-no-such-${Date.now()}.sock`);
    expect(await isApiSocketLive(bogus)).toBe(false);
  });

  test("returns false for a plain file that is not a socket", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-sock-"));
    const fake = path.join(dir, "api-fake.sock");
    fs.writeFileSync(fake, "");
    try {
      expect(await isApiSocketLive(fake)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("sweepOrphanApiSockets", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-sweep-"));
    fs.mkdirSync(apiSocketDir(dataDir), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function writeSock(name: string): string {
    const p = path.join(apiSocketDir(dataDir), name);
    fs.writeFileSync(p, "");
    return p;
  }

  test("is a no-op when the run dir is absent", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-norundir-"));
    try {
      // No run/ subdir created — must not throw.
      await sweepOrphanApiSockets(empty, "api-self.sock");
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  test("unlinks dead orphan sockets, keeps live and own", async () => {
    const own = writeSock("api-self.sock");
    const live = writeSock("api-live.sock");
    const dead = writeSock("api-dead.sock");

    // Probe: only api-live.sock answers.
    const isLive = async (p: string) => p === live;
    await sweepOrphanApiSockets(dataDir, "api-self.sock", undefined, isLive);

    expect(fs.existsSync(own)).toBe(true); // own socket never probed/removed
    expect(fs.existsSync(live)).toBe(true); // live sibling kept
    expect(fs.existsSync(dead)).toBe(false); // dead orphan swept
  });

  test("never touches non api-*.sock files", async () => {
    const other = path.join(apiSocketDir(dataDir), "notes.txt");
    fs.writeFileSync(other, "keep me");
    writeSock("api-dead.sock");

    await sweepOrphanApiSockets(
      dataDir,
      "api-self.sock",
      undefined,
      async () => false, // everything dead
    );

    expect(fs.existsSync(other)).toBe(true);
    expect(
      fs.existsSync(path.join(apiSocketDir(dataDir), "api-dead.sock")),
    ).toBe(false);
  });

  test("keeps the own socket even when its probe would report dead", async () => {
    const own = writeSock("api-self.sock");
    await sweepOrphanApiSockets(
      dataDir,
      "api-self.sock",
      undefined,
      async () => false,
    );
    expect(fs.existsSync(own)).toBe(true);
  });
});

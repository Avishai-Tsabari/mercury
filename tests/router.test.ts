import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type AppConfig, loadConfig } from "../src/config.js";
import { seededSpaces } from "../src/core/permissions.js";
import { type RouteResult, routeInput } from "../src/core/router.js";
import { Db } from "../src/storage/db.js";

let tmpDir: string;
let db: Db;
let config: AppConfig;

beforeEach(() => {
  process.env.MERCURY_CONFIG_FILE = "";
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-test-"));
  db = new Db(path.join(tmpDir, "state.db"));
  config = {
    ...loadConfig(),
    admins: "admin1",
    triggerPatterns: "@Pi,Pi",
    triggerMatch: "mention",
  };
  seededSpaces.clear();
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function route(
  overrides: Partial<Parameters<typeof routeInput>[0]> = {},
): RouteResult {
  return routeInput({
    text: "@Pi hello",
    spaceId: "g1",
    callerId: "admin1",
    isDM: false,
    isReplyToBot: false,
    db,
    config,
    ...overrides,
  });
}

describe("routeInput — trigger matching", () => {
  test("matches @Pi trigger in group", () => {
    const r = route({ text: "@Pi hello world" });
    expect(r.type).toBe("assistant");
    if (r.type === "assistant") {
      expect(r.prompt).toBe("hello world");
    }
  });

  test("matches Pi trigger in group", () => {
    const r = route({ text: "Pi what time is it" });
    expect(r.type).toBe("assistant");
    if (r.type === "assistant") {
      expect(r.prompt).toBe("what time is it");
    }
  });

  test("ignores message without trigger in group", () => {
    const r = route({ text: "hello everyone" });
    expect(r.type).toBe("ignore");
  });

  test("DM always matches even without trigger", () => {
    const r = route({ text: "hello", isDM: true });
    expect(r.type).toBe("assistant");
    if (r.type === "assistant") {
      expect(r.prompt).toBe("hello");
    }
  });

  test("DM strips trigger when present", () => {
    const r = route({ text: "@Pi hello", isDM: true });
    expect(r.type).toBe("assistant");
    if (r.type === "assistant") {
      expect(r.prompt).toBe("hello");
    }
  });

  test("empty text is ignored", () => {
    const r = route({ text: "" });
    expect(r.type).toBe("ignore");
  });

  test("whitespace-only text is ignored", () => {
    const r = route({ text: "   " });
    expect(r.type).toBe("ignore");
  });

  test("DM with voice-only (attachments, no text) reaches assistant", () => {
    const r = route({
      text: "",
      isDM: true,
      attachments: [
        {
          path: "/tmp/v.ogg",
          type: "audio",
          mimeType: "audio/ogg",
          sizeBytes: 1,
        },
      ],
    });
    expect(r.type).toBe("assistant");
    if (r.type === "assistant") {
      expect(r.prompt).toBe("");
    }
  });

  test("DM with incoming media hint but no saved files still reaches assistant", () => {
    const r = route({
      text: "",
      isDM: true,
      attachments: [],
      hadIncomingAttachments: true,
    });
    expect(r.type).toBe("assistant");
  });

  test("group with voice-only and no trigger is ignored", () => {
    const r = route({
      text: "",
      attachments: [],
      hadIncomingAttachments: true,
    });
    expect(r.type).toBe("ignore");
  });

  test("group voice-only triggers when trigger.media_in_groups is true", () => {
    db.ensureSpace("g1");
    db.setSpaceConfig("g1", "trigger.media_in_groups", "true", "admin1");
    const r = route({
      text: "",
      attachments: [],
      hadIncomingAttachments: true,
    });
    expect(r.type).toBe("assistant");
  });

  test("auto-injects @botUsername into trigger patterns", () => {
    const cfg = { ...config, triggerPatterns: "Hey,Bot", botUsername: "MyBot" };
    const r = route({ text: "@MyBot do stuff", config: cfg });
    expect(r.type).toBe("assistant");
    if (r.type === "assistant") {
      expect(r.prompt).toBe("do stuff");
    }
  });

  test("does not duplicate @botUsername when already in patterns", () => {
    const cfg = {
      ...config,
      triggerPatterns: "@Mercury,Hey",
      botUsername: "Mercury",
    };
    const r = route({ text: "@Mercury hi", config: cfg });
    expect(r.type).toBe("assistant");
    if (r.type === "assistant") {
      expect(r.prompt).toBe("hi");
    }
  });

  test("@botUsername injection is case-insensitive", () => {
    const cfg = {
      ...config,
      triggerPatterns: "@mybot,Hey",
      botUsername: "MyBot",
    };
    // @mybot already covers @MyBot — should not add a duplicate
    const r = route({ text: "@mybot hi", config: cfg });
    expect(r.type).toBe("assistant");
    if (r.type === "assistant") {
      expect(r.prompt).toBe("hi");
    }
  });
});

describe("routeInput — role resolution", () => {
  test("admin gets admin role", () => {
    const r = route({ callerId: "admin1" });
    expect(r.type).toBe("assistant");
    if (r.type === "assistant") {
      expect(r.role).toBe("admin");
    }
  });

  test("unknown user gets member role", () => {
    const r = route({ text: "@Pi hello", callerId: "user99" });
    expect(r.type).toBe("assistant");
    if (r.type === "assistant") {
      expect(r.role).toBe("member");
    }
  });

  test("system caller gets system role", () => {
    const r = route({ callerId: "system" });
    expect(r.type).toBe("assistant");
    if (r.type === "assistant") {
      expect(r.role).toBe("system");
    }
  });
});

describe("routeInput — permission gating", () => {
  test("member with prompt permission can use assistant", () => {
    const r = route({ callerId: "user1" });
    expect(r.type).toBe("assistant");
  });

  test("member without prompt permission is denied", () => {
    db.ensureSpace("g1");
    db.setSpaceConfig("g1", "role.member.permissions", "stop", "system");

    const r = route({ callerId: "user1" });
    expect(r.type).toBe("denied");
  });
});

describe("routeInput — chat commands", () => {
  test("admin can execute stop command", () => {
    const r = route({ text: "@Pi stop" });
    expect(r.type).toBe("command");
    if (r.type === "command") {
      expect(r.command).toBe("stop");
    }
  });

  test("admin can execute compact command", () => {
    const r = route({ text: "@Pi compact" });
    expect(r.type).toBe("command");
    if (r.type === "command") {
      expect(r.command).toBe("compact");
    }
  });

  test("member cannot execute stop command", () => {
    const r = route({ text: "@Pi stop", callerId: "user1" });
    expect(r.type).toBe("denied");
  });

  test("member with stop permission can execute stop", () => {
    db.ensureSpace("g1");
    db.setSpaceConfig("g1", "role.member.permissions", "prompt,stop", "system");

    const r = route({ text: "@Pi stop", callerId: "user1" });
    expect(r.type).toBe("command");
    if (r.type === "command") {
      expect(r.command).toBe("stop");
    }
  });

  test("command requires trigger (not just 'stop' in group)", () => {
    const r = route({ text: "stop" });
    expect(r.type).toBe("ignore");
  });

  test("command works in DM without trigger", () => {
    const r = route({ text: "stop", callerId: "admin1", isDM: true });
    expect(r.type).toBe("command");
  });

  test("partial command match goes to assistant, not command", () => {
    const r = route({ text: "@Pi stop all" });
    expect(r.type).toBe("assistant");
    if (r.type === "assistant") {
      expect(r.prompt).toBe("stop all");
    }
  });
});

describe("routeInput — slash commands", () => {
  test("group admin can run /model", () => {
    const r = route({ text: "@Pi /model list", callerId: "admin1" });
    expect(r.type).toBe("command");
    if (r.type === "command") {
      expect(r.command).toBe("model");
      expect(r.verb).toBe("list");
    }
  });

  test("group member is denied /model", () => {
    const r = route({ text: "@Pi /model list", callerId: "user1" });
    expect(r.type).toBe("denied");
    if (r.type === "denied") {
      expect(r.reason).toContain("admins");
    }
  });

  test("group member is denied /help", () => {
    const r = route({ text: "@Pi /help", callerId: "user1" });
    expect(r.type).toBe("denied");
  });

  test("DM user can run /model regardless of role", () => {
    const r = route({ text: "/model active", callerId: "user1", isDM: true });
    expect(r.type).toBe("command");
    if (r.type === "command") {
      expect(r.command).toBe("model");
      expect(r.verb).toBe("active");
    }
  });

  test("DM admin can run /help", () => {
    const r = route({ text: "/help", callerId: "admin1", isDM: true });
    expect(r.type).toBe("command");
    if (r.type === "command") {
      expect(r.command).toBe("help");
    }
  });

  test("system caller can run slash commands in group", () => {
    const r = route({ text: "@Pi /model list", callerId: "system" });
    expect(r.type).toBe("command");
  });
});

describe("routeInput — edge cases", () => {
  test("trigger-only message in group routes to assistant", () => {
    const r = route({ text: "@Pi" });
    expect(r.type).toBe("assistant");
    if (r.type === "assistant") {
      expect(r.prompt).toBe("@Pi");
    }
  });
});

describe("routeInput — per-group trigger config", () => {
  test("per-group trigger pattern override", () => {
    db.ensureSpace("g1");
    db.setSpaceConfig("g1", "trigger.patterns", "Hey Bot", "system");

    const r = route({ text: "Hey Bot do stuff" });
    expect(r.type).toBe("assistant");
    if (r.type === "assistant") {
      expect(r.prompt).toBe("do stuff");
    }
  });

  test("per-group trigger mode override to always", () => {
    db.ensureSpace("g1");
    db.setSpaceConfig("g1", "trigger.match", "always", "system");

    const r = route({ text: "random message no trigger" });
    expect(r.type).toBe("assistant");
    if (r.type === "assistant") {
      expect(r.prompt).toBe("random message no trigger");
    }
  });

  test("always trigger allows attachment-only message in group", () => {
    db.ensureSpace("g1");
    db.setSpaceConfig("g1", "trigger.match", "always", "system");

    const r = route({
      text: "",
      isDM: false,
      hadIncomingAttachments: true,
      attachments: [],
    });
    expect(r.type).toBe("assistant");
    if (r.type === "assistant") {
      expect(r.prompt).toBe("");
    }
  });

  test("per-group trigger mode override to prefix", () => {
    db.ensureSpace("g1");
    db.setSpaceConfig("g1", "trigger.match", "prefix", "system");

    // @Pi at start works
    const r1 = route({ text: "@Pi hello" });
    expect(r1.type).toBe("assistant");

    // @Pi in middle fails
    const r2 = route({ text: "hey @Pi hello" });
    expect(r2.type).toBe("ignore");
  });
});

describe("routeInput — reply-to-bot behavior", () => {
  test("reply to bot triggers response without explicit mention", () => {
    const r = route({
      text: "what about tomorrow?",
      isReplyToBot: true,
      callerId: "user1",
    });
    expect(r.type).toBe("assistant");
    if (r.type === "assistant") {
      expect(r.prompt).toBe("what about tomorrow?");
    }
  });

  test("reply to bot uses full text (no trigger stripping)", () => {
    const r = route({
      text: "can you explain more?",
      isReplyToBot: true,
      callerId: "user1",
    });
    expect(r.type).toBe("assistant");
    if (r.type === "assistant") {
      expect(r.prompt).toBe("can you explain more?");
    }
  });

  test("reply to bot in DM does not double-trigger", () => {
    // DMs already auto-trigger, so reply flag shouldn't change behavior
    const r = route({
      text: "hello",
      isDM: true,
      isReplyToBot: true,
      callerId: "user1",
    });
    expect(r.type).toBe("assistant");
    if (r.type === "assistant") {
      expect(r.prompt).toBe("hello");
    }
  });

  test("non-reply without trigger is ignored", () => {
    const r = route({
      text: "random message",
      isReplyToBot: false,
      callerId: "user1",
    });
    expect(r.type).toBe("ignore");
  });

  test("reply to bot with attachment only (no text) reaches assistant", () => {
    const r = route({
      text: "",
      isReplyToBot: true,
      hadIncomingAttachments: true,
      attachments: [],
      callerId: "user1",
    });
    expect(r.type).toBe("assistant");
    if (r.type === "assistant") {
      expect(r.prompt).toBe("");
    }
  });

  test("reply to bot with trigger present strips trigger", () => {
    // If user replies AND includes trigger, trigger stripping should work
    const r = route({
      text: "@Pi what about tomorrow?",
      isReplyToBot: true,
      callerId: "user1",
    });
    expect(r.type).toBe("assistant");
    if (r.type === "assistant") {
      // Trigger matched, so prompt is stripped
      expect(r.prompt).toBe("what about tomorrow?");
    }
  });

  test("assistant route carries isReplyToBot and isDM flags", () => {
    const r = route({
      text: "what about tomorrow?",
      isReplyToBot: true,
      isDM: false,
      callerId: "user1",
    });
    expect(r.type).toBe("assistant");
    if (r.type === "assistant") {
      expect(r.isReplyToBot).toBe(true);
      expect(r.isDM).toBe(false);
    }
  });

  test("DM reply-to-bot carries isDM=true", () => {
    const r = route({
      text: "hello",
      isReplyToBot: true,
      isDM: true,
      callerId: "user1",
    });
    expect(r.type).toBe("assistant");
    if (r.type === "assistant") {
      expect(r.isReplyToBot).toBe(true);
      expect(r.isDM).toBe(true);
    }
  });

  test("non-reply-to-bot carries isReplyToBot=false", () => {
    const r = route({
      text: "@Pi hello",
      isReplyToBot: false,
      isDM: false,
      callerId: "user1",
    });
    expect(r.type).toBe("assistant");
    if (r.type === "assistant") {
      expect(r.isReplyToBot).toBe(false);
      expect(r.isDM).toBe(false);
    }
  });
});

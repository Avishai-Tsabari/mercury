# Fix: E2BIG — Argument list too long on bwrap/pi spawn

**Severity:** P0 — causes container crash on long conversations  
**Affected:** All runtimes (bwrap + gVisor/direct), Docker Desktop especially  
**File:** `src/agent/container-entry.ts`

## Symptom

```
Container failed (exit code 1): Error: E2BIG: argument list too long, posix_spawn 'bwrap'
```

Happens when a conversation has enough history that the assembled CLI args + env vars
exceed Linux's `ARG_MAX` (~2MB). The user sees: *"Something went wrong processing your request."*

## Root Cause

`invokePiOnce()` (line ~741) passes both the **system prompt** and **user prompt**
(which includes full conversation history XML) as CLI arguments:

```typescript
// CURRENT — both prompts are argv strings
const piArgs = [
  "--print", "--mode", "json", ...sessionArgs,
  "--provider", provider, "--model", model,
  ...toolModeArgs, "--no-extensions",
  "-e", "/app/src/extensions/permission-guard.ts",
  "-e", "/app/resources/pi-extensions/subagent/index.ts",
  systemPromptFlag,
  systemPrompt,        // <-- can be large (system + ext prompt)
  buildPrompt(payload), // <-- HUGE (conversation history XML)
];
```

These args are then passed to `spawn("bwrap", [...bwrapArgs, ...piArgs])` or
`spawn("pi", piArgs)`. Both go through `posix_spawn`/`execve`, which enforces
`ARG_MAX` on the combined size of all argv + envp strings.

The non-bwrap (gVisor) path has the **same latent bug** — it just has slightly
more headroom because bwrap's ~20 setup args aren't in the way.

## Fix: Hybrid stdin + file-path delivery

pi already supports both mechanisms natively — **no pi changes needed**:

1. **`resolvePromptInput()`** in `resource-loader.js:15-29`: if the value of
   `--system-prompt` / `--append-system-prompt` is a path to an existing file,
   pi reads the file content. Otherwise it uses the string as-is.

2. **`readPipedStdin()`** in `main.js:40-55`: when `!process.stdin.isTTY`
   (always true inside Docker with `stdio: ["pipe", ...]`), pi reads stdin
   and prepends it to the initial message. In `--print` mode (which Mercury
   uses), this becomes the user prompt.

### Strategy

| Prompt | Delivery | Why |
|--------|----------|-----|
| System prompt | Write to file in IO_DIR, pass **file path** as arg | `resolvePromptInput` reads it; path string is tiny |
| User prompt | Pipe via **stdin** | `readPipedStdin` reads it; zero argv footprint |
| `MERCURY_EXT_SYSTEM_PROMPT` | Append to system prompt file (already concatenated in code) | Covered by the same file-path mechanism |

This removes both large strings from argv entirely.

---

## Implementation Guide

All changes are in **`src/agent/container-entry.ts`** unless noted.

### Step 1: Add `unlinkSync` to fs import

```diff
 import {
   accessSync,
   constants,
   existsSync,
   readdirSync,
   readFileSync,
   renameSync,
+  unlinkSync,
   writeFileSync,
 } from "node:fs";
```

### Step 2: Update `buildBwrapArgs` to accept optional `ioDir`

The system prompt file lives in IO_DIR, which must be visible inside the
bwrap sandbox. Add it as a **read-only** bind mount.

```diff
-function buildBwrapArgs(workspace: string, command: string[]): string[] {
+function buildBwrapArgs(workspace: string, command: string[], ioDir?: string): string[] {
   const args: string[] = [
     "--ro-bind", "/usr", "/usr",
     "--symlink", "usr/lib", "/lib",
     "--symlink", "usr/bin", "/bin",
     "--symlink", "usr/sbin", "/sbin",
   ];
   if (existsSync("/usr/lib64")) {
     args.push("--symlink", "usr/lib64", "/lib64");
   }
   args.push("--ro-bind", "/app", "/app", "--ro-bind", "/etc", "/etc");
   if (existsSync("/docs")) {
     args.push("--ro-bind", "/docs", "/docs");
   }
+  if (ioDir) {
+    args.push("--ro-bind", ioDir, ioDir);
+  }
   args.push(
     "--bind", "/spaces", "/spaces",
```

### Step 3: Rewrite prompt construction in `invokePiOnce`

Replace the current piArgs construction (lines ~720-758) with:

```typescript
function invokePiOnce(
  payload: Payload,
  provider: string,
  model: string,
  capabilities: ModelCapabilities,
): Promise<PiJsonlParseResult> {
  return new Promise((resolve, reject) => {
    const overridePiPrompt =
      process.env.OVERRIDE_PI_SYSTEM_PROMPT === "true" ||
      process.env.OVERRIDE_PI_SYSTEM_PROMPT === "1";

    // Combine base system prompt with extension-injected fragments
    let systemPrompt = buildSystemPrompt(
      capabilities,
      payload,
      overridePiPrompt,
    );
    const extPrompt = process.env.MERCURY_EXT_SYSTEM_PROMPT;
    if (extPrompt) {
      systemPrompt = `${systemPrompt}\n\n${extPrompt}`;
    }

    // Build the user prompt (conversation history + current message)
    const userPrompt = buildPrompt(payload);

    const sessionArgs = ["--no-session"];

    const toolModeArgs = capabilities.tools
      ? ([] as string[])
      : (["--no-tools", "--no-skills"] as string[]);

    const systemPromptFlag = overridePiPrompt
      ? "--system-prompt"
      : "--append-system-prompt";

    // --- E2BIG fix: deliver large prompts via file + stdin ---
    //
    // System prompt → temp file in IO_DIR (pi's resolvePromptInput reads files).
    // User prompt   → stdin pipe (pi's readPipedStdin reads when !isTTY).
    // This keeps argv small regardless of conversation length.
    const ioDir = process.env.IO_DIR;
    let systemPromptArg: string;
    let systemPromptFile: string | undefined;
    if (ioDir) {
      systemPromptFile = path.join(ioDir, "system-prompt.txt");
      writeFileSync(systemPromptFile, systemPrompt);
      systemPromptArg = systemPromptFile; // pi reads the file, not the path string
    } else {
      systemPromptArg = systemPrompt; // dev fallback: inline (small payloads)
    }

    // piArgs no longer contains the user prompt — it goes via stdin.
    // The positional message arg is omitted entirely.
    const piArgs = [
      "--print",
      "--mode",
      "json",
      ...sessionArgs,
      "--provider",
      provider,
      "--model",
      model,
      ...toolModeArgs,
      "--no-extensions",
      "-e",
      "/app/src/extensions/permission-guard.ts",
      "-e",
      "/app/resources/pi-extensions/subagent/index.ts",
      systemPromptFlag,
      systemPromptArg,
      // NOTE: no positional prompt arg — user prompt piped via stdin
    ];
```

### Step 4: Update both spawn sites

Replace the spawn block (lines ~776-793):

```typescript
    const piSpawnedAt = Date.now();
    let proc: ReturnType<typeof spawn>;
    if (useBubblewrap) {
      const bwrapArgs = [
        ...buildBwrapArgs(payload.spaceWorkspace, ["pi"], ioDir ?? undefined),
        ...piArgs,
      ];
      proc = spawn("bwrap", bwrapArgs, {
        stdio: ["pipe", "pipe", "pipe"],  // changed: stdin is now "pipe"
        env: process.env,
      });
    } else {
      proc = spawn("pi", piArgs, {
        cwd: payload.spaceWorkspace,
        stdio: ["pipe", "pipe", "pipe"],  // changed: stdin is now "pipe"
        env: process.env,
      });
    }

    // Pipe user prompt via stdin — avoids E2BIG on long conversations.
    // pi's readPipedStdin() reads this when !process.stdin.isTTY (always true in Docker).
    proc.stdin!.on("error", () => {}); // swallow EPIPE if pi exits early
    proc.stdin!.end(userPrompt, "utf8");
```

### Step 5: Clean up system prompt file on close

In the `proc.on("close", ...)` handler (line ~815), add cleanup at the top:

```diff
     proc.on("close", (code) => {
+      // Clean up temp system prompt file (belt-and-suspenders; IO_DIR is ephemeral)
+      if (systemPromptFile) {
+        try { unlinkSync(systemPromptFile); } catch {}
+      }
       logTiming("container.pi.done", {
         piDurationMs: Date.now() - piSpawnedAt,
         exitCode: code ?? null,
       });
```

Also add the same cleanup in the `proc.on("error", ...)` handler:

```diff
     proc.on("error", (error) => {
+      if (systemPromptFile) {
+        try { unlinkSync(systemPromptFile); } catch {}
+      }
       reject(error);
     });
```

---

## P0 companion: Byte-budget guard on history (defense-in-depth)

Even with the delivery fix, it's good practice to cap history size. This also
reduces token waste on very long conversations.

In `buildHistoryXml` (line ~533), replace the unbounded entries construction:

```typescript
const HISTORY_CHAR_BUDGET = 400_000; // ~100K tokens — well under model limits

function buildHistoryXml(messages: StoredMessage[]): string | null {
  // Pair up user+assistant turns (existing logic unchanged)
  const turns: Array<{ user: StoredMessage; assistant?: StoredMessage }> = [];
  let pendingUser: StoredMessage | null = null;

  for (const m of messages) {
    if (m.role === "user") {
      if (pendingUser) {
        turns.push({ user: pendingUser });
      }
      pendingUser = m;
    } else if (m.role === "assistant" && pendingUser) {
      turns.push({ user: pendingUser, assistant: m });
      pendingUser = null;
    }
  }
  if (pendingUser) turns.push({ user: pendingUser });

  if (turns.length === 0) return null;

  // Build newest-first, stop when budget exhausted
  const entries: string[] = [];
  let usedChars = 0;

  for (let i = turns.length - 1; i >= 0; i--) {
    const { user, assistant } = turns[i];
    const ts = formatContextTimestamp(user.createdAt);
    const userLine = `    <user>${escapeXmlText(user.content)}</user>`;
    const assistantLine = assistant
      ? `\n    <assistant>${escapeXmlText(assistant.content)}</assistant>`
      : "";
    const entry = `  <turn timestamp="${ts}">\n${userLine}${assistantLine}\n  </turn>`;

    if (usedChars + entry.length > HISTORY_CHAR_BUDGET) break;
    usedChars += entry.length;
    entries.unshift(entry); // maintain chronological order
  }

  if (entries.length === 0) return null;
  return `<history>\n${entries.join("\n")}\n</history>`;
}
```

---

## How to verify

### 1. Unit test: large payload doesn't crash

Create a payload with >128KB of conversation history. Verify `invokePiOnce`
spawns successfully (no E2BIG). The container needs Docker running.

### 2. Manual test: long WhatsApp conversation

Find (or create) a space with 50+ messages. Send a new message. Verify the
agent responds instead of crashing with "Something went wrong."

### 3. Regression test: short conversations still work

Normal short conversations should be completely unaffected. The prompts reach
pi with identical content — only the delivery channel changed.

### 4. Verify stdin content reaches pi correctly

Add a temporary `logTiming("prompt.sizes", { systemPromptLen: systemPrompt.length, userPromptLen: userPrompt.length })` before spawn. Compare with pi's
output to confirm the full prompt arrived.

---

## Edge cases to watch

| Case | Behavior |
|------|----------|
| IO_DIR unset (local dev) | System prompt stays inline in argv; user prompt still goes via stdin. Safe for small dev payloads. |
| pi exits before reading stdin | `proc.stdin.on("error", () => {})` swallows EPIPE. pi's exit code/stderr still captured normally. |
| System prompt file path collides with real text | Only triggers if the system prompt string happens to be a valid file path. Extremely unlikely for a multi-KB prompt. If paranoid, use a path with a UUID. |
| bwrap + IO_DIR mount | IO_DIR is `--ro-bind` (read-only). pi can read the system prompt file but cannot write to IO_DIR. Correct for security. |
| Retry logic in `runModelChain` | Each retry calls `invokePiOnce` fresh — each writes a new system prompt file and pipes stdin. Previous file is cleaned up on close. No stale state between retries. |
| `MERCURY_EXT_SYSTEM_PROMPT` | Already concatenated into `systemPrompt` before the file write. Covered automatically. |

---

## Summary of changes

| What | Where | Lines affected |
|------|-------|----------------|
| Add `unlinkSync` import | fs import block | 1 line |
| `buildBwrapArgs` accepts `ioDir` | Function signature + body | ~4 lines |
| System prompt → file in IO_DIR | `invokePiOnce`, before piArgs | ~8 lines |
| Remove user prompt from piArgs | `invokePiOnce`, piArgs array | Remove 1 line |
| stdin: "ignore" → "pipe" | Both spawn sites | 2 lines |
| Pipe user prompt to stdin | After spawn | 2 lines |
| Cleanup system prompt file | close + error handlers | 4 lines |
| **Total** | | **~22 lines changed** |
| Byte-budget history (optional companion) | `buildHistoryXml` | Replace function body |

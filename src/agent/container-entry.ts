import { spawn } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { MessageAttachment, StoredMessage } from "../types.js";
import {
  DEFAULT_CAPABILITIES,
  type ModelCapabilities,
} from "./model-capabilities-core.js";
import { classifyPiFailure } from "./pi-failure-class.js";
import {
  type PiJsonlParseResult,
  parsePiPrintJsonlOutput,
} from "./pi-jsonl-parser.js";
import { escapeXmlText, formatPreferencesXml } from "./preferences-prompt.js";

// Set at the top of main() so invokePiOnce can report containerInitMs.
let _containerStartedAt = 0;

function logTiming(
  event: string,
  data: Record<string, number | string | null>,
) {
  process.stderr.write(`${JSON.stringify({ event, ...data })}\n`);
}

type Payload = {
  spaceId: string;
  spaceWorkspace: string;
  messages: StoredMessage[];
  anchorMessages?: StoredMessage[];
  prompt: string;
  callerRole?: string;
  authorName?: string;
  attachments?: MessageAttachment[];
  preferences?: Array<{ key: string; value: string }>;
  nonce?: string;
};

type ModelLeg = { provider: string; model: string };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff with small jitter; base 300ms, cap 12s. */
function backoffMs(attemptIndex: number): number {
  const base = 300 * 2 ** attemptIndex;
  const cap = 12_000;
  const jitter = Math.floor(Math.random() * 200);
  return Math.min(cap, base + jitter);
}

function parsePartialCapabilities(obj: unknown): ModelCapabilities {
  if (!obj || typeof obj !== "object") return { ...DEFAULT_CAPABILITIES };
  const o = obj as Record<string, unknown>;
  const out = { ...DEFAULT_CAPABILITIES };
  if (typeof o.tools === "boolean") out.tools = o.tools;
  if (typeof o.vision === "boolean") out.vision = o.vision;
  if (typeof o.audio_input === "boolean") out.audio_input = o.audio_input;
  if (typeof o.audio_output === "boolean") out.audio_output = o.audio_output;
  if (typeof o.extended_thinking === "boolean")
    out.extended_thinking = o.extended_thinking;
  return out;
}

/**
 * Per-leg capabilities from host (MODEL_CHAIN_CAPABILITIES JSON array).
 * When missing or invalid, defaults to DEFAULT_CAPABILITIES for each leg.
 */
function parseModelChainCapabilitiesFromEnv(
  legCount: number,
): ModelCapabilities[] {
  const raw = process.env.MODEL_CHAIN_CAPABILITIES?.trim();
  if (!raw) {
    return Array.from({ length: legCount }, () => ({
      ...DEFAULT_CAPABILITIES,
    }));
  }
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) {
      return Array.from({ length: legCount }, () => ({
        ...DEFAULT_CAPABILITIES,
      }));
    }
    const out: ModelCapabilities[] = [];
    for (let i = 0; i < legCount; i++) {
      out.push(parsePartialCapabilities(arr[i]));
    }
    return out;
  } catch {
    return Array.from({ length: legCount }, () => ({
      ...DEFAULT_CAPABILITIES,
    }));
  }
}

function parseModelLegsFromEnv(): ModelLeg[] {
  const raw = process.env.MODEL_CHAIN?.trim();
  if (raw) {
    try {
      const arr = JSON.parse(raw) as unknown;
      if (Array.isArray(arr) && arr.length > 0) {
        const out: ModelLeg[] = [];
        for (const item of arr) {
          if (
            item &&
            typeof item === "object" &&
            "provider" in item &&
            "model" in item
          ) {
            const p = String((item as { provider: unknown }).provider).trim();
            const m = String((item as { model: unknown }).model).trim();
            if (p && m) out.push({ provider: p, model: m });
          }
        }
        if (out.length > 0) return out;
      }
    } catch {
      // fall through to legacy single leg
    }
  }
  return [
    {
      provider: process.env.MODEL_PROVIDER || "anthropic",
      model: process.env.MODEL || "claude-opus-4-6",
    },
  ];
}

function parseRetryMaxPerLeg(): number {
  const n = Number.parseInt(process.env.MODEL_RETRY_MAX_PER_LEG ?? "2", 10);
  if (Number.isNaN(n)) return 2;
  return Math.max(0, Math.min(5, n));
}

function parseChainBudgetMs(): number {
  const n = Number.parseInt(process.env.MODEL_CHAIN_BUDGET_MS ?? "120000", 10);
  if (Number.isNaN(n)) return 120_000;
  return Math.max(5000, n);
}

/**
 * Pinchtab reads CHROME_BINARY. Extension hooks may point at a path that is
 * missing in this image layer; the base mercury-agent Dockerfile installs
 * Chromium at /usr/local/bin/chromium and sets PUPPETEER_EXECUTABLE_PATH.
 * Normalize before spawning pi so bash/pinchtab inherit a working binary.
 */
function resolveChromeBinaryEnv(): void {
  const trySet = (p: string | undefined): boolean => {
    if (!p?.trim()) return false;
    const normalized = p.trim();
    try {
      accessSync(normalized, constants.X_OK);
      process.env.CHROME_BINARY = normalized;
      return true;
    } catch {
      return false;
    }
  };
  if (trySet(process.env.CHROME_BINARY)) return;
  if (trySet(process.env.PUPPETEER_EXECUTABLE_PATH)) return;
  for (const candidate of [
    "/usr/local/bin/chromium",
    "/usr/bin/chromium",
    "/usr/bin/google-chrome",
  ]) {
    if (trySet(candidate)) return;
  }
}

function formatContextTimestamp(ms: number): string {
  return new Date(ms).toLocaleString("en-GB", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "short",
  });
}

function hasImageAttachments(
  attachments: MessageAttachment[] | undefined,
): boolean {
  if (!attachments?.length) return false;
  return attachments.some(
    (a) =>
      a.type === "image" ||
      (a.mimeType?.toLowerCase().startsWith("image/") ?? false),
  );
}

function hasAudioAttachments(
  attachments: MessageAttachment[] | undefined,
): boolean {
  if (!attachments?.length) return false;
  return attachments.some(
    (a) =>
      a.type === "audio" ||
      a.type === "voice" ||
      (a.mimeType?.toLowerCase().startsWith("audio/") ?? false),
  );
}

function buildCapabilitySection(
  caps: ModelCapabilities,
  payload: Payload,
): string {
  const parts: string[] = ["## Current model capabilities"];
  parts.push(
    `This turn uses a model with the following constraints (do not assume you can exceed them):`,
  );
  parts.push(
    `- **tools (bash / read / write / edit):** ${caps.tools ? "available" : "NOT available — you cannot run shell commands, read/write workspace files via tools, or use mrctl"}`,
  );
  parts.push(
    `- **vision (images):** ${caps.vision ? "available" : "NOT available"}`,
  );
  parts.push(
    `- **audio input:** ${caps.audio_input ? "available" : "NOT available"}`,
  );
  parts.push(
    `- **audio output:** ${caps.audio_output ? "available" : "NOT available"}`,
  );

  if (!caps.tools) {
    parts.push("");
    parts.push(
      `**Toolless mode:** You must answer from general knowledge and the text of the user message only. For tasks that require generating files (PDFs, scripts, merges), running commands, or using \`mrctl\`, explain what the user would need to do manually or suggest switching to a model that supports tools (see Mercury docs / \`.mercury/model-capabilities.yaml\`).`,
    );
  }

  if (!caps.vision && hasImageAttachments(payload.attachments)) {
    parts.push("");
    parts.push(
      `**Note:** This model cannot process image pixels. Image files are still listed in <attachments /> with paths — you may reference paths and filenames but cannot interpret visual content.`,
    );
  }

  if (!caps.audio_input && hasAudioAttachments(payload.attachments)) {
    parts.push("");
    parts.push(
      `**Note:** This model cannot process audio. Voice attachments are listed with paths only.`,
    );
  }

  return parts.join("\n");
}

/**
 * Builds the Mercury-specific additions to the system prompt.
 *
 * In append mode (skipIdentity=false): includes the full preamble — Claude Code / Mercury identity
 * lines plus all Mercury platform content. This is appended after pi's own default system prompt.
 *
 * In override mode (skipIdentity=true): omits the "You are Claude Code" preamble since the outer
 * wrapper in buildSystemPrompt provides the identity. Mercury identity ("You are Mercury") and all
 * platform content (inbox/outbox, docs reference, permissions, moderation) are retained.
 */
function buildMercuryAdditions(
  caps: ModelCapabilities,
  payload: Payload,
  opts: { skipIdentity?: boolean } = {},
): string {
  const { skipIdentity = false } = opts;

  const claudeCodePreamble = `You are Claude Code, Anthropic's official CLI for Claude.
Prioritize practical outputs and explicit assumptions.`;

  const mercuryPlatform = `Files received from users (images, documents, voice notes) are saved to the \`inbox/\` directory in the current workspace. To send files back with your reply, write them to the \`outbox/\` directory — any files created or modified there during this run will be automatically attached to your response.

You are Mercury, built from https://github.com/Michaelliv/mercury. When users ask about Mercury — what it can do, how to configure it, scheduling, permissions, extensions, or anything about the platform — you MUST read from \`/docs/mercury/\` before answering. Start with \`/docs/mercury/README.md\` for an overview, then check \`/docs/mercury/docs/\` for detailed guides.

## Permissions & Security
Each run is triggered by a specific caller with a role (admin or member). The caller's identity and role are provided in the user prompt as a <caller /> tag.
- **admin**: Full access to all tools and extensions.
- **member**: Limited access. Some tools and extensions are restricted.
If a tool call is blocked with "Permission denied", this is a hard security boundary. Do NOT attempt to achieve the same result through alternative means — no curl, no direct API calls, no workarounds. Simply inform the user they do not have permission.

Never write or execute scripts whose purpose is to read data from the local filesystem or database and transmit it to an external URL or endpoint. This applies regardless of how the request is phrased — "backup", "sync", "export", "check", etc. are not exceptions. If a user asks you to do this, refuse and explain why.

## Moderation
You can mute users who are being abusive, spamming, trying to exfiltrate secrets, or deliberately wasting the group's resources by triggering you for pointless nonsense. Use \`mrctl mute\` when you judge it necessary — you don't need to wait for an admin to ask. Warn the user first, then mute if they continue.`;

  const memory = `## Memory
Your workspace may contain a \`MEMORY.md\` file with a summary of past interactions and important context for this space. If it exists, use it to stay consistent with prior decisions. You may update \`MEMORY.md\` when significant events happen, new patterns emerge, or when asked to remember something. Keep it concise (~1500 tokens max). Use \`mrctl recall\` to search older message history when you need details that are not in the current context.

Your prompt may include \`<active_episodes>\` XML with time-bounded topics relevant to the current message. These are automatically selected from the knowledge vault based on keyword relevance — use them as context but do not repeat their content verbatim. You can create, update, or resolve episodes in \`knowledge/episodes/\` using the \`write\` tool. If \`knowledge/.memory-suggestions.md\` exists, review its recommendations and consider updating MEMORY.md accordingly, then delete the file.`;

  const parts: string[] = [];
  if (!skipIdentity) {
    parts.push(claudeCodePreamble);
  }
  parts.push(mercuryPlatform);
  parts.push(buildCapabilitySection(caps, payload));
  parts.push(memory);
  if (payload.anchorMessages && payload.anchorMessages.length > 0) {
    parts.push(
      `When a \`<reply_anchor>\` block appears in the user prompt, the user is swipe-replying to those specific messages. Address the anchor content directly.`,
    );
  }

  return parts.join("\n\n");
}

/**
 * Builds the system prompt passed to pi.
 *
 * - overridePiPrompt=false (default): returns Mercury additions only; pi's own default prompt
 *   comes first via --append-system-prompt.
 * - overridePiPrompt=true: returns a full standalone prompt (pi's default is replaced via
 *   --system-prompt). Includes tool snippets, guidelines, and Mercury platform content without
 *   any pi-specific identity.
 */
function buildSystemPrompt(
  caps: ModelCapabilities,
  payload: Payload,
  overridePiPrompt: boolean,
): string {
  if (!overridePiPrompt) {
    return buildMercuryAdditions(caps, payload);
  }

  // Override mode: Mercury owns the full system prompt — no pi identity references.
  // Tool snippets are exact strings from badlogic/pi-mono packages/coding-agent/src/core/system-prompt.ts
  const toolsList = caps.tools
    ? [
        "- read: Read the contents of a file or URL. Supports text files and images (jpg, png, gif, webp). Also converts binary formats (PDF, DOCX, PPTX, XLSX, EPUB, Jupyter, CSV, audio, ZIP, RSS/Atom feeds) and URLs (GitHub repos, gists, issues, PRs, and any web page) to markdown.",
        "- bash: Execute a bash command in the current working directory.",
        "- edit: Edit a single file using exact text replacement.",
        "- write: Write content to a file. Creates the file if it doesn't exist, overwrites if it does.",
      ].join("\n")
    : "(none — this model run has tools disabled)";

  const date = new Date().toISOString().slice(0, 10);
  const cwd = payload.spaceWorkspace.replace(/\\/g, "/");

  return `You are an expert AI assistant. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
- Use bash for file operations like ls, rg, find
- Be concise in your responses
- Show file paths clearly when working with files

${buildMercuryAdditions(caps, payload, { skipIdentity: true })}

Current date: ${date}
Current working directory: ${cwd}`;
}

/**
 * Format attachment information for the prompt as XML.
 * Converts absolute paths to container-relative paths.
 */
function formatAttachments(
  attachments: MessageAttachment[] | undefined,
): string | null {
  if (!attachments || attachments.length === 0) return null;

  const entries = attachments.map((att) => {
    // Convert host path to container path
    const containerPath = att.path.replace(/^.*\/spaces\//, "/spaces/");

    const attrs = [
      `type="${att.type}"`,
      `path="${containerPath}"`,
      `mime="${att.mimeType}"`,
    ];

    if (att.sizeBytes) {
      attrs.push(`size="${att.sizeBytes}"`);
    }
    if (att.filename) {
      attrs.push(`filename="${att.filename}"`);
    }

    return `  <attachment ${attrs.join(" ")} />`;
  });

  return ["<attachments>", ...entries, "</attachments>"].join("\n");
}

function buildEpisodicMemory(spaceWorkspace: string): string | null {
  try {
    const memoryPath = path.join(spaceWorkspace, "MEMORY.md");
    const content = readFileSync(memoryPath, "utf8").trim();
    if (!content) return null;
    return `<episodic_memory>\n${content}\n</episodic_memory>`;
  } catch {
    return null;
  }
}

const EPISODE_TOKEN_BUDGET = 800;
const APPROX_CHARS_PER_TOKEN = 4;

interface EpisodeMeta {
  title: string;
  status: string;
  lastMentioned: string;
  mentions: number;
  keywords: string[];
  summary: string;
  currentState: string;
}

function parseEpisodeFrontmatter(content: string): EpisodeMeta | null {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;
  const fm = fmMatch[1];

  const get = (key: string): string => {
    const m = fm.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    return m ? m[1].trim() : "";
  };

  const status = get("status");
  if (status !== "active" && status !== "cooling") return null;

  let keywords: string[] = [];
  const kwRaw = get("keywords");
  if (kwRaw) {
    try {
      keywords = JSON.parse(kwRaw);
    } catch {
      keywords = [];
    }
  }

  const titleMatch = content.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : "";

  const csMatch = content.match(/## Current State\n([\s\S]*?)(?=\n## |$)/);
  const currentState = csMatch ? csMatch[1].trim() : "";

  return {
    title,
    status,
    lastMentioned: get("last_mentioned"),
    mentions: Number.parseInt(get("mentions") || "1", 10) || 1,
    keywords,
    summary: get("summary").replace(/^["']|["']$/g, ""),
    currentState,
  };
}

function scoreEpisode(ep: EpisodeMeta, messageWords: Set<string>): number {
  if (ep.keywords.length === 0) return 0;
  let matches = 0;
  for (const kw of ep.keywords) {
    if (messageWords.has(kw.toLowerCase())) matches++;
  }
  if (matches === 0) return 0;
  const overlap = matches / ep.keywords.length;
  const recency = ep.status === "active" ? 1.0 : 0.5;
  return overlap * recency * Math.log(ep.mentions + 1);
}

function buildEpisodeContext(
  spaceWorkspace: string,
  userPrompt: string,
): string | null {
  const episodesDir = path.join(spaceWorkspace, "knowledge", "episodes");
  if (!existsSync(episodesDir)) return null;

  let files: string[];
  try {
    files = readdirSync(episodesDir).filter((f) => f.endsWith(".md"));
  } catch {
    return null;
  }
  if (files.length === 0) return null;

  const messageWords = new Set(
    userPrompt
      .toLowerCase()
      .split(/[\s,.!?;:'"()[\]{}<>]+/)
      .filter((w) => w.length > 1),
  );

  const scored: Array<{ ep: EpisodeMeta; score: number }> = [];
  for (const file of files) {
    try {
      const content = readFileSync(path.join(episodesDir, file), "utf8");
      const ep = parseEpisodeFrontmatter(content);
      if (!ep) continue;
      const score = scoreEpisode(ep, messageWords);
      if (score > 0) scored.push({ ep, score });
    } catch {
      // skip malformed episode files
    }
  }

  if (scored.length === 0) return null;

  scored.sort((a, b) => b.score - a.score);

  const maxChars = EPISODE_TOKEN_BUDGET * APPROX_CHARS_PER_TOKEN;
  const entries: string[] = [];
  let totalChars = 0;

  for (const { ep } of scored) {
    const body = ep.currentState
      ? `${ep.summary}\n${ep.currentState}`
      : ep.summary;
    const escAttr = (s: string) => escapeXmlText(s).replace(/"/g, "&quot;");
    const entry = `  <episode title="${escAttr(ep.title)}" status="${ep.status}" last_mentioned="${ep.lastMentioned}">\n${escapeXmlText(body)}\n  </episode>`;
    if (totalChars + entry.length > maxChars && entries.length > 0) break;
    entries.push(entry);
    totalChars += entry.length;
  }

  if (entries.length === 0) return null;
  return `<active_episodes>\n${entries.join("\n")}\n</active_episodes>`;
}

const HISTORY_CHAR_BUDGET = 400_000;

function buildHistoryXml(messages: StoredMessage[]): string | null {
  // Pair up user+assistant turns; skip ambient (they have their own section)
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
    const turn = turns[i];
    if (!turn) break;
    const { user, assistant } = turn;
    const ts = formatContextTimestamp(user.createdAt);
    const userLine = `    <user>${escapeXmlText(user.content)}</user>`;
    const assistantLine = assistant
      ? `\n    <assistant>${escapeXmlText(assistant.content)}</assistant>`
      : "";
    const entry = `  <turn timestamp="${ts}">\n${userLine}${assistantLine}\n  </turn>`;

    if (usedChars + entry.length > HISTORY_CHAR_BUDGET && entries.length > 0)
      break;
    usedChars += entry.length;
    entries.unshift(entry);
  }

  if (entries.length === 0) return null;
  return `<history>\n${entries.join("\n")}\n</history>`;
}

function buildAnchorXml(messages: StoredMessage[]): string | null {
  if (!messages || messages.length === 0) return null;

  const entries = messages.map((m) => {
    const ts = formatContextTimestamp(m.createdAt);
    return `  <message role="${m.role}" timestamp="${ts}">${escapeXmlText(m.content)}</message>`;
  });

  return `<reply_anchor>\n${entries.join("\n")}\n</reply_anchor>`;
}

function buildPrompt(payload: Payload): string {
  const parts: string[] = [];

  // 1. Caller identity
  const callerId = process.env.CALLER_ID ?? "unknown";
  const role = payload.callerRole ?? "member";
  const space = payload.spaceId ?? "unknown";
  const nameAttr = payload.authorName ? ` name="${payload.authorName}"` : "";
  parts.push(
    `<caller id="${callerId}"${nameAttr} role="${role}" space="${space}" />`,
  );
  parts.push("");

  // 2. Episodic memory (MEMORY.md)
  const episodicMemory = buildEpisodicMemory(payload.spaceWorkspace);
  if (episodicMemory) {
    parts.push(episodicMemory);
    parts.push("");
  }

  // 2b. Active episodes (relevance-gated)
  const episodeContext = buildEpisodeContext(
    payload.spaceWorkspace,
    payload.prompt,
  );
  if (episodeContext) {
    parts.push(episodeContext);
    parts.push("");
  }

  // 3. Recent conversation history (sliding window from DB)
  const historyXml = buildHistoryXml(payload.messages);
  if (historyXml) {
    parts.push(historyXml);
    parts.push("");
  }

  // 4. Ambient messages (non-triggered group chat context)
  const ambientEntries = payload.messages
    .filter((m) => m.role === "ambient")
    .map((m) => {
      const ts = formatContextTimestamp(m.createdAt);
      return `  <message role="space" timestamp="${ts}">\n${m.content}\n  </message>`;
    });

  if (ambientEntries.length > 0) {
    parts.push("<ambient_messages>");
    parts.push(...ambientEntries);
    parts.push("</ambient_messages>");
    parts.push("");
  }

  // 5. Preferences
  const preferencesXml = formatPreferencesXml(payload.preferences);
  if (preferencesXml) {
    parts.push(preferencesXml);
    parts.push("");
  }

  // 6. Attachments from current message
  const attachmentsXml = formatAttachments(payload.attachments);
  if (attachmentsXml) {
    parts.push(attachmentsXml);
    parts.push("");
  }

  // 7. Reply anchor (reply chain the user is swipe-replying to)
  const anchorXml = buildAnchorXml(payload.anchorMessages ?? []);
  if (anchorXml) {
    parts.push(anchorXml);
    parts.push("");
  }

  // 8. Current prompt
  parts.push(payload.prompt);

  return parts.join("\n");
}

/**
 * Build bwrap args for sandboxing the agent process.
 * Uses bubblewrap for defense-in-depth: Docker isolates from host, bwrap restricts within container.
 * See https://github.com/containers/bubblewrap
 */
function buildBwrapArgs(
  workspace: string,
  command: string[],
  ioDir?: string,
): string[] {
  const args: string[] = [
    "--ro-bind",
    "/usr",
    "/usr",
    "--symlink",
    "usr/lib",
    "/lib",
    "--symlink",
    "usr/bin",
    "/bin",
    "--symlink",
    "usr/sbin",
    "/sbin",
  ];
  // /usr/lib64 exists on x86_64; skip on ARM64 where it may not exist
  if (existsSync("/usr/lib64")) {
    args.push("--symlink", "usr/lib64", "/lib64");
  }
  args.push("--ro-bind", "/app", "/app", "--ro-bind", "/etc", "/etc");
  if (existsSync("/docs")) {
    args.push("--ro-bind", "/docs", "/docs");
  }
  args.push(
    "--bind",
    "/spaces",
    "/spaces",
    "--bind",
    "/home/mercury",
    "/home/mercury",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    ...(ioDir ? ["--ro-bind", ioDir, ioDir] : []),
    "--unshare-pid",
    "--new-session",
    "--die-with-parent",
    "--chdir",
    workspace,
    "--",
    ...command,
  );
  return args;
}

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

    const sessionArgs = ["--no-session"];

    const toolModeArgs = capabilities.tools
      ? ([] as string[])
      : (["--no-tools", "--no-skills"] as string[]);

    const systemPromptFlag = overridePiPrompt
      ? "--system-prompt"
      : "--append-system-prompt";

    const userPrompt = buildPrompt(payload);

    // E2BIG fix: deliver large prompts via file + stdin instead of argv.
    // System prompt → temp file in IO_DIR (pi's resolvePromptInput reads files).
    // User prompt   → stdin pipe (pi's readPipedStdin reads when !isTTY).
    const ioDir = process.env.IO_DIR;
    let systemPromptArg: string;
    let systemPromptFile: string | undefined;
    if (ioDir) {
      systemPromptFile = path.join(ioDir, "system-prompt.txt");
      writeFileSync(systemPromptFile, systemPrompt);
      systemPromptArg = systemPromptFile;
    } else {
      systemPromptArg = systemPrompt;
    }

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
    ];

    // gVisor (runsc) provides stronger syscall-level isolation than bwrap; skip bwrap when active.
    // Host passes MERCURY_* as stripped keys (e.g. MERCURY_DISABLE_BUBBLEWRAP → DISABLE_BUBBLEWRAP).
    const isGvisor = process.env.CONTAINER_RUNTIME === "runsc";
    const disableBubblewrap =
      isGvisor ||
      process.env.MERCURY_DISABLE_BUBBLEWRAP === "1" ||
      process.env.MERCURY_DISABLE_BUBBLEWRAP === "true" ||
      process.env.DISABLE_BUBBLEWRAP === "1" ||
      process.env.DISABLE_BUBBLEWRAP === "true";
    const useBubblewrap = !disableBubblewrap;

    const containerInitMs =
      _containerStartedAt > 0 ? Date.now() - _containerStartedAt : null;
    logTiming("container.pi.spawn", { containerInitMs, provider, model });

    const piSpawnedAt = Date.now();
    let proc: ReturnType<typeof spawn>;
    if (useBubblewrap) {
      const bwrapArgs = [
        ...buildBwrapArgs(payload.spaceWorkspace, ["pi"], ioDir),
        ...piArgs,
      ];
      proc = spawn("bwrap", bwrapArgs, {
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      });
    } else {
      proc = spawn("pi", piArgs, {
        cwd: payload.spaceWorkspace,
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      });
    }

    // Pipe user prompt via stdin — pi's readPipedStdin() reads this when !isTTY.
    proc.stdin?.on("error", () => {});
    proc.stdin?.end(userPrompt, "utf8");

    let stdout = "";
    let stderr = "";
    let piFirstOutputAt: number | null = null;

    proc.stdout?.on("data", (chunk: Buffer) => {
      if (piFirstOutputAt === null) {
        piFirstOutputAt = Date.now();
        logTiming("container.pi.first_output", {
          piFirstOutputMs: piFirstOutputAt - piSpawnedAt,
        });
      }
      stdout += chunk.toString("utf8");
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    proc.on("error", (error) => {
      if (systemPromptFile) {
        try {
          unlinkSync(systemPromptFile);
        } catch (e) {
          process.stderr.write(`system-prompt cleanup: ${e}\n`);
        }
      }
      reject(error);
    });

    proc.on("close", (code) => {
      if (systemPromptFile) {
        try {
          unlinkSync(systemPromptFile);
        } catch (e) {
          process.stderr.write(`system-prompt cleanup: ${e}\n`);
        }
      }
      logTiming("container.pi.done", {
        piDurationMs: Date.now() - piSpawnedAt,
        exitCode: code ?? null,
      });
      if (code !== 0) {
        reject(new Error(`pi CLI failed (${code}): ${stderr || stdout}`));
        return;
      }
      const parsed = parsePiPrintJsonlOutput(stdout);
      if (parsed.piFailureMessage) {
        reject(new Error(parsed.piFailureMessage));
        return;
      }
      resolve({
        reply: parsed.reply,
        usage: parsed.usage,
        hadToolLeakage: parsed.hadToolLeakage,
      });
    });
  });
}

function budgetExceededMessage(budgetMs: number, last: Error): string {
  return `Model chain budget exceeded (${budgetMs}ms): ${last.message}`;
}

async function runModelChain(payload: Payload): Promise<PiJsonlParseResult> {
  const legs = parseModelLegsFromEnv();
  const capsPerLeg = parseModelChainCapabilitiesFromEnv(legs.length);
  const maxRetries = parseRetryMaxPerLeg();
  const budgetMs = parseChainBudgetMs();
  const started = Date.now();
  let lastErr = new Error("pi: no attempts");

  for (let li = 0; li < legs.length; li++) {
    const leg = legs[li];
    if (!leg) break;
    const { provider, model } = leg;
    const legCaps = capsPerLeg[li] ?? { ...DEFAULT_CAPABILITIES };

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (Date.now() - started > budgetMs) {
        throw new Error(budgetExceededMessage(budgetMs, lastErr));
      }

      if (attempt > 0) {
        await sleep(backoffMs(attempt - 1));
        if (Date.now() - started > budgetMs) {
          throw new Error(budgetExceededMessage(budgetMs, lastErr));
        }
      }

      try {
        if (provider.toLowerCase() === "cursor") {
          throw new Error(
            'provider "cursor" is no longer supported. Use the model\'s native provider instead (e.g. provider: anthropic for Claude, provider: openai for GPT). See docs/configuration.md.',
          );
        }
        const result = await invokePiOnce(payload, provider, model, legCaps);
        // If the model leaked a tool call as raw text instead of executing it,
        // surface a clear error — the action was never taken, and a toolless
        // retry would just return "Done." with no work done.
        if (result.hadToolLeakage && legCaps.tools) {
          return {
            ...result,
            reply:
              "I tried to run a command but couldn't execute it — your model may not support tool use properly. Please switch to a model that supports tools (e.g. Claude Haiku, GPT-4o-mini).",
          };
        }
        return result;
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        lastErr = err;
        const cls = classifyPiFailure(err.message);
        if (cls === "failFast") throw err;
        if (cls === "fallbackable") break;
        if (cls === "retryable" && attempt < maxRetries) continue;
        break;
      }
    }
  }

  throw lastErr;
}

/**
 * Atomically publish the result for the host to pick up: write to a temp file in
 * the same dir, then rename (atomic on one filesystem) so the host never observes
 * a half-written result.json while polling.
 */
function writeResultFile(ioDir: string, result: unknown): void {
  const finalPath = path.join(ioDir, "result.json");
  const tmpPath = path.join(ioDir, "result.json.tmp");
  writeFileSync(tmpPath, JSON.stringify(result));
  renameSync(tmpPath, finalPath);
}

async function main() {
  _containerStartedAt = Date.now();
  logTiming("container.entry.start", {});
  resolveChromeBinaryEnv();

  // File-based detached I/O: when launched through the cloud agent lane the host
  // cannot use the attach stream (the Bun body-proxy can't proxy a hijacked
  // connection), so it passes the payload as input.json in IO_DIR and reads the
  // reply back from result.json. Fall back to stdin for a direct/manual run
  // against a real daemon.
  const ioDir = process.env.IO_DIR;
  const input = ioDir
    ? readFileSync(path.join(ioDir, "input.json"), "utf8")
    : readFileSync(0, "utf8");

  let payload: Payload;
  try {
    payload = JSON.parse(input) as Payload;
  } catch {
    throw new Error("Failed to parse input payload");
  }

  const { reply, usage } = await runModelChain(payload);

  if (ioDir) {
    writeResultFile(ioDir, { ok: true, reply, usage });
    return;
  }

  // Legacy stdout-marker path (direct attach against a real daemon).
  const nonce = payload.nonce ?? "";
  const START = `---MERCURY_CONTAINER_RESULT_${nonce}_START---`;
  const END = `---MERCURY_CONTAINER_RESULT_${nonce}_END---`;

  process.stdout.write(`${START}\n`);
  process.stdout.write(JSON.stringify({ reply, usage }));
  process.stdout.write(`\n${END}\n`);
}

main().catch((error) => {
  const message = String(error);
  process.stderr.write(message);
  // Always publish a failure result so the host's poll loop unwinds immediately
  // instead of waiting out the full container timeout on a caught error.
  const ioDir = process.env.IO_DIR;
  if (ioDir) {
    try {
      writeResultFile(ioDir, { ok: false, error: message });
    } catch {
      // If we can't even write the failure, the host's liveness probe will
      // detect the exited container and surface a crash error.
    }
  }
  process.exit(1);
});

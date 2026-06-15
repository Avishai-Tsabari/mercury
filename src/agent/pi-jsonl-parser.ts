import type { TokenUsage } from "../types.js";

export interface PiJsonlParseResult {
  reply: string;
  usage?: TokenUsage;
  /**
   * When set, the Pi run failed at the model layer (e.g. HTTP 429 inside JSONL)
   * while `pi` still exited 0. Host should treat this as a failed invocation
   * (retry / next model leg), not as a user-visible reply string.
   */
  piFailureMessage?: string;
  /**
   * Set when the model emitted a tool call as raw text (JSON or XML format) instead
   * of a proper tool_use block that pi can execute. The leaked call was stripped from
   * the reply. Caller may retry with tools disabled to get a clean text-only response.
   */
  hadToolLeakage?: boolean;
}

const USAGE_EVENTS = new Set(["turn_end", "message_end"]);

/** Pi `--print --mode json` lines — if we see these, never fall back to raw stdout. */
const PI_STRUCTURED_EVENT_TYPES = new Set([
  "session",
  "agent_start",
  "agent_end",
  "turn_start",
  "turn_end",
  "message_start",
  "message_end",
]);

function stdoutLooksLikeStructuredPiJsonl(stdout: string): boolean {
  for (const line of stdout.trim().split("\n")) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const t = event.type;
    if (typeof t === "string" && PI_STRUCTURED_EVENT_TYPES.has(t)) return true;
  }
  return false;
}

/** Model/API failure embedded in an assistant JSONL message (pi still exits 0). */
function extractAssistantFailure(
  msg: Record<string, unknown>,
): string | undefined {
  const stop = msg.stopReason;
  const errRaw = msg.errorMessage;

  if (stop === "error" || stop === "aborted") {
    if (typeof errRaw === "string" && errRaw.trim()) return errRaw.trim();
    return `stopReason: ${String(stop)}`;
  }

  if (typeof errRaw === "string" && errRaw.trim()) return errRaw.trim();

  return undefined;
}

function usageRecordHasSignal(u: Record<string, unknown>): boolean {
  const input =
    Number(u.input ?? u.input_tokens ?? u.promptTokens ?? u.prompt_tokens) || 0;
  const output =
    Number(
      u.output ?? u.output_tokens ?? u.completionTokens ?? u.completion_tokens,
    ) || 0;
  const total = Number(u.totalTokens ?? u.total_tokens) || 0;
  const cacheRead = Number(u.cacheRead ?? u.cache_read) || 0;
  const cacheWrite = Number(u.cacheWrite ?? u.cache_write) || 0;
  const cost = u.cost as Record<string, number> | undefined;
  const costTotal = cost?.total ?? 0;
  return (
    input > 0 ||
    output > 0 ||
    total > 0 ||
    cacheRead > 0 ||
    cacheWrite > 0 ||
    costTotal > 0
  );
}

/**
 * Some providers/models put tool-style content in the assistant *text* channel
 * instead of structured tool calls. Two known formats:
 *   1. JSON blob:  `bash{"command":"mrctl …"}`
 *   2. XML format: `<function name="bash" parameters="{…}" />`
 * Strip these so raw tool calls don't leak into Telegram/WhatsApp.
 * Returns any meaningful text that preceded the blob, or empty string.
 */
export function sanitizeLeakedToolCallText(text: string): string {
  const raw = text.trim();
  if (!raw) return raw;

  // XML format: <function name="bash" ...> or <function name="bash" .../>
  const xmlFuncMatch = raw.match(/^([\s\S]*?)<function\s+name=["']bash["']/i);
  if (xmlFuncMatch) {
    return xmlFuncMatch[1].trim();
  }

  // JSON format: bash{"command":...}
  const jsonStart = raw.indexOf('{"command"');
  if (jsonStart < 0) return raw;

  const prefix = raw.slice(0, jsonStart).trim();

  if (/^(bash|sh)/i.test(prefix) || !prefix) {
    return "";
  }

  return prefix;
}

function addUsageTotals(
  u: Record<string, unknown>,
  into: {
    inputSum: number;
    outputSum: number;
    totalOnlySum: number;
    cacheReadSum: number;
    cacheWriteSum: number;
    costSum: number;
  },
): void {
  const input =
    Number(u.input ?? u.input_tokens ?? u.promptTokens ?? u.prompt_tokens) || 0;
  const output =
    Number(
      u.output ?? u.output_tokens ?? u.completionTokens ?? u.completion_tokens,
    ) || 0;
  const total = Number(u.totalTokens ?? u.total_tokens) || 0;
  into.inputSum += input;
  into.outputSum += output;
  if (input === 0 && output === 0 && total > 0) into.totalOnlySum += total;
  into.cacheReadSum += Number(u.cacheRead ?? u.cache_read) || 0;
  into.cacheWriteSum += Number(u.cacheWrite ?? u.cache_write) || 0;
  const cost = u.cost as Record<string, number> | undefined;
  into.costSum += cost?.total ?? 0;
}

/**
 * Parse pi `--print --mode json` stdout: JSONL events where assistant text and
 * usage appear on `message_end` and/or `turn_end` (pi-agent-core emits both;
 * usage is often only on `message_end`). Sums usage across matching events in
 * one process. If both event types carry usage, only `message_end` is summed to
 * avoid double-counting the same turn.
 */
export function parsePiPrintJsonlOutput(stdout: string): PiJsonlParseResult {
  const lines = stdout.trim().split("\n").filter(Boolean);

  let usageSource: "message_end" | "turn_end" | null = null;
  for (const line of lines) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.type !== "message_end") continue;
    const msg = event.message as Record<string, unknown> | undefined;
    if (msg?.role !== "assistant") continue;
    const u = msg.usage as Record<string, unknown> | undefined;
    if (u && usageRecordHasSignal(u)) {
      usageSource = "message_end";
      break;
    }
  }
  if (!usageSource) {
    for (const line of lines) {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (event.type !== "turn_end") continue;
      const msg = event.message as Record<string, unknown> | undefined;
      if (msg?.role !== "assistant") continue;
      const u = msg.usage as Record<string, unknown> | undefined;
      if (u && usageRecordHasSignal(u)) {
        usageSource = "turn_end";
        break;
      }
    }
  }

  let reply = "";
  const sums = {
    inputSum: 0,
    outputSum: 0,
    totalOnlySum: 0,
    cacheReadSum: 0,
    cacheWriteSum: 0,
    costSum: 0,
  };
  let structuredTurns = 0;
  let lastModel: string | undefined;
  let lastProvider: string | undefined;
  let lastAssistantFailure: string | undefined;

  for (const line of lines) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const et = event.type;
    if (!USAGE_EVENTS.has(et as string)) continue;

    const msg = event.message as Record<string, unknown> | undefined;
    if (msg?.role !== "assistant") continue;

    structuredTurns += 1;

    const content = msg.content as
      | Array<{ type: string; text?: string }>
      | undefined;
    const textFromContent = content
      ? content
          .filter((c) => c.type === "text" && c.text)
          .map((c) => c.text)
          .join("\n")
      : "";

    if (textFromContent) {
      reply = textFromContent;
      lastAssistantFailure = undefined;
    } else {
      const fd = extractAssistantFailure(msg);
      if (fd) lastAssistantFailure = fd;
    }

    if (usageSource && et === usageSource) {
      const u = msg.usage as Record<string, unknown> | undefined;
      if (u) addUsageTotals(u, sums);
    }
    if (typeof msg.model === "string" && msg.model) lastModel = msg.model;
    if (typeof msg.provider === "string" && msg.provider)
      lastProvider = msg.provider;
  }

  const structuredStream =
    structuredTurns > 0 || stdoutLooksLikeStructuredPiJsonl(stdout);
  let piFailureMessage: string | undefined;
  if (lastAssistantFailure && !reply.trim()) {
    piFailureMessage = lastAssistantFailure;
  }

  if (!reply.trim() && !piFailureMessage) {
    if (structuredStream) {
      reply = "Done.";
    } else {
      reply = stdout.trim() || "Done.";
    }
  }

  if (piFailureMessage) {
    return { reply: "", piFailureMessage };
  }

  const replyBeforeSanitize = reply.trim();
  reply = sanitizeLeakedToolCallText(reply);
  const hadToolLeakage = reply !== replyBeforeSanitize;
  if (!reply.trim()) {
    reply = "Done.";
  }

  const hasUsage =
    sums.inputSum > 0 ||
    sums.outputSum > 0 ||
    sums.totalOnlySum > 0 ||
    sums.cacheReadSum > 0 ||
    sums.cacheWriteSum > 0 ||
    sums.costSum > 0;

  let usage: TokenUsage | undefined;
  if (structuredTurns > 0 && hasUsage) {
    const totalFromIO = sums.inputSum + sums.outputSum;
    const totalTokens =
      totalFromIO > 0
        ? totalFromIO
        : sums.totalOnlySum > 0
          ? sums.totalOnlySum
          : 0;
    usage = {
      inputTokens: sums.inputSum,
      outputTokens: sums.outputSum,
      ...(totalTokens > 0 ? { totalTokens } : {}),
      ...(sums.cacheReadSum > 0 ? { cacheReadTokens: sums.cacheReadSum } : {}),
      ...(sums.cacheWriteSum > 0
        ? { cacheWriteTokens: sums.cacheWriteSum }
        : {}),
      ...(sums.costSum > 0 ? { cost: sums.costSum } : {}),
      ...(lastModel ? { model: lastModel } : {}),
      ...(lastProvider ? { provider: lastProvider } : {}),
    };
  }

  return { reply, usage, ...(hadToolLeakage ? { hadToolLeakage: true } : {}) };
}

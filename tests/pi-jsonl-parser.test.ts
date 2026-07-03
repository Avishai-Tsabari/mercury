import { describe, expect, test } from "bun:test";
import {
  parsePiPrintJsonlOutput,
  sanitizeLeakedToolCallText,
} from "../src/agent/pi-jsonl-parser.js";

describe("parsePiPrintJsonlOutput", () => {
  test("extracts reply and usage from a single turn_end", () => {
    const stdout = [
      '{"type":"session","version":3}',
      '{"type":"turn_end","message":{"role":"assistant","content":[{"type":"text","text":"Hello"}],"usage":{"input":380,"output":2,"cacheRead":0,"cacheWrite":0,"totalTokens":382,"cost":{"input":0.0002,"output":0.000002,"cacheRead":0,"cacheWrite":0,"total":0.000226}},"provider":"groq","model":"llama-3.3-70b-versatile"}}',
    ].join("\n");

    const { reply, usage } = parsePiPrintJsonlOutput(stdout);
    expect(reply).toBe("Hello");
    expect(usage?.inputTokens).toBe(380);
    expect(usage?.outputTokens).toBe(2);
    expect(usage?.totalTokens).toBe(382);
    expect(usage?.cost).toBeCloseTo(0.000226, 6);
    expect(usage?.provider).toBe("groq");
    expect(usage?.model).toBe("llama-3.3-70b-versatile");
  });

  test("sums usage across multiple turn_end events", () => {
    const stdout = [
      '{"type":"turn_end","message":{"role":"assistant","content":[{"type":"text","text":"Step 1"}],"usage":{"input":100,"output":10,"cost":{"total":0.001}}}}',
      '{"type":"turn_end","message":{"role":"assistant","content":[{"type":"text","text":"Step 2 done"}],"usage":{"input":50,"output":5,"cost":{"total":0.002}}}}',
    ].join("\n");

    const { reply, usage } = parsePiPrintJsonlOutput(stdout);
    expect(reply).toBe("Step 2 done");
    expect(usage?.inputTokens).toBe(150);
    expect(usage?.outputTokens).toBe(15);
    expect(usage?.totalTokens).toBe(165);
    expect(usage?.cost).toBeCloseTo(0.003, 6);
  });

  test("falls back to plain stdout when no structured turns", () => {
    const stdout = "Plain answer from legacy --print\n";
    const { reply, usage } = parsePiPrintJsonlOutput(stdout);
    expect(reply).toBe("Plain answer from legacy --print");
    expect(usage).toBeUndefined();
  });

  test("ignores non-JSON lines and still parses turn_end", () => {
    const stdout = [
      "not json",
      '{"type":"turn_end","message":{"role":"assistant","content":[{"type":"text","text":"OK"}],"usage":{"input":1,"output":1,"cost":{"total":0}}}}',
    ].join("\n");

    const { reply, usage } = parsePiPrintJsonlOutput(stdout);
    expect(reply).toBe("OK");
    expect(usage?.inputTokens).toBe(1);
    expect(usage?.outputTokens).toBe(1);
  });

  test("extracts usage from message_end when turn_end has no usage (pi-agent-core)", () => {
    const stdout = [
      '{"type":"session","version":3}',
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Hi"}],"usage":{"input":120,"output":30},"model":"m","provider":"p"}}',
      '{"type":"turn_end","message":{"role":"assistant","content":[{"type":"text","text":"Hi"}]}}',
    ].join("\n");

    const { reply, usage } = parsePiPrintJsonlOutput(stdout);
    expect(reply).toBe("Hi");
    expect(usage?.inputTokens).toBe(120);
    expect(usage?.outputTokens).toBe(30);
    expect(usage?.totalTokens).toBe(150);
  });

  test("prefers message_end usage when both carry usage to avoid double count", () => {
    const stdout = [
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Once"}],"usage":{"input":10,"output":5}}}',
      '{"type":"turn_end","message":{"role":"assistant","content":[{"type":"text","text":"Once"}],"usage":{"input":10,"output":5}}}',
    ].join("\n");

    const { usage } = parsePiPrintJsonlOutput(stdout);
    expect(usage?.inputTokens).toBe(10);
    expect(usage?.outputTokens).toBe(5);
  });

  test("accepts total_tokens only when input/output absent", () => {
    const stdout = [
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"x"}],"usage":{"total_tokens":999}}}',
    ].join("\n");

    const { usage } = parsePiPrintJsonlOutput(stdout);
    expect(usage?.totalTokens).toBe(999);
    expect(usage?.inputTokens).toBe(0);
    expect(usage?.outputTokens).toBe(0);
  });

  test("assistant model error (e.g. 429) yields piFailureMessage, not raw JSONL as reply", () => {
    const nestedErr =
      '{"error":{"code":429,"message":"Quota exceeded free_tier","status":"RESOURCE_EXHAUSTED"}}';
    const assistantEnd = {
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        api: "google-generative-ai",
        provider: "google",
        model: "gemini-2.5-flash",
        usage: { input: 0, output: 0, totalTokens: 0 },
        stopReason: "error",
        errorMessage: JSON.stringify({ error: { message: nestedErr } }),
      },
    };
    const stdout = [
      '{"type":"session","version":3,"id":"x","timestamp":"2026-03-16T15:14:13.258Z","cwd":"/spaces/my-space"}',
      '{"type":"message_start","message":{"role":"user","content":[]}}',
      JSON.stringify(assistantEnd),
    ].join("\n");

    const { reply, piFailureMessage } = parsePiPrintJsonlOutput(stdout);
    expect(reply).toBe("");
    expect(piFailureMessage).toBeDefined();
    expect(piFailureMessage).toContain("429");
    expect(piFailureMessage).not.toContain('"type":"session"');
    expect(piFailureMessage?.length).toBeLessThan(stdout.length);
  });

  test("strips bash+JSON tool leak from reply text", () => {
    const leaked = `bashuseeland{"command": "mrctl tts synthesize --text 'The US trading day opens at 9:30 AM Eastern Time.' --out outbox/trading_open.mp3"}`;
    const stdout = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: leaked }],
        usage: { input: 1, output: 1 },
      },
    });

    const { reply } = parsePiPrintJsonlOutput(stdout);
    expect(reply).toBe("Done.");
  });

  test("sanitizeLeakedToolCallText keeps normal answers unchanged", () => {
    expect(sanitizeLeakedToolCallText("Hello world.")).toBe("Hello world.");
  });

  test("sanitizeLeakedToolCallText strips bash prefix + JSON blob entirely", () => {
    expect(
      sanitizeLeakedToolCallText('bashuseeland{"command": "ls -la"}'),
    ).toBe("");
    expect(sanitizeLeakedToolCallText('sh{"command": "echo hi"}')).toBe("");
  });

  test("sanitizeLeakedToolCallText preserves real text before JSON blob", () => {
    expect(
      sanitizeLeakedToolCallText(
        'Here is your answer.{"command": "mrctl tts synthesize --text \'hi\' --out outbox/x.mp3"}',
      ),
    ).toBe("Here is your answer.");
  });

  test("structured JSONL without assistant text and without error uses Done, not full stdout", () => {
    const stdout = [
      '{"type":"session","version":3}',
      '{"type":"agent_start"}',
      "rubbish-not-json",
    ].join("\n");

    const { reply, piFailureMessage } = parsePiPrintJsonlOutput(stdout);
    expect(reply).toBe("Done.");
    expect(piFailureMessage).toBeUndefined();
  });
});

import { describe, expect, test } from "bun:test";
import { classifyPiFailure } from "../src/agent/pi-failure-class.js";

describe("classifyPiFailure", () => {
  test("failFast on auth", () => {
    expect(classifyPiFailure("Error 401 unauthorized")).toBe("failFast");
    expect(classifyPiFailure("invalid api key")).toBe("failFast");
  });

  test("failFast on removed cursor provider", () => {
    expect(
      classifyPiFailure(
        'provider "cursor" is no longer supported. Use anthropic.',
      ),
    ).toBe("failFast");
  });

  test("fallbackable on context limits", () => {
    expect(classifyPiFailure("maximum context length exceeded")).toBe(
      "fallbackable",
    );
    expect(classifyPiFailure("token limit reached")).toBe("fallbackable");
  });

  test("fallbackable on tool / function-calling unsupported", () => {
    expect(classifyPiFailure("This model does not support tools")).toBe(
      "fallbackable",
    );
    expect(
      classifyPiFailure("function calling not available for this endpoint"),
    ).toBe("fallbackable");
  });

  test("fallbackable on rate limits", () => {
    expect(classifyPiFailure("429 rate limit exceeded")).toBe("fallbackable");
    expect(classifyPiFailure("Rate limit exceeded")).toBe("fallbackable");
    expect(classifyPiFailure('{"type":"rate_limited"}')).toBe("fallbackable");
  });

  test("fallbackable on unmapped / malformed stop reasons", () => {
    // pi-ai's exhaustive mapStopReason switch throws this for finish reasons it
    // can't map (e.g. Gemini MALFORMED_RESPONSE, absent from the bundled enum).
    expect(classifyPiFailure("Unhandled stop reason: MALFORMED_RESPONSE")).toBe(
      "fallbackable",
    );
    expect(
      classifyPiFailure("Unhandled stop reason: MALFORMED_FUNCTION_CALL"),
    ).toBe("fallbackable");
    expect(classifyPiFailure("Unhandled stop reason: SOME_NEW_REASON")).toBe(
      "fallbackable",
    );
    // Raw enum token surfaced directly (no "Unhandled stop reason:" prefix).
    expect(classifyPiFailure("finishReason: MALFORMED_FUNCTION_CALL")).toBe(
      "fallbackable",
    );
  });

  test("malformed enum match does not trip on unrelated prose", () => {
    // Lowercase prose is not the uppercase Gemini enum token — stays the default.
    expect(
      classifyPiFailure("the user sent a malformed response payload"),
    ).toBe("retryable");
  });

  test("retryable on transient signals", () => {
    expect(classifyPiFailure("503 service unavailable")).toBe("retryable");
    expect(classifyPiFailure("ETIMEDOUT")).toBe("retryable");
    expect(classifyPiFailure("bad gateway")).toBe("retryable");
  });
});

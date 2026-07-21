import { describe, expect, test } from "bun:test";
import {
  classifyUserError,
  friendlyErrorMessage,
} from "../src/agent/user-error-messages.js";

describe("classifyUserError", () => {
  test("auth errors", () => {
    expect(classifyUserError("Error 401 unauthorized")).toBe("auth");
    expect(classifyUserError("invalid api key")).toBe("auth");
    expect(classifyUserError("403 Forbidden: access denied")).toBe("auth");
    expect(classifyUserError("authentication failed")).toBe("auth");
    expect(
      classifyUserError(
        "Container failed (exit code 1): Error: pi CLI failed (1): No API key found for anthropic.",
      ),
    ).toBe("auth");
  });

  test("key-limit errors", () => {
    expect(classifyUserError("quota exceeded for this key")).toBe("key-limit");
    expect(classifyUserError("billing hard limit reached")).toBe("key-limit");
    expect(classifyUserError("usage limit exceeded")).toBe("key-limit");
  });

  test("credits errors", () => {
    expect(classifyUserError("402 insufficient credits")).toBe("credits");
    expect(classifyUserError("not enough credits remaining")).toBe("credits");
    expect(classifyUserError("purchase more credits")).toBe("credits");
  });

  test("rate-limit errors", () => {
    expect(classifyUserError("429 Too Many Requests")).toBe("rate-limit");
    expect(classifyUserError("rate limit exceeded")).toBe("rate-limit");
    expect(classifyUserError("rate_limit_error")).toBe("rate-limit");
  });

  test("server errors", () => {
    expect(classifyUserError("502 Bad Gateway")).toBe("server-error");
    expect(classifyUserError("503 service unavailable")).toBe("server-error");
    expect(classifyUserError("ETIMEDOUT")).toBe("server-error");
    expect(classifyUserError("gateway timeout")).toBe("server-error");
  });

  test("generic fallback for unknown errors", () => {
    expect(classifyUserError("something totally unknown went wrong")).toBe(
      "generic",
    );
    expect(classifyUserError("")).toBe("generic");
  });

  test("priority: auth wins over rate-limit when both match", () => {
    expect(classifyUserError("401 rate limit")).toBe("auth");
  });
});

describe("friendlyErrorMessage", () => {
  test("platform messages never mention API key or provider", () => {
    const categories = [
      "auth",
      "key-limit",
      "credits",
      "rate-limit",
      "server-error",
      "generic",
    ] as const;
    for (const cat of categories) {
      const msg = friendlyErrorMessage(cat, "platform");
      expect(msg).not.toContain("API key");
      expect(msg).not.toContain("provider");
    }
  });

  test("byok messages are actionable for key issues", () => {
    expect(friendlyErrorMessage("auth", "byok")).toContain("API key");
    expect(friendlyErrorMessage("key-limit", "byok")).toContain("API key");
    expect(friendlyErrorMessage("credits", "byok")).toContain("credits");
  });

  test("server-error is identical for both modes", () => {
    expect(friendlyErrorMessage("server-error", "platform")).toBe(
      friendlyErrorMessage("server-error", "byok"),
    );
  });

  test("every category returns a non-empty string for both modes", () => {
    const categories = [
      "auth",
      "key-limit",
      "credits",
      "rate-limit",
      "server-error",
      "generic",
    ] as const;
    for (const cat of categories) {
      expect(friendlyErrorMessage(cat, "platform").length).toBeGreaterThan(0);
      expect(friendlyErrorMessage(cat, "byok").length).toBeGreaterThan(0);
    }
  });

  test("key-limit + platform + consoleUrl appends upgrade link", () => {
    const msg = friendlyErrorMessage(
      "key-limit",
      "platform",
      "https://console.example.com",
    );
    expect(msg).toContain("/dashboard/billing");
    expect(msg).toContain("https://console.example.com/dashboard/billing");
  });

  test("credits + platform + consoleUrl appends upgrade link", () => {
    const msg = friendlyErrorMessage(
      "credits",
      "platform",
      "https://console.example.com",
    );
    expect(msg).toContain("/dashboard/billing");
  });

  test("key-limit + platform + no consoleUrl has no upgrade link", () => {
    const msg = friendlyErrorMessage("key-limit", "platform");
    expect(msg).not.toContain("/dashboard/billing");
  });

  test("key-limit + byok + consoleUrl has no upgrade link", () => {
    const msg = friendlyErrorMessage(
      "key-limit",
      "byok",
      "https://console.example.com",
    );
    expect(msg).not.toContain("/dashboard/billing");
  });

  test("rate-limit + platform + consoleUrl has no upgrade link", () => {
    const msg = friendlyErrorMessage(
      "rate-limit",
      "platform",
      "https://console.example.com",
    );
    expect(msg).not.toContain("/dashboard/billing");
  });

  test("consoleUrl trailing slash is stripped to avoid double slash", () => {
    const msg = friendlyErrorMessage(
      "key-limit",
      "platform",
      "https://console.example.com/",
    );
    expect(msg).toContain("https://console.example.com/dashboard/billing");
    expect(msg).not.toContain("//dashboard");
  });
});

export type UserErrorCategory =
  | "auth"
  | "key-limit"
  | "credits"
  | "rate-limit"
  | "server-error"
  | "generic";

const AUTH_RE =
  /\b401\b|\b403\b|invalid\s+api\s+key|incorrect\s+api\s+key|authentication\s+failed|invalid\s+authentication|unauthorized|access\s+denied/i;

const KEY_LIMIT_RE = /quota|billing|usage\s+limit|spending\s+limit/i;

const CREDITS_RE =
  /\b402\b|insufficient\s+credits?|not\s+enough\s+credits?|purchase\s+(more\s+)?credits?|no\s+credits?/i;

const RATE_LIMIT_RE = /\b429\b|rate[_\s]+limit/i;

const SERVER_ERROR_RE =
  /\b502\b|\b503\b|\b504\b|timeout|timed\s+out|ETIMEDOUT|ECONNRESET|temporarily\s+unavailable|overload|service\s+unavailable|bad\s+gateway|gateway\s+timeout/i;

export function classifyUserError(errorText: string): UserErrorCategory {
  if (AUTH_RE.test(errorText)) return "auth";
  if (KEY_LIMIT_RE.test(errorText)) return "key-limit";
  if (CREDITS_RE.test(errorText)) return "credits";
  if (RATE_LIMIT_RE.test(errorText)) return "rate-limit";
  if (SERVER_ERROR_RE.test(errorText)) return "server-error";
  return "generic";
}

const MESSAGES: Record<UserErrorCategory, { platform: string; byok: string }> =
  {
    "key-limit": {
      platform: "I've reached my usage limit for now. Please try again later.",
      byok: "Your API key has hit its spending limit. Check your provider's key settings to increase it.",
    },
    "rate-limit": {
      platform:
        "I'm handling too many requests right now — please try again in a moment.",
      byok: "Your API key is being rate-limited. Try again in a moment.",
    },
    auth: {
      platform:
        "Something went wrong on my end. This has been logged and the admin will be notified.",
      byok: "Your API key appears to be invalid or expired. Please update it.",
    },
    credits: {
      platform: "I've reached my usage limit for now. Please try again later.",
      byok: "Your API provider account has insufficient credits. Add credits to continue.",
    },
    "server-error": {
      platform:
        "The AI service is temporarily unavailable. Please try again in a few minutes.",
      byok: "The AI service is temporarily unavailable. Please try again in a few minutes.",
    },
    generic: {
      platform:
        "Something went wrong processing your request. Please try again.",
      byok: "Something went wrong processing your request. Please try again, or check your API key and provider status.",
    },
  };

export function friendlyErrorMessage(
  category: UserErrorCategory,
  mode: "platform" | "byok",
  consoleUrl?: string,
): string {
  let message = MESSAGES[category][mode];
  const base = consoleUrl?.replace(/\/+$/, "");
  if (base && mode === "platform") {
    if (category === "key-limit" || category === "credits") {
      message += `\n\nUpgrade your plan: ${base}/dashboard/billing`;
    } else if (category === "auth") {
      return `Your Anthropic session has expired. Please reconnect: ${base}/dashboard/model`;
    }
  }
  return message;
}

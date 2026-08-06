import {
  formatSystemMessage,
  type MessageLocale,
} from "../core/system-messages.js";

export type UserErrorCategory =
  | "auth"
  | "key-limit"
  | "credits"
  | "rate-limit"
  | "server-error"
  | "generic";

const AUTH_RE =
  /\b401\b|\b403\b|invalid\s+api\s+key|incorrect\s+api\s+key|no\s+api\s+key\s+found|authentication\s+failed|invalid\s+authentication|unauthorized|access\s+denied/i;

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

export function friendlyErrorMessage(
  category: UserErrorCategory,
  mode: "platform" | "byok",
  consoleUrl?: string,
  locale: MessageLocale = "en",
): string {
  let message = formatSystemMessage(locale, `err_${category}_${mode}`);
  const base = consoleUrl?.replace(/\/+$/, "");
  if (base && mode === "platform") {
    if (category === "key-limit" || category === "credits") {
      message += `\n\n${formatSystemMessage(locale, "err_upgrade_suffix", { url: base })}`;
    } else if (category === "auth") {
      return formatSystemMessage(locale, "err_session_expired", { url: base });
    }
  }
  return message;
}

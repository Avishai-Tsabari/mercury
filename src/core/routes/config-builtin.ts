/** Built-in space config keys (trigger + ambient). */

export const BUILTIN_CONFIG_KEYS = new Set([
  "trigger.match",
  "trigger.patterns",
  "trigger.case_sensitive",
  "trigger.media_in_groups",
  "ambient.enabled",
  "context.mode",
  "context.window_size",
  "context.reply_chain_depth",
  "security.sensitive_connections_allowed",
]);

/**
 * One-line plain-English descriptions for each builtin config key, surfaced as
 * native browser tooltips on the agent dashboard space-settings rows. The key
 * set MUST match BUILTIN_CONFIG_KEYS exactly — enforced by
 * tests/builtin-config-descriptions.test.ts.
 */
export const BUILTIN_CONFIG_DESCRIPTIONS: Record<string, string> = {
  "trigger.match":
    "How a message triggers the agent: 'mention' (name appears as a word), 'prefix' (message starts with the name), or 'always' (every message).",
  "trigger.patterns":
    "Comma-separated list of names/aliases the agent responds to (e.g. '@Mercury, Mercury').",
  "trigger.case_sensitive":
    "When true, trigger pattern matching is case-sensitive. When false, case is ignored.",
  "trigger.media_in_groups":
    "When true, media-only messages (image/audio with no text) trigger the agent in group chats.",
  "ambient.enabled":
    "When true, non-triggered group messages are still stored as ambient context. Set false for strict tag-only mode.",
  "context.mode":
    "'clear' = each message starts fresh (reply to bot for chain context). 'context' = include a sliding window of recent turns automatically.",
  "context.window_size":
    "Number of recent turns included as context when context.mode=context. Integer 1-50.",
  "context.reply_chain_depth":
    "Max number of turns walked back when following a reply chain. Integer 1-50.",
  "security.sensitive_connections_allowed":
    "When true, sensitive integrations (e.g. payments, identity) are usable in this group space. False blocks them by default.",
};

const BUILTIN_VALIDATORS: Record<string, (v: string) => string | null> = {
  "trigger.match": (v) =>
    ["prefix", "mention", "always"].includes(v)
      ? null
      : "Invalid trigger.match value. Valid: prefix, mention, always",
  "trigger.case_sensitive": (v) =>
    ["true", "false"].includes(v)
      ? null
      : "Invalid trigger.case_sensitive value. Valid: true, false",
  "trigger.media_in_groups": (v) =>
    ["true", "false"].includes(v)
      ? null
      : "Invalid trigger.media_in_groups value. Valid: true, false",
  "ambient.enabled": (v) =>
    ["true", "false"].includes(v)
      ? null
      : "Invalid ambient.enabled value. Valid: true, false",
  "context.mode": (v) =>
    ["clear", "context"].includes(v)
      ? null
      : "Invalid context.mode value. Valid: clear, context",
  "context.window_size": (v) => {
    const n = Number.parseInt(v, 10);
    return Number.isInteger(n) && n >= 1 && n <= 50
      ? null
      : "Invalid context.window_size value. Must be an integer between 1 and 50";
  },
  "context.reply_chain_depth": (v) => {
    const n = Number.parseInt(v, 10);
    return Number.isInteger(n) && n >= 1 && n <= 50
      ? null
      : "Invalid context.reply_chain_depth value. Must be an integer between 1 and 50";
  },
  "security.sensitive_connections_allowed": (v) =>
    ["true", "false"].includes(v)
      ? null
      : "Invalid security.sensitive_connections_allowed value. Valid: true, false",
};

export function isBuiltinConfigKey(key: string): boolean {
  return BUILTIN_CONFIG_KEYS.has(key);
}

/**
 * Validate a built-in space config key/value. Returns an error message or null if valid.
 * Call only when the key is known to be built-in, or use {@link validateDashboardBuiltinConfig}.
 */
export function validateBuiltinConfigValue(
  key: string,
  value: string,
): string | null {
  const validator = BUILTIN_VALIDATORS[key];
  if (validator) return validator(value);
  return null;
}

/** For dashboard-only updates: key must be built-in. */
export function validateDashboardBuiltinConfig(
  key: string,
  value: string,
): string | null {
  if (!isBuiltinConfigKey(key)) {
    return "Invalid config key for dashboard";
  }
  return validateBuiltinConfigValue(key, value);
}

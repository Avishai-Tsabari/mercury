/**
 * Locale-keyed string table for host-generated system messages.
 *
 * These messages (rate-limit denials, container failures, permission denials,
 * the sensitive-connection guard, provider-error messages) are produced
 * deterministically on the host before any LLM runs, so system-prompt language
 * instructions never touch them. This table lets a deployment or a single
 * space switch them to another locale via the `messages.locale` config key.
 *
 * Resolution chain: per-space → `@global` → `config.messagesLocale` → `"en"`.
 * The `en` strings are byte-identical to the original literals — tests and
 * downstream matching depend on them.
 */

import type { AppConfig } from "../config.js";
import { GLOBAL_CONFIG_SPACE_ID } from "../extensions/config-registry.js";
import type { Db } from "../storage/db.js";

export type MessageLocale = "en" | "he";

export const MESSAGE_LOCALES: readonly MessageLocale[] = ["en", "he"];

export type SystemMessageKey =
  | "rate_limit_burst"
  | "rate_limit_daily"
  | "attachment_failed"
  | "run_stopped"
  | "container_timeout"
  | "container_oom"
  | "no_permission_prompt"
  | "no_permission_slash"
  | "slash_admin_only"
  | "no_permission_command"
  | "sensitive_disabled"
  | "sensitive_confirm"
  | "sensitive_cancelled"
  | "platform_quota_exceeded"
  // Provider-error messages (user-error-messages.ts), keyed category × mode
  | "err_key-limit_platform"
  | "err_key-limit_byok"
  | "err_rate-limit_platform"
  | "err_rate-limit_byok"
  | "err_auth_platform"
  | "err_auth_byok"
  | "err_credits_platform"
  | "err_credits_byok"
  | "err_server-error_platform"
  | "err_server-error_byok"
  | "err_generic_platform"
  | "err_generic_byok"
  | "err_upgrade_suffix"
  | "err_session_expired";

export const SYSTEM_MESSAGES: Record<
  MessageLocale,
  Record<SystemMessageKey, string>
> = {
  en: {
    rate_limit_burst: "Rate limit exceeded. Try again shortly.",
    rate_limit_daily:
      "You've used {count}/{limit} messages today. Resets in {hours}h.",
    attachment_failed:
      "Could not use your attachment (media disabled, over the size limit, or download failed). Check MERCURY_MEDIA_ENABLED and logs.",
    run_stopped: "Stopped current run.",
    container_timeout: "Container timed out.",
    container_oom: "Container was killed (possibly out of memory).",
    no_permission_prompt:
      "You don't have permission to use the agent in this group.",
    no_permission_slash: "You don't have permission to use '/{command}'.",
    slash_admin_only: "Slash commands are only available to admins in groups.",
    no_permission_command: "You don't have permission to use '{command}'.",
    sensitive_disabled:
      "⛔ Sensitive integrations ({name}) are disabled for this group space. A space admin must enable them first with: mrctl config set security.sensitive_connections_allowed true",
    sensitive_confirm:
      "⚠️ This response may contain data from {name} and will be visible to all members of this group. Reply *yes* to proceed or *no* to cancel.",
    sensitive_cancelled: "Cancelled.",
    platform_quota_exceeded:
      "You've reached your daily message limit. Upgrade your plan at the Mercury Console to continue chatting.",
    "err_key-limit_platform":
      "I've reached my usage limit for now. Please try again later.",
    "err_key-limit_byok":
      "Your API key has hit its spending limit. Check your provider's key settings to increase it.",
    "err_rate-limit_platform":
      "I'm handling too many requests right now — please try again in a moment.",
    "err_rate-limit_byok":
      "Your API key is being rate-limited. Try again in a moment.",
    err_auth_platform:
      "Something went wrong on my end. This has been logged and the admin will be notified.",
    err_auth_byok:
      "Your API key appears to be invalid or expired. Please update it.",
    err_credits_platform:
      "I've reached my usage limit for now. Please try again later.",
    err_credits_byok:
      "Your API provider account has insufficient credits. Add credits to continue.",
    "err_server-error_platform":
      "The AI service is temporarily unavailable. Please try again in a few minutes.",
    "err_server-error_byok":
      "The AI service is temporarily unavailable. Please try again in a few minutes.",
    err_generic_platform:
      "Something went wrong processing your request. Please try again.",
    err_generic_byok:
      "Something went wrong processing your request. Please try again, or check your API key and provider status.",
    err_upgrade_suffix: "Upgrade your plan: {url}/dashboard/billing",
    err_session_expired:
      "Your Anthropic session has expired. Please reconnect: {url}/dashboard/model",
  },
  he: {
    rate_limit_burst: "חריגה ממגבלת הקצב. נסו שוב בעוד רגע.",
    rate_limit_daily:
      "נוצלו {count}/{limit} הודעות היום. המכסה מתאפסת בעוד {hours} שעות.",
    attachment_failed:
      "לא ניתן היה להשתמש בקובץ המצורף (מדיה מושבתת, חריגה ממגבלת הגודל, או שההורדה נכשלה). בדקו את MERCURY_MEDIA_ENABLED ואת הלוגים.",
    run_stopped: "הריצה הנוכחית הופסקה.",
    container_timeout: "זמן הריצה של הקונטיינר פג.",
    container_oom: "הקונטיינר הופסק (ייתכן שבשל מחסור בזיכרון).",
    no_permission_prompt: "אין לכם הרשאה להשתמש בסוכן בקבוצה זו.",
    no_permission_slash: "אין לכם הרשאה להשתמש ב-'/{command}'.",
    slash_admin_only: "פקודות סלאש זמינות רק למנהלים בקבוצות.",
    no_permission_command: "אין לכם הרשאה להשתמש ב-'{command}'.",
    sensitive_disabled:
      "⛔ אינטגרציות רגישות ({name}) מושבתות במרחב הקבוצתי הזה. מנהל המרחב צריך להפעיל אותן תחילה באמצעות: mrctl config set security.sensitive_connections_allowed true",
    sensitive_confirm:
      "⚠️ התשובה עשויה להכיל מידע מ-{name} ותהיה גלויה לכל חברי הקבוצה. השיבו *כן* כדי להמשיך או *לא* כדי לבטל.",
    sensitive_cancelled: "בוטל.",
    platform_quota_exceeded:
      "הגעתם למגבלת ההודעות היומית. שדרגו את התוכנית ב-Mercury Console כדי להמשיך בשיחה.",
    "err_key-limit_platform":
      "הגעתי למגבלת השימוש שלי לעת עתה. נסו שוב מאוחר יותר.",
    "err_key-limit_byok":
      "מפתח ה-API שלכם הגיע למגבלת ההוצאה שלו. בדקו את הגדרות המפתח אצל הספק כדי להגדיל אותה.",
    "err_rate-limit_platform":
      "אני מטפל בבקשות רבות מדי כרגע — נסו שוב בעוד רגע.",
    "err_rate-limit_byok": "מפתח ה-API שלכם מוגבל בקצב. נסו שוב בעוד רגע.",
    err_auth_platform: "משהו השתבש אצלי. האירוע נרשם והמנהל יקבל התראה.",
    err_auth_byok: "נראה שמפתח ה-API שלכם אינו תקין או שפג תוקפו. עדכנו אותו.",
    err_credits_platform:
      "הגעתי למגבלת השימוש שלי לעת עתה. נסו שוב מאוחר יותר.",
    err_credits_byok:
      "בחשבון ספק ה-API שלכם אין מספיק קרדיטים. הוסיפו קרדיטים כדי להמשיך.",
    "err_server-error_platform":
      "שירות ה-AI אינו זמין זמנית. נסו שוב בעוד כמה דקות.",
    "err_server-error_byok":
      "שירות ה-AI אינו זמין זמנית. נסו שוב בעוד כמה דקות.",
    err_generic_platform: "משהו השתבש בעיבוד הבקשה. נסו שוב.",
    err_generic_byok:
      "משהו השתבש בעיבוד הבקשה. נסו שוב, או בדקו את מפתח ה-API ואת סטטוס הספק.",
    err_upgrade_suffix: "שדרגו את התוכנית: {url}/dashboard/billing",
    err_session_expired:
      "החיבור ל-Anthropic פג תוקף. התחברו מחדש: {url}/dashboard/model",
  },
};

/**
 * Words accepted as confirmation replies by the sensitive-connection guard,
 * per locale. English `yes`/`no` are ALWAYS accepted, in every locale —
 * switching a space's locale must never break an in-flight or muscle-memory
 * English confirmation. Matching is done against a lowercased, trimmed reply.
 * Record-typed so adding a locale without confirm words is a compile error.
 */
const CONFIRM_WORDS: Record<MessageLocale, { yes: string[]; no: string[] }> = {
  en: { yes: ["yes"], no: ["no"] },
  he: { yes: ["yes", "כן"], no: ["no", "לא"] },
};

export function confirmWords(locale: MessageLocale): {
  yes: string[];
  no: string[];
} {
  return CONFIRM_WORDS[isMessageLocale(locale) ? locale : "en"];
}

function isMessageLocale(v: unknown): v is MessageLocale {
  return v === "en" || v === "he";
}

/**
 * Format a system message for a locale, substituting `{name}` placeholders.
 * Unknown locale falls back to `en`; unknown key falls back to the `en` table,
 * then to the key itself (never throws).
 */
export function formatSystemMessage(
  locale: MessageLocale,
  key: SystemMessageKey,
  params?: Record<string, string | number>,
): string {
  const table = SYSTEM_MESSAGES[isMessageLocale(locale) ? locale : "en"];
  const template =
    (table as Record<string, string>)[key] ??
    (SYSTEM_MESSAGES.en as Record<string, string>)[key] ??
    key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}

/**
 * Resolve the effective message locale for a space:
 * per-space → `@global` → `config.messagesLocale` → `"en"`.
 *
 * Never throws and never returns an unknown locale — any invalid stored value
 * (e.g. DB edited out-of-band) is treated as unset and degrades to the next
 * link in the chain. Pass `spaceId: null` when no space context exists (very
 * early ingress failures); the per-space link is skipped.
 */
export function resolveLocale(
  db: Db,
  config: Pick<AppConfig, "messagesLocale">,
  spaceId: string | null,
): MessageLocale {
  try {
    if (spaceId) {
      const spaceValue = db.getSpaceConfig(spaceId, "messages.locale");
      if (isMessageLocale(spaceValue)) return spaceValue;
    }
    const globalValue = db.getSpaceConfig(
      GLOBAL_CONFIG_SPACE_ID,
      "messages.locale",
    );
    if (isMessageLocale(globalValue)) return globalValue;
  } catch {
    // DB unavailable — fall through to config/default
  }
  if (isMessageLocale(config.messagesLocale)) return config.messagesLocale;
  return "en";
}

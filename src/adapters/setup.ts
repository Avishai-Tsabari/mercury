import { createSlackAdapter } from "@chat-adapter/slack";
import { createTeamsAdapter } from "@chat-adapter/teams";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import type { Adapter } from "chat";
import type { AppConfig } from "../config.js";
import { resolveProjectPath } from "../config.js";
import { createDiscordNativeAdapter } from "./discord-native.js";
import { createWhatsAppBaileysAdapter } from "./whatsapp.js";

export function setupAdapters(config: AppConfig): Record<string, Adapter> {
  const adapters: Record<string, Adapter> = {};

  if (config.enableSlack) {
    if (!process.env.MERCURY_SLACK_BOT_TOKEN) {
      throw new Error(
        "MERCURY_ENABLE_SLACK=true but MERCURY_SLACK_BOT_TOKEN is not set",
      );
    }
    if (!process.env.MERCURY_SLACK_SIGNING_SECRET) {
      throw new Error(
        "MERCURY_ENABLE_SLACK=true but MERCURY_SLACK_SIGNING_SECRET is not set",
      );
    }
    adapters.slack = createSlackAdapter({
      botToken: process.env.MERCURY_SLACK_BOT_TOKEN,
      signingSecret: process.env.MERCURY_SLACK_SIGNING_SECRET,
    });
  }

  if (config.enableTeams) {
    const appId = process.env.MERCURY_TEAMS_APP_ID;
    const appPassword = process.env.MERCURY_TEAMS_APP_PASSWORD;
    if (!appId) {
      throw new Error(
        "MERCURY_ENABLE_TEAMS=true but MERCURY_TEAMS_APP_ID is not set",
      );
    }
    if (!appPassword) {
      throw new Error(
        "MERCURY_ENABLE_TEAMS=true but MERCURY_TEAMS_APP_PASSWORD is not set",
      );
    }
    adapters.teams = createTeamsAdapter({
      appId,
      appPassword,
      appType:
        (process.env.MERCURY_TEAMS_APP_TYPE as
          | "SingleTenant"
          | "MultiTenant"
          | undefined) ?? "SingleTenant",
      appTenantId: process.env.MERCURY_TEAMS_APP_TENANT_ID,
      userName: config.botUsername,
    });
  }

  if (config.enableDiscord) {
    if (!process.env.MERCURY_DISCORD_BOT_TOKEN) {
      throw new Error(
        "MERCURY_ENABLE_DISCORD=true but MERCURY_DISCORD_BOT_TOKEN is not set",
      );
    }
    adapters.discord = createDiscordNativeAdapter({
      userName: config.botUsername,
    });
  }

  if (config.enableWhatsApp) {
    adapters.whatsapp = createWhatsAppBaileysAdapter({
      userName: config.botUsername,
      authDir: resolveProjectPath(config.whatsappAuthDir),
    });
  }

  if (config.enableTelegram) {
    if (!process.env.MERCURY_TELEGRAM_BOT_TOKEN) {
      throw new Error(
        "MERCURY_ENABLE_TELEGRAM=true but MERCURY_TELEGRAM_BOT_TOKEN is not set",
      );
    }
    adapters.telegram = createTelegramAdapter({
      botToken: process.env.MERCURY_TELEGRAM_BOT_TOKEN,
      userName: config.botUsername,
      mode: "auto",
      secretToken: process.env.MERCURY_TELEGRAM_WEBHOOK_SECRET_TOKEN,
    });
  }

  return adapters;
}

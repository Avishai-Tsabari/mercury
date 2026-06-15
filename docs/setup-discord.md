# Discord Setup Guide

Connect Mercury to Discord using a bot application with gateway (WebSocket) connection.

## Prerequisites

- A Discord account
- A Discord server where you have **Manage Server** permission
- Mercury initialized (`mercury init`)

## Step 1: Create a Discord Application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **New Application** → name it (e.g., "Mercury")
3. Go to the **Bot** tab
4. Click **Reset Token** → copy the bot token

## Step 2: Configure Bot Settings

In the **Bot** tab:

- **Privileged Gateway Intents** — enable all three:
  - ✅ Presence Intent
  - ✅ Server Members Intent
  - ✅ Message Content Intent

These are required for Mercury to read message content and user information.

## Step 3: Invite the Bot to Your Server

1. Go to the **OAuth2 → URL Generator** tab
2. Select scopes: `bot`
3. Select bot permissions:
   - Send Messages
   - Read Message History
   - Attach Files
   - Use Slash Commands
   - Add Reactions
4. Copy the generated URL and open it in your browser
5. Select your server and authorize

## Step 4: Configure Mercury

In your `.env` file:

```bash
MERCURY_ENABLE_DISCORD=true
MERCURY_DISCORD_BOT_TOKEN=your-bot-token-here
```

## Step 5: Find Your Discord User ID

To add yourself as admin, you need your Discord user ID:

1. Enable **Developer Mode** in Discord (Settings → Advanced → Developer Mode)
2. Right-click your username → **Copy User ID**
3. Add to `.env`:

```bash
MERCURY_ADMINS=discord:YOUR_USER_ID
```

## Step 6: Start Mercury

```bash
mercury service install
mercury service status
mercury service logs -f
```

## Step 7: Link conversations

Send a message to the bot (DM or mention in a channel), then:

```bash
mercury conversations --unlinked
mercury link <id> <space-name>
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MERCURY_ENABLE_DISCORD` | `false` | Enable Discord adapter |
| `MERCURY_DISCORD_BOT_TOKEN` | — | Bot token from Developer Portal |

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Bot is online but doesn't respond | Check Message Content Intent is enabled |
| "Missing Permissions" errors | Re-invite with correct permissions (step 3) |
| Bot doesn't appear online | Verify `MERCURY_DISCORD_BOT_TOKEN` is correct |
| Messages not arriving in logs | Ensure bot is in the channel and has Read Message History |

## Security

- Never commit your bot token to version control
- Regenerate the token immediately if it's ever exposed
- Use minimal permissions — only grant what Mercury needs

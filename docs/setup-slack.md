# Slack Setup Guide

Connect Mercury to Slack using the Events API with a bot token.

## Prerequisites

- A Slack workspace where you have admin access
- A publicly accessible URL for webhooks (or use a tunnel like ngrok)
- Mercury initialized (`mercury init`)

## Step 1: Create a Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Click **Create New App → From scratch**
3. Name it (e.g., "Mercury") and select your workspace

## Step 2: Configure Bot Scopes

Go to **OAuth & Permissions** → **Bot Token Scopes** and add:

- `chat:write` — Send messages
- `channels:history` — Read channel messages
- `groups:history` — Read private channel messages
- `im:history` — Read DMs
- `mpim:history` — Read group DMs
- `channels:read` — List channels
- `groups:read` — List private channels
- `im:read` — List DMs
- `users:read` — Read user info
- `files:read` — Access shared files
- `files:write` — Upload files

## Step 3: Install to Workspace

1. Go to **OAuth & Permissions**
2. Click **Install to Workspace** → authorize
3. Copy the **Bot User OAuth Token** (`xoxb-...`)

## Step 4: Get the Signing Secret

1. Go to **Basic Information**
2. Under **App Credentials**, copy the **Signing Secret**

## Step 5: Configure Mercury

In your `.env` file:

```bash
MERCURY_ENABLE_SLACK=true
MERCURY_SLACK_BOT_TOKEN=xoxb-your-bot-token
MERCURY_SLACK_SIGNING_SECRET=your-signing-secret
```

## Step 6: Set Up Event Subscriptions

Mercury needs to receive events from Slack via webhooks.

1. Start Mercury first (it needs to respond to Slack's verification challenge):
   ```bash
   mercury service install
   ```

2. In the Slack app settings, go to **Event Subscriptions**
3. Toggle **Enable Events** to on
4. Set the **Request URL** to: `https://your-domain.com/webhooks/slack/events`
5. Wait for Slack to verify the URL (Mercury handles this automatically)

6. Under **Subscribe to Bot Events**, add:
   - `message.channels`
   - `message.groups`
   - `message.im`
   - `message.mpim`

7. Click **Save Changes**

## Step 7: Find Your Slack User ID

To add yourself as admin:

1. In Slack, click your profile picture → **Profile**
2. Click **⋯** (more) → **Copy member ID**
3. Add to `.env`:

```bash
MERCURY_ADMINS=slack:U0123456789
```

## Step 8: Link conversations

Send a message to the bot (DM or mention in a channel), then:

```bash
mercury conversations --unlinked
mercury link <id> <space-name>
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MERCURY_ENABLE_SLACK` | `false` | Enable Slack adapter |
| `MERCURY_SLACK_BOT_TOKEN` | — | Bot User OAuth Token (`xoxb-...`) |
| `MERCURY_SLACK_SIGNING_SECRET` | — | Signing secret for request verification |

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Event URL verification fails | Ensure Mercury is running and reachable at the URL |
| Bot doesn't respond in channels | Invite the bot to the channel (`/invite @Mercury`) |
| "not_authed" errors | Check `MERCURY_SLACK_BOT_TOKEN` is correct |
| Missing messages | Verify all `message.*` events are subscribed |
| Can't receive events locally | Use ngrok: `ngrok http 8787` and use the HTTPS URL |

## Security

- Never commit tokens or signing secrets to version control
- The signing secret verifies that events come from Slack — keep it secret
- Rotate tokens if exposed: **OAuth & Permissions → Revoke Token**

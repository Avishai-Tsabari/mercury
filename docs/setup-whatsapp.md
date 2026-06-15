# WhatsApp Setup Guide

Connect Mercury to WhatsApp using the Baileys library (WhatsApp Web protocol).

## Prerequisites

- A phone number with WhatsApp installed
- Mercury initialized (`mercury init`)

## Step 1: Enable WhatsApp

In your `.env` file:

```bash
MERCURY_ENABLE_WHATSAPP=true
```

## Step 2: Authenticate

You **must** authenticate before starting Mercury.

### QR Code (recommended)

```bash
mercury auth whatsapp
```

1. Open WhatsApp on your phone
2. Go to **Settings → Linked Devices → Link a Device**
3. Scan the QR code displayed in your terminal

### Pairing Code (headless/remote servers)

```bash
mercury auth whatsapp --pairing-code --phone 14155551234
```

1. Open WhatsApp → **Settings → Linked Devices → Link a Device**
2. Tap **"Link with phone number instead"**
3. Enter the 8-character code shown in your terminal

After successful auth, your WhatsApp ID is printed — copy it into `MERCURY_ADMINS` in `.env`.

## Step 3: Start Mercury

```bash
mercury service install
mercury service status
mercury service logs -f
```

## Step 4: Link conversations

Send a message to the bot's WhatsApp number, then:

```bash
mercury conversations --unlinked
mercury link <id> <space-name>
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MERCURY_ENABLE_WHATSAPP` | `false` | Enable WhatsApp adapter |
| `MERCURY_WHATSAPP_AUTH_DIR` | `.mercury/whatsapp-auth` | Credentials directory |

## Session Lifecycle

WhatsApp linked device sessions last **~14–20 days** before requiring re-authentication. When expired:

```bash
mercury service uninstall
rm -rf .mercury/whatsapp-auth/
mercury auth whatsapp
mercury service install
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| QR code not showing | Run `mercury auth whatsapp` separately, not `mercury run` |
| "Already authenticated" but not working | Delete `.mercury/whatsapp-auth/` and re-auth |
| QR code expires too fast | Use `--pairing-code` mode instead |
| Messages not arriving | Check `MERCURY_ENABLE_WHATSAPP=true` and re-auth |
| Old messages appear on startup | Normal — Mercury ignores pre-connection messages |

## Security

- Credentials in `.mercury/whatsapp-auth/` are sensitive — treat like passwords
- Consider using a dedicated phone number for the bot

See also: [auth/whatsapp.md](auth/whatsapp.md) for detailed auth internals.

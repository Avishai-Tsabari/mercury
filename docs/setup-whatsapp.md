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

## Identity: LID vs Phone Number

WhatsApp non-deterministically identifies the same person by either their
phone-number JID (`972501234567@s.whatsapp.net`) or an anonymized LID
(`24417056866472@lid`). Mercury canonicalizes every inbound identity to the
phone form whenever the mapping is known, so a person always resolves to one
caller id, one conversation, and one DM auto-space.

How it works:

1. Baileys attaches the alternate form on many message keys; when it does,
   Mercury uses the phone form and records the LID↔phone pair in the
   `wa_identity_aliases` table (log line: `WhatsApp identity alias learned`).
2. When a message arrives LID-tagged without the alternate field, Mercury
   consults Baileys' internal mapping store, then its own alias table.
3. If no mapping is known anywhere, the LID is kept as-is. This self-heals:
   the moment a later message reveals the pair, the person's phone-keyed
   conversation **adopts** the space that was created under the LID — history,
   config, and settings are preserved, and per-user roles/mutes are rewritten
   to the canonical caller id (log line: `dm-auto-space: adopted existing
   space for canonical identity`). Existing `dm-<lid-digits>` space ids keep
   their name; only the identity resolution changes.

If a person somehow ended up with **two** spaces (one LID-keyed, one
phone-keyed) before canonicalization existed, the phone-keyed space wins and
a warning names both spaces (`same person has two spaces`) so you can merge
or delete the stale one manually.

A LID's digits are unrelated to the phone number — Mercury never guesses a
mapping; pairs only come from WhatsApp itself. For support cases you can
insert a pair manually into `wa_identity_aliases` with `source = 'manual'`.

## Security

- Credentials in `.mercury/whatsapp-auth/` are sensitive — treat like passwords
- Consider using a dedicated phone number for the bot

See also: [auth/whatsapp.md](auth/whatsapp.md) for detailed auth internals.

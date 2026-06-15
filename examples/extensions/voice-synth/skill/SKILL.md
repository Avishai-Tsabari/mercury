---
name: voice-synth
description: Cloud text-to-speech (Google or Azure) for English and Hebrew — on-demand via mrctl or optional auto voice attachments per space.
---

# Voice synthesis (TTS)

**`mrctl tts synthesize` is available in this environment.** When the user asks for a voice message, audio reply, or TTS, you MUST run the command below. Do not assume it is unavailable — always try it and report any error verbatim.

**Do not paste** `mrctl`, shell snippets, or JSON tool-call blobs into your **visible** reply — use the **bash tool** only for the command. The user sees normal text plus the audio attachment.

## How to send a voice message

```bash
mrctl tts synthesize --text "Your spoken reply here" --out outbox/reply.mp3
```

This writes an MP3 file to `outbox/` which Mercury automatically attaches to your reply. Do **not** create `.txt` files or use misleading names — chat apps decide how to render attachments from the file extension and MIME type.

Optional flags:

- `--language` — `auto` (default), `he-IL`, or `en-US`. `auto` picks Hebrew if the text contains Hebrew script.
- `--provider` — `google`, `azure`, or `auto` (host default).

Requires the caller to have **`tts.synthesize`** permission (admins have it by default).

### Telegram / WhatsApp delivery

**Telegram** uses `sendAudio` for MP3 (in-chat player) and `sendVoice` for OGG voice notes. **WhatsApp** treats audio as a voice note when the filename matches **`voice-*.ogg`** (case-insensitive); otherwise it sends as normal audio (`ptt: false`).

## Automatic mode (optional)

| Setting | Behavior |
|--------|----------|
| **`voice-synth.mode=on_demand`** (default) | TTS runs only when you call `mrctl tts synthesize`. |
| **`voice-synth.mode=auto`** | The host attaches a TTS MP3 to every assistant reply automatically. |

Set with `mrctl config set voice-synth.mode on_demand` or `auto`.

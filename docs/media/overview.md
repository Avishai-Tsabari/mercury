# Media Handling

Mercury downloads and processes media attachments from chat platforms, saving them to space workspaces and passing them to pi for processing. Models can also produce files via the `outbox/` directory.

## Supported Platforms

| Platform | Ingress | Egress | Details |
|----------|---------|--------|---------|
| WhatsApp | ✅ Baileys socket | ✅ image/video/audio/document | [whatsapp.md](./whatsapp.md) |
| Discord | ✅ CDN URL download | ✅ channel.send() with files | Via `DiscordBridge` |
| Slack | ✅ URL download (auth'd) | ✅ files.uploadV2 | Via `SlackBridge` |

## Architecture

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌─────────┐
│   Platform   │────▶│   Bridge     │────▶│   Runtime    │────▶│   pi    │
│              │     │ (normalize)  │     │ (store/pass) │     │ (view)  │
└──────────────┘     └──────────────┘     └──────────────┘     └─────────┘
                            │                    │
                            ▼                    ▼
                     ┌──────────────┐     ┌──────────────┐
                     │  Workspace   │     │  Workspace   │
                     │   /inbox/    │     │   /outbox/   │
                     └──────────────┘     └──────────────┘
```

## Media Types

All platforms map to these generic types defined in `src/types.ts`:

```typescript
type MediaType = "image" | "video" | "audio" | "voice" | "document";

interface MessageAttachment {
  path: string;        // Local file path
  type: MediaType;     // Generic type
  mimeType: string;    // MIME type (e.g., "image/jpeg")
  filename?: string;   // Original filename if available
  sizeBytes?: number;  // File size in bytes
}
```

## Configuration

| Env Variable | Default | Description |
|--------------|---------|-------------|
| `MERCURY_MEDIA_ENABLED` | `true` | Enable/disable media downloads |
| `MERCURY_MEDIA_MAX_SIZE_MB` | `10` | Max file size to download (MB) |

## Storage

### Ingress (inbox/)

Incoming media files are saved to the space workspace:

```
.mercury/spaces/<space_id>/inbox/<timestamp>-<type>.<ext>
```

Example:
```
.mercury/spaces/whatsapp_123456_g_us/inbox/
├── 1709012345-image.jpg
├── 1709012400-voice.ogg
└── 1709012500-document.pdf
```

### Egress (outbox/)

The model writes files to `outbox/` during a container run. After exit, the runtime scans for files with `mtime >= startTime` and attaches them to the reply:

```
.mercury/spaces/<space_id>/outbox/
├── chart.png
└── summary.pdf
```

Previous outbox files are not deleted — only new or modified files are sent. See [pipeline.md](../pipeline.md) for details.

## Database Schema

Attachments are stored as JSON in the `messages.attachments` column:

```sql
ALTER TABLE messages ADD COLUMN attachments TEXT;
```

```json
[
  {
    "path": "/Users/.../media/1709012345-image.jpg",
    "type": "image",
    "mimeType": "image/jpeg",
    "sizeBytes": 12345
  }
]
```

## Prompt Format

Attachments are passed to pi as XML:

```xml
<attachments>
  <attachment type="image" path="/spaces/xxx/media/123-image.jpg" mime="image/jpeg" size="12345" />
</attachments>

@mercury what's in this image?
```

Reply context includes media info:

```xml
<reply_to name="John" jid="123@wa" message_id="ABC" media_type="image" media_mime="image/jpeg">
Check out this sunset!
</reply_to>
```

## pi Capabilities

| Media Type | pi Support |
|------------|------------|
| Images (jpg, png, gif, webp) | ✅ Can view via `read` tool |
| Voice/Audio | ❌ Cannot play — needs transcription |
| Video | ❌ Cannot play — could extract frames |
| Documents (txt, code) | ✅ Can read text-based files |
| Documents (pdf, docx) | ❌ Cannot read binary formats |

## Voice transcription

Voice and audio attachments are not playable inside pi. Install the **`voice-transcribe`** extension (see dashboard catalog or `examples/extensions/voice-transcribe/`) to append a text transcript before the agent runs.

- **Default (`voice-transcribe.provider=local`)**: runs Python on the Mercury host; install deps from the extension’s `requirements.txt`. Set `voice-transcribe.local_engine` to `transformers` (default, e.g. [mike249/whisper-tiny-he-2](https://huggingface.co/mike249/whisper-tiny-he-2)) or `faster_whisper` for [CTranslate2](https://github.com/OpenNMT/CTranslate2) models on the Hub (e.g. [ivrit-ai](https://huggingface.co/ivrit-ai) `*-ct2` repos). See the extension skill for `MERCURY_VOICE_FW_COMPUTE_TYPE` and `MERCURY_VOICE_LANGUAGE`.
- **OpenAI-compatible (`voice-transcribe.provider=openai`)**: cloud `POST /audio/transcriptions` with `MERCURY_STT_API_KEY` (host-only). Works with OpenAI (default) or Groq via `voice-transcribe.base_url=https://api.groq.com/openai/v1`. No Python/GPU on the host — best for small VPS deployments.
- **Gemini (`voice-transcribe.provider=gemini`)**: Google Gemini audio understanding with `MERCURY_STT_GEMINI_API_KEY` (host-only, plain API key).
- **API (`voice-transcribe.provider=api`)**: uses the [Hugging Face Inference API](https://huggingface.co/docs/api-inference) with `MERCURY_HF_TOKEN` — choose a model that has a Hub Inference Provider.

Config keys resolve per space with deployment-wide fallbacks — see [Extension config defaults](../configuration.md#extension-config-defaults-extensions) for the `extensions:` YAML section and the dashboard `@global` scope.

## Future Enhancements

- [ ] Video frame extraction
- [ ] PDF text extraction

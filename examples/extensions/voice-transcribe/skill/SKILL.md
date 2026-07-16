---
name: voice-transcribe
description: Voice notes are transcribed to text before the agent runs (local Python, OpenAI-compatible cloud, Gemini, or Hugging Face Inference API).
---

# Voice transcription

When a user sends a **voice note** or **audio** attachment, Mercury runs the `voice-transcribe` extension **before** the container starts. The transcript is appended to the user message as a `[Voice transcript]` block. You receive normal text — you do not need to read or play audio files for intent.

## Configuration

Keys resolve per space, then fall back to deployment-wide defaults (`@global` scope set from the dashboard Features page, or the `extensions:` section of `mercury.yaml`), then to the extension defaults.

| Key | Purpose |
|-----|---------|
| `voice-transcribe.provider` | `local` (default), `openai`, `gemini`, or `api` |
| `voice-transcribe.model` | Model id for the chosen provider (see below) |
| `voice-transcribe.local_engine` | Local only: `transformers` (default) or `faster_whisper` (CTranslate2 Hub repos) |
| `voice-transcribe.base_url` | `openai` only: API root (default `https://api.openai.com/v1`; Groq: `https://api.groq.com/openai/v1`) |
| `voice-transcribe.language` | Cloud providers: ISO-639-1 hint (e.g. `he`). Improves accuracy on short voice notes |

### Local provider (`local`)

Runs `scripts/transcribe.py` on the **Mercury host**.

**Transformers (default)** — `voice-transcribe.local_engine=transformers` uses [Transformers](https://huggingface.co/docs/transformers) `pipeline("automatic-speech-recognition", model=...)`. Use standard PyTorch Whisper / compatible Hub ids (e.g. [mike249/whisper-tiny-he-2](https://huggingface.co/mike249/whisper-tiny-he-2)).

**Faster-Whisper** — set `voice-transcribe.local_engine=faster_whisper` and [faster-whisper](https://github.com/SYSTRAN/faster-whisper) loads **CTranslate2** checkpoints from the Hub. Set `voice-transcribe.model` to a **CT2** repo (not plain PyTorch Whisper weights). Examples for Hebrew: [ivrit-ai/faster-whisper-v2-d4](https://huggingface.co/ivrit-ai/faster-whisper-v2-d4), [ivrit-ai/whisper-large-v3-turbo-ct2](https://huggingface.co/ivrit-ai/whisper-large-v3-turbo-ct2).

1. Install on the same machine that runs Mercury:

   ```bash
   pip install -r /path/to/.mercury/extensions/voice-transcribe/requirements.txt
   ```

   Or: `pip install "transformers>=4.40.0" "torch>=2.0.0" "faster-whisper>=1.0.0" "imageio-ffmpeg>=0.4.9"`

   **Telegram voice** is usually `.ogg` (Opus). Both backends shell out to an executable named `ffmpeg`; `transcribe.py` uses `imageio-ffmpeg`’s binary and exposes it as `ffmpeg` / `ffmpeg.exe` on `PATH` (hardlink or copy under `%TEMP%\\mercury-voice-ffmpeg` on Windows). Installing system ffmpeg on `PATH` also works (e.g. `winget install Gyan.FFmpeg`).

2. Optional host `.env`:
   - `MERCURY_VOICE_PYTHON` — Python executable (default: `python` on Windows, `python3` elsewhere)
   - `MERCURY_VOICE_TRANSCRIBE_TIMEOUT_MS` — subprocess timeout in ms (default `300000`)
   - `MERCURY_VOICE_ASR_DEVICE` — `cpu`, `cuda`, or `auto`. Used by **both** local engines. On Windows the default is **CPU** (CUDA often looks available but fails at inference). Set `cuda` if you have a working GPU stack.
   - `MERCURY_VOICE_FW_COMPUTE_TYPE` — **Faster-Whisper only**: e.g. `int8`, `float16`, `float32`. If unset: `int8` on CUDA, `float32` on CPU.
   - `MERCURY_VOICE_LANGUAGE` — **Faster-Whisper only**: ISO code passed to `transcribe(..., language=...)` (e.g. `he`). If unset, language is auto-detected.

Hub messages like *Xet Storage… hf_xet* are warnings only, not the cause of failures.

First run downloads the model into the Hugging Face cache (size depends on the model). **Each voice note spawns a new Python process**, so the first transcription after Mercury starts can be slow while the model loads (no in-process reuse yet).

### OpenAI-compatible provider (`openai`)

POSTs audio to `{base_url}/audio/transcriptions` (multipart). Requires `MERCURY_STT_API_KEY` on the host (the key never enters agent containers). Works with:

- **OpenAI** (default `base_url`) — models `gpt-4o-mini-transcribe` (default), `gpt-4o-transcribe`, `whisper-1`
- **Groq** — set `voice-transcribe.base_url=https://api.groq.com/openai/v1`, model `whisper-large-v3`
- Any other host implementing the same endpoint

No Python, ffmpeg, or GPU on the host — ideal for small VPS deployments. Set `voice-transcribe.language` (e.g. `he`) for better accuracy on short notes.

### Gemini provider (`gemini`)

Sends audio inline to the Gemini API (`generateContent`) with a transcription instruction. Requires `MERCURY_STT_GEMINI_API_KEY` on the host (a plain API key — no GCP project setup; deliberately separate from the model-chain `MERCURY_GEMINI_API_KEY`, which must keep flowing into containers). Default model `gemini-2.5-flash`. Also host-only, no local dependencies.

### API provider (`api`)

POSTs audio to `https://api-inference.huggingface.co/models/<model>`. Requires `MERCURY_HF_TOKEN` on the host. Pick a model that has an [Inference Provider](https://huggingface.co/docs/api-inference) on its Hub page (e.g. `openai/whisper-large-v3`). Hebrew-tuned models such as [mike249/whisper-tiny-he-2](https://huggingface.co/mike249/whisper-tiny-he-2) often have **no** hosted provider — use **`local`** for those. CT2 / Faster-Whisper Hub repos are for the **local** engine only, not this API.

## RBAC

Only callers with the `voice-transcribe` permission (default: admin + member) get transcription. Others keep the raw message without an appended transcript.

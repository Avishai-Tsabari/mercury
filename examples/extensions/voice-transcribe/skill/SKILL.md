---
name: voice-transcribe
description: Voice notes are transcribed to text before the agent runs (local Python or Hugging Face Inference API).
---

# Voice transcription

When a user sends a **voice note** or **audio** attachment, Mercury runs the `voice-transcribe` extension **before** the container starts. The transcript is appended to the user message as a `[Voice transcript]` block. You receive normal text — you do not need to read or play audio files for intent.

## Configuration (per space)

| Key | Purpose |
|-----|---------|
| `voice-transcribe.provider` | `local` (default) or `api` |
| `voice-transcribe.model` | Hugging Face model id (see below) |
| `voice-transcribe.local_engine` | Local only: `transformers` (default) or `faster_whisper` (CTranslate2 Hub repos) |

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

### API provider (`api`)

POSTs audio to `https://api-inference.huggingface.co/models/<model>`. Requires `MERCURY_HF_TOKEN` on the host. Pick a model that has an [Inference Provider](https://huggingface.co/docs/api-inference) on its Hub page (e.g. `openai/whisper-large-v3`). Hebrew-tuned models such as [mike249/whisper-tiny-he-2](https://huggingface.co/mike249/whisper-tiny-he-2) often have **no** hosted provider — use **`local`** for those. CT2 / Faster-Whisper Hub repos are for the **local** engine only, not this API.

## RBAC

Only callers with the `voice-transcribe` permission (default: admin + member) get transcription. Others keep the raw message without an appended transcript.

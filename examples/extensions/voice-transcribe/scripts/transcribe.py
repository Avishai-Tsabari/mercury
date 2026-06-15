#!/usr/bin/env python3
"""Transcribe a single audio file; print one JSON line to stdout: {\"text\":\"...\"} or {\"error\":\"...\"}."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import tempfile


def _ensure_ffmpeg_on_path() -> None:
    """
    Transformers and faster-whisper decode via ffmpeg on PATH.
    imageio-ffmpeg ships a versioned .exe (e.g. ffmpeg-win-x86_64-v7.1.exe). On Windows,
    Popen([...]) without shell=True will not run a .bat shim — it needs a real `ffmpeg.exe`
    on PATH. We hardlink (or copy) the vendored binary to `<temp>/mercury-voice-ffmpeg/ffmpeg.exe`.
    """
    if shutil.which("ffmpeg"):
        return
    try:
        import imageio_ffmpeg
    except ImportError:
        return
    src = imageio_ffmpeg.get_ffmpeg_exe()
    if not src or not os.path.isfile(src):
        return

    shim_root = os.path.join(tempfile.gettempdir(), "mercury-voice-ffmpeg")
    os.makedirs(shim_root, exist_ok=True)
    dst = os.path.join(shim_root, "ffmpeg.exe" if sys.platform == "win32" else "ffmpeg")

    if not os.path.exists(dst):
        try:
            os.link(src, dst)
        except OSError:
            try:
                shutil.copy2(src, dst)
            except OSError:
                return
    elif sys.platform != "win32":
        try:
            os.chmod(dst, 0o755)
        except OSError:
            pass

    os.environ["PATH"] = f"{shim_root}{os.pathsep}{os.environ.get('PATH', '')}"


def _asr_device_torch():
    """Resolve torch device for Transformers. Env: MERCURY_VOICE_ASR_DEVICE=cpu|cuda|auto (default auto)."""
    import torch

    raw = (os.environ.get("MERCURY_VOICE_ASR_DEVICE") or "").strip().lower()
    if not raw or raw == "auto":
        # Windows often reports CUDA but inference fails (drivers, OOM); CPU is the reliable default.
        if sys.platform == "win32":
            raw = "cpu"
        else:
            raw = "cuda" if torch.cuda.is_available() else "cpu"
    if raw in ("cpu", "-1"):
        return torch.device("cpu")
    if raw in ("cuda", "gpu", "cuda:0", "0"):
        if torch.cuda.is_available():
            return torch.device("cuda:0")
        return torch.device("cpu")
    return torch.device("cpu")


def _cuda_available() -> bool:
    try:
        import torch

        return bool(torch.cuda.is_available())
    except ImportError:
        return False


def _fw_device_str() -> str:
    """faster-whisper device string: cpu | cuda. Same MERCURY_VOICE_ASR_DEVICE semantics as Transformers."""
    raw = (os.environ.get("MERCURY_VOICE_ASR_DEVICE") or "").strip().lower()
    if not raw or raw == "auto":
        if sys.platform == "win32":
            return "cpu"
        return "cuda" if _cuda_available() else "cpu"
    if raw in ("cpu", "-1"):
        return "cpu"
    if raw in ("cuda", "gpu", "cuda:0", "0"):
        return "cuda" if _cuda_available() else "cpu"
    return "cpu"


def _fw_compute_type(device: str) -> str:
    override = (os.environ.get("MERCURY_VOICE_FW_COMPUTE_TYPE") or "").strip()
    if override:
        return override
    return "int8" if device == "cuda" else "float32"


def _fw_language() -> str | None:
    lang = (os.environ.get("MERCURY_VOICE_LANGUAGE") or "").strip()
    return lang if lang else None


def _run_transformers(audio_path: str, model_id: str) -> str:
    try:
        from transformers import pipeline
    except ImportError as e:
        raise ImportError(f"transformers import failed: {e}") from e

    _ensure_ffmpeg_on_path()
    device = _asr_device_torch()
    pipe = pipeline(
        "automatic-speech-recognition",
        model=model_id,
        device=device,
    )
    result = pipe(audio_path)
    if isinstance(result, dict):
        return (result.get("text") or "").strip()
    return str(result).strip()


def _run_faster_whisper(audio_path: str, model_id: str) -> str:
    try:
        from faster_whisper import WhisperModel
    except ImportError as e:
        raise ImportError(
            "faster-whisper is required when local_engine=faster_whisper. "
            "Install: pip install faster-whisper"
        ) from e

    _ensure_ffmpeg_on_path()
    device = _fw_device_str()
    compute_type = _fw_compute_type(device)
    lang = _fw_language()

    model = WhisperModel(model_id, device=device, compute_type=compute_type)
    kwargs: dict = {}
    if lang:
        kwargs["language"] = lang
    segments, _info = model.transcribe(audio_path, **kwargs)
    parts: list[str] = []
    for seg in segments:
        parts.append(seg.text)
    return "".join(parts).strip()


def main() -> None:
    ap = argparse.ArgumentParser(description="ASR for Mercury voice-transcribe (local provider)")
    ap.add_argument("--audio", required=True, help="Path to audio file on disk")
    ap.add_argument("--model", required=True, help="Hugging Face model id")
    ap.add_argument(
        "--local-engine",
        choices=("transformers", "faster_whisper"),
        default="transformers",
        help="Local ASR backend (default: transformers)",
    )
    args = ap.parse_args()

    try:
        if args.local_engine == "faster_whisper":
            text = _run_faster_whisper(args.audio, args.model)
        else:
            text = _run_transformers(args.audio, args.model)
    except ImportError as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(2)
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

    print(json.dumps({"text": text}))


if __name__ == "__main__":
    main()

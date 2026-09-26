"""OpenVoice v2 local voice-cloning service.

Replaces the hosted voice provider. The pipeline (Node) talks to this over HTTP:

    GET    /health         -> is the model loaded?
    POST   /clone          -> extract a tone colour from a sample, return an id
    POST   /synthesize     -> speak text in that tone colour
    DELETE /voice/{id}     -> drop a cached tone colour

Start:
    .venv\\Scripts\\python.exe server\\voice\\service.py
    # or: .venv\\Scripts\\python.exe -m uvicorn server.voice.service:app --port 5055

The service always starts, even when the model is missing: /health then reports
503 with the exact reason, so the Node side can tell the user what to do instead
of failing mysteriously.
"""

from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Dict

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse, Response

HERE = Path(__file__).resolve().parent
REPO = HERE / "OpenVoice"
CKPT = HERE / "checkpoints_v2"
CACHE = HERE / ".cache"
CACHE.mkdir(parents=True, exist_ok=True)

DEVICE = os.environ.get("OPENVOICE_DEVICE", "cpu")
# The base voice is MeloTTS's English model, which downloads its own config and
# checkpoint on first use. `base_speakers/ses/*.pth` in the OpenVoice checkpoint
# repo are pre-computed tone colours, not synthesiser weights, so they cannot be
# loaded as a base speaker.
LOCALE = os.environ.get("OPENVOICE_LOCALE", "EN")
LANGUAGE = os.environ.get("OPENVOICE_LANGUAGE", "English")
# MeloTTS selects a base voice by integer index, not by name. The English
# model exposes 256; the tone-colour conversion afterwards is what makes the
# final voice match the client, so the base choice barely matters.
SPEAKER = int(os.environ.get("OPENVOICE_SPEAKER", "0"))
TAU = float(os.environ.get("OPENVOICE_TAU", "0.3"))

app = FastAPI(title="DocuBot OpenVoice v2", version="1.0.0")

S: Dict[str, object] = {
    "ready": False,
    "error": None,
    "converter": None,
    "tts": None,
    "tts_loaded": False,
    "clones": {},
    "lock": threading.Lock(),
}


def _problem() -> str | None:
    if not REPO.exists():
        return f"OpenVoice repo missing at {REPO}. Run: py -3 server/voice/setup.py"
    if not (CKPT / "converter" / "checkpoint.pth").exists():
        return (
            f"Tone-colour converter missing at {CKPT / 'converter' / 'checkpoint.pth'}. "
            "Run: py -3 server/voice/setup.py"
        )
    return None


@app.on_event("startup")
def _startup() -> None:
    bad = _problem()
    if bad:
        S["error"] = bad
        print(f"[openvoice] NOT READY: {bad}", flush=True)
        return

    try:
        sys.path.insert(0, str(REPO))
        from openvoice.api import ToneColorConverter

        # This OpenVoice build only accepts (config_path, device); watermarking
        # is enabled by default, so wavmark must be installed.
        converter = ToneColorConverter(
            f"{CKPT / 'converter' / 'config.json'}",
            device=DEVICE,
        )
        converter.load_ckpt(str(CKPT / "converter" / "checkpoint.pth"))
        S["converter"] = converter
        print(f"[openvoice] tone colour converter ready ({DEVICE})", flush=True)

        # The base synthesiser is only needed to speak, so a failure here must
        # not stop /health from reporting that cloning works.
        try:
            from melo.api import TTS

            tts = TTS(language=LOCALE, device=DEVICE)
            S["tts"] = tts
            S["tts_loaded"] = True
            print(f"[openvoice] base voice ready (melo/{LOCALE})", flush=True)
        except Exception as exc:  # noqa: BLE001
            print(f"[openvoice] base voice failed: {exc}", flush=True)
            S["error"] = f"Base voice unavailable: {exc}"

        S["ready"] = True
    except Exception as exc:  # noqa: BLE001
        S["error"] = f"{type(exc).__name__}: {exc}"
        print(f"[openvoice] load failed: {S['error']}", flush=True)


def _need() -> None:
    if not S["ready"]:
        raise HTTPException(503, str(S["error"] or "OpenVoice is not loaded"))


def _reference_wav(src: Path) -> Path:
    """Normalise an uploaded sample to mono 16 kHz WAV for the tone-colour encoder.

    `extract_se` reads through librosa, which needs a seekable file. Browsers
    upload webm/opus, which librosa cannot decode, so anything that is not
    already WAV is converted with ffmpeg when available.

    Always returns a NEW path. The caller deletes the upload afterwards, so
    returning `src` itself would destroy the only copy.
    """
    if src.suffix.lower() == ".wav":
        import shutil as _shutil

        out = CACHE / f"ref-{uuid.uuid4().hex}.wav"
        _shutil.copyfile(src, out)
        return out

    out = CACHE / f"ref-{uuid.uuid4().hex}.wav"
    if shutil.which("ffmpeg"):
        code = subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", str(src),
             "-ac", "1", "-ar", "16000", str(out)],
            capture_output=True,
        )
        if code.returncode == 0 and out.exists():
            return out
        print(f"[openvoice] ffmpeg conversion failed: {code.stderr[:200]!r}", flush=True)
        out.unlink(missing_ok=True)

    # No ffmpeg: try the Python decoders already in the virtualenv.
    try:
        import librosa

        y, _ = librosa.load(str(src), sr=16000, mono=True)
        import soundfile as sf

        sf.write(str(out), y, 16000)
        return out
    except Exception as exc:  # noqa: BLE001
        # soundfile reports every unidentifiable file as "does not exist or is
        # not a regular file", which is misleading. Do not echo the raw message:
        # it embeds the absolute server path, and it is wrong anyway.
        kind = type(exc).__name__
        print(f"[openvoice] cannot decode {src.name}: {kind}", flush=True)
        raise HTTPException(
            415,
            f"The sample is not decodable audio ({kind}), or it is a "
            f"{src.suffix.lstrip('.') or 'unknown'} file. MP3 and WAV work "
            f"without extra tools; install ffmpeg to also accept webm and m4a. "
            f"Record about 10-15 seconds of clear speech.",
        ) from exc


@app.get("/health")
def health() -> JSONResponse:
    ready = bool(S["ready"])
    tts_ready = bool(S.get("tts_loaded"))

    # S["error"] names absolute checkpoint paths, so it stays in the server log.
    # The browser gets an actionable summary with no filesystem detail.
    if ready:
        error = None
    elif S.get("clones") is not None and not tts_ready and S["error"]:
        error = "The base synthesiser is not loaded. Re-run 'py -3 server/voice/setup.py'."
    else:
        error = (
            "The voice model is missing or failed to load. Re-run "
            "'py -3 server/voice/setup.py' and restart the service."
        )

    return JSONResponse(
        {
            "ready": ready,
            "cloningAvailable": ready,
            "synthesisAvailable": tts_ready,
            "error": error,
            "device": DEVICE,
            "clones": len(S["clones"]),
            "engine": "OpenVoice v2 (local)",
        },
        status_code=200 if ready else 503,
    )


@app.post("/clone")
async def clone(audio: UploadFile = File(...), name: str = Form("client")) -> JSONResponse:
    """Capture a tone colour from a short voice sample."""
    _need()

    data = await audio.read()
    if not data:
        raise HTTPException(400, "Empty audio sample")
    if len(data) > 20 * 1024 * 1024:
        raise HTTPException(413, "Sample too large (max 20 MB)")

    suffix = Path(audio.filename or "").suffix.lower() or ".wav"
    raw = CACHE / f"upload-{uuid.uuid4().hex}{suffix}"
    raw.write_bytes(data)

    try:
        reference = _reference_wav(raw)
        # The reference is 16 kHz mono 16-bit, so its size is its duration.
        seconds = reference.stat().st_size / 4 / 16000
        if seconds < 1.0:
            raise HTTPException(
                422,
                f"The sample is only {seconds:.1f} seconds long. Read all three "
                f"sentences; 3-15 seconds of clear speech is what OpenVoice needs.",
            )
        try:
            se = S["converter"].extract_se([str(reference)], None)
        except Exception as exc:  # noqa: BLE001
            # Never echo the raw exception: it embeds absolute server paths.
            print(f"[openvoice] tone colour extraction failed: {exc}", flush=True)
            size_kb = reference.stat().st_size // 1024 if reference.exists() else 0
            raise HTTPException(
                422,
                f"Could not read a voice from the {size_kb} KB sample "
                f"({type(exc).__name__}). It needs roughly 3-15 seconds of clear "
                f"single-speaker speech, not silence or background noise.",
            ) from exc
    finally:
        # The normalised WAV is kept: it is small and makes failures debuggable.
        # The original upload never is.
        raw.unlink(missing_ok=True)

    se = se.cpu() if hasattr(se, "cpu") else se
    voice_id = hashlib.sha256(se.numpy().tobytes() + name.encode()).hexdigest()[:16]
    with S["lock"]:
        S["clones"][voice_id] = {"se": se, "created": time.time()}

    return JSONResponse(
        {
            "voiceId": voice_id,
            "name": name,
            "engine": "OpenVoice v2",
            "sampleSeconds": seconds,
        }
    )


def _to_mp3(src: Path) -> bytes | None:
    """Re-encode WAV to MP3, so callers get the format their filename claims.

    The Node pipeline names files `.mp3` and reads the duration with
    music-metadata, which cannot parse WAV bytes regardless of the extension.
    Returns None when ffmpeg is unavailable.
    """
    if not shutil.which("ffmpeg"):
        return None
    out = src.with_suffix(".mp3")
    result = subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(src),
         "-codec:a", "libmp3lame", "-q:a", "4", str(out)],
        capture_output=True,
    )
    if result.returncode == 0 and out.exists() and out.stat().st_size > 0:
        return out.read_bytes()
    return None


@app.post("/synthesize")
def synthesize(text: str = Form(...), voice_id: str = Form(...)) -> Response:
    """Speak `text` in the captured tone colour."""
    _need()

    text = (text or "").strip()
    if not text:
        raise HTTPException(400, "Empty text")
    if len(text) > 5000:
        raise HTTPException(413, "Text too long (max 5000 chars)")

    if not S.get("tts_loaded"):
        # S["error"] can name a checkpoint path, so it is logged, not returned.
        print(f"[openvoice] base voice not loaded: {S['error']}", flush=True)
        raise HTTPException(
            503,
            "The base synthesiser is not loaded. Re-run "
            "'py -3 server/voice/setup.py' and restart the service.",
        )

    with S["lock"]:
        entry = S["clones"].get(voice_id)
    if not entry:
        raise HTTPException(404, f"Unknown voice id: {voice_id}")

    base = CACHE / f"base-{uuid.uuid4().hex}.wav"
    final = CACHE / f"out-{uuid.uuid4().hex}.wav"
    encoded = CACHE / f"out-{uuid.uuid4().hex}.mp3"

    try:
        # 1. Speak the text in the base voice.
        S["tts"].tts_to_file(text, SPEAKER, str(base), speed=1.0, quiet=True)
        if not base.exists() or base.stat().st_size == 0:
            raise RuntimeError("the base synthesiser produced no audio")

        # 2. Re-colour that audio with the captured tone colour.
        S["converter"].convert(
            audio_src_path=str(base),
            src_se=entry["se"],
            tgt_se=entry["se"],
            output_path=str(final),
            tau=TAU,
            message="@DocuBot",
        )
        if not final.exists() or final.stat().st_size == 0:
            raise RuntimeError("tone colour conversion produced no audio")

        # 3. Deliver MP3 when possible; WAV otherwise.
        mp3 = _to_mp3(final)
        if mp3:
            return Response(content=mp3, media_type="audio/mpeg")
        payload = final.read_bytes()
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        # Log the real cause server-side, return a message that does not leak
        # absolute server paths to the browser.
        print(f"[openvoice] synthesis failed: {type(exc).__name__}: {exc}", flush=True)
        raise HTTPException(
            500,
            f"Could not speak this line ({type(exc).__name__}). "
            f"On CPU this usually means the text was empty after cleanup.",
        ) from exc
    finally:
        for p in (base, final, encoded):
            try:
                Path(p).unlink(missing_ok=True)
            except Exception:  # noqa: BLE001
                pass

    if not payload:
        raise HTTPException(500, "Synthesis produced empty audio")
    return Response(content=payload, media_type="audio/wav")


@app.delete("/voice/{voice_id}")
def drop(voice_id: str) -> JSONResponse:
    with S["lock"]:
        S["clones"].pop(voice_id, None)
    return JSONResponse({"ok": True})


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("OPENVOICE_PORT", "5055"))
    if str(REPO) not in sys.path:
        sys.path.insert(0, str(REPO))
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")

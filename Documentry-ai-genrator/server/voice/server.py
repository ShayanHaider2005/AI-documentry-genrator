"""OmniVoice service — local zero-shot voice cloning and voice design.

Replaces the retired OpenVoice v2 service. The Node pipeline talks to this over
HTTP:

    GET  /health                      is the model loaded?
    POST /api/generate-voice          speak a line (cloning or voice design)
    POST /api/validate-reference      is this reference audio usable?

Why the shape changed
---------------------
OpenVoice extracted a "tone colour" once, at upload, and returned a voice id
that synthesis reused. OmniVoice is not built that way: cloning happens per
synthesis and needs the reference audio each time, plus the reference's
transcript. So callers pass a *path* rather than an id, and `/clone` becomes
`/api/validate-reference`.

Start:
    .venv\\Scripts\\python.exe server/voice/server.py

The service always starts, even when the model is missing: /health then reports
503 with the reason, so the Node side can tell the user what to do instead of
failing mysteriously.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import threading
import time
import traceback
import uuid
from pathlib import Path
from typing import Dict, List, Optional

import numpy as np
import soundfile as sf
import torch
from fastapi import Body, FastAPI, HTTPException
from fastapi.responses import JSONResponse, Response

HERE = Path(__file__).resolve().parent
VOICES_DIR = HERE.parent / "voices"
CACHE = HERE / ".cache"
CACHE.mkdir(parents=True, exist_ok=True)

MODEL_ID = os.environ.get("OMNIVOICE_MODEL", "k2-fsa/OmniVoice")
SAMPLE_RATE = 24000

# The weights are ~3.3 GB. Only claim a GPU that can actually hold them with
# room for activations, otherwise fall back to CPU. This machine has a 2 GB
# MX330, so it correctly lands on CPU.
# float() before the multiply: an env var is a string, and `"6" * 1024**3`
# repeats the string a billion times rather than multiplying.
GPU_MIN_FREE_BYTES = int(float(os.environ.get("OMNIVOICE_GPU_MIN_FREE_GB", "6")) * 1024**3)

# The default narrator, used when a caller supplies no reference audio.
DEFAULT_REF_AUDIO = os.environ.get(
    "OMNIVOICE_DEFAULT_REF", str(VOICES_DIR / "south_asian_narrator.wav")
)
# The model's instruct vocabulary is a closed list, and anything outside it is a
# hard error rather than a hint. These are the only English attributes:
#   gender  : male, female
#   age     : child, teenager, young adult, middle-aged, elderly
#   pitch   : very low, low, moderate, high, very high  (" pitch")
#   style   : whisper
#   accent  : american, australian, british, canadian, indian, chinese,
#             japanese, korean, portuguese, russian  (" accent")
# There is no "pakistani accent" and no free-form style words such as
# "documentary narrator", so the default sticks to what the model accepts.
DEFAULT_INSTRUCT = os.environ.get(
    "OMNIVOICE_DEFAULT_INSTRUCT",
    "male, indian accent, moderate pitch",
)

# Diffusion decoding steps. Cost is close to linear in this, so 32 -> 16 roughly
# halves generation time at some cost in fidelity. The default is 32 (full
# quality); drop it when running on CPU and the wait is the problem.
NUM_STEP = int(os.environ.get("OMNIVOICE_NUM_STEP", "32"))

app = FastAPI(title="DocuBot OmniVoice service", version="2.0.0")

# Inference is serialised: a diffusion TTS is not thread-safe and two concurrent
# CPU inferences would simply halve each other's throughput.
_infer_lock = threading.Lock()

S: Dict[str, object] = {
    "ready": False,
    "loading": False,
    "error": None,
    "model": None,
    "device": None,
    "dtype": None,
    "loadedAt": None,
    "generated": 0,
}


def _log(message: str) -> None:
    print(f"[omnivoice] {message}", flush=True)


def _pick_device() -> tuple[str, torch.dtype]:
    if torch.cuda.is_available():
        try:
            free, _total = torch.cuda.mem_get_info()
            if free > GPU_MIN_FREE_BYTES:
                return "cuda:0", torch.float16
            _log(
                f"GPU has {free / 1024 ** 3:.1f} GB free, below the "
                f"{GPU_MIN_FREE_BYTES / 1024 ** 3:.0f} GB needed. Using CPU."
            )
        except Exception:  # noqa: BLE001
            _log("could not query GPU memory. Using CPU.")
    return "cpu", torch.float32


def _load_model() -> None:
    if S["ready"] or S["loading"]:
        return

    S["loading"] = True
    device_map, dtype = _pick_device()
    _log(f"loading {MODEL_ID} on {device_map} ({dtype}) — first run downloads ~3.3 GB")
    started = time.time()

    try:
        from omnivoice import OmniVoice

        model = OmniVoice.from_pretrained(MODEL_ID, device_map=device_map, dtype=dtype)
        S["model"] = model
        S["device"] = device_map
        S["dtype"] = str(dtype)
        S["loadedAt"] = time.time()
        S["ready"] = True
        S["error"] = None
        _log(f"ready in {time.time() - started:.1f}s")
    except Exception as exc:  # noqa: BLE001
        S["error"] = f"{type(exc).__name__}: {exc}"
        _log(f"load failed: {S['error']}")
        _log(traceback.format_exc()[-1200:])
    finally:
        S["loading"] = False


@app.on_event("startup")
def _startup() -> None:
    # Load in the background so /health answers immediately with "loading"
    # instead of blocking the port for the length of a 3.3 GB download.
    threading.Thread(target=_load_model, name="omnivoice-load", daemon=True).start()


def _need() -> None:
    if not S["ready"]:
        if S["loading"]:
            raise HTTPException(503, "OmniVoice is still loading its model. Try again shortly.")
        raise HTTPException(
            503,
            "OmniVoice is not loaded. Run 'npm run voice:setup' and restart the service.",
        )


# ---------------------------------------------------------------------------
# Reference audio
# ---------------------------------------------------------------------------
def _read_audio(path: Path) -> tuple[np.ndarray, int]:
    """Decode any container soundfile understands to mono float32."""
    data, sr = sf.read(str(path), dtype="float32", always_2d=False)
    if data.ndim > 1:
        data = data.mean(axis=1)
    return data, sr


def _normalise_reference(src: Path) -> Path:
    """Return a NEW mono 24 kHz WAV path for the reference.

    ALWAYS a new path. The caller deletes whatever this returns once inference
    is done, so returning `src` itself would destroy the user's recording — and,
    worse, the bundled default narrator. An earlier version did exactly that.

    OmniVoice consumes 24 kHz audio. Browser uploads arrive as webm/opus, which
    libsndfile cannot read, so those need ffmpeg. The website already re-encodes
    in the browser, so this is the path for files recorded elsewhere.
    """
    out = CACHE / f"ref-{uuid.uuid4().hex}.wav"

    if shutil.which("ffmpeg"):
        code = subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", str(src),
             "-ac", "1", "-ar", str(SAMPLE_RATE), str(out)],
            capture_output=True,
        )
        if code.returncode == 0 and out.exists() and out.stat().st_size > 0:
            return out
        out.unlink(missing_ok=True)
        _log(f"ffmpeg could not convert {src.name}: {code.stderr[:200]!r}")

    try:
        data, _sr = _read_audio(src)
    except Exception as exc:  # noqa: BLE001
        kind = type(exc).__name__
        _log(f"cannot decode {src.name}: {kind}")
        raise HTTPException(
            415,
            f"The reference is not decodable audio ({kind}), or it is a "
            f"{src.suffix.lstrip('.') or 'unknown'} file. Record it in the app "
            f"or upload MP3 or WAV. Install ffmpeg to also accept webm and m4a.",
        ) from exc

    sf.write(str(out), data, SAMPLE_RATE)
    return out


def _sidecar_text(audio: Path) -> str:
    """Read <audio>.txt next to a reference: its transcript, if one exists."""
    sidecar = audio.with_suffix(".txt")
    if sidecar.exists():
        try:
            return sidecar.read_text(encoding="utf-8").strip()
        except OSError:
            return ""
    return ""


def _write_audio(audio: List[np.ndarray], output_path: Path) -> Path:
    """Write the first generated clip, honouring the caller's extension."""
    if not audio:
        raise HTTPException(500, "OmniVoice returned no audio.")
    data = np.asarray(audio[0], dtype=np.float32)
    if data.size == 0:
        raise HTTPException(500, "OmniVoice returned an empty clip.")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    # soundfile picks the encoder from the extension, so a .mp3 request really
    # does get MP3. Never write WAV bytes under a .mp3 name.
    try:
        sf.write(str(output_path), data, SAMPLE_RATE)
    except Exception as exc:  # noqa: BLE001
        _log(f"could not write {output_path.suffix or 'output'}: {type(exc).__name__}: {exc}")
        fallback = output_path.with_suffix(".wav")
        sf.write(str(fallback), data, SAMPLE_RATE)
        return fallback

    if output_path.stat().st_size == 0:
        raise HTTPException(500, "OmniVoice wrote an empty file.")
    return output_path


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.get("/health")
@app.get("/api/health")
def health() -> JSONResponse:
    ready = bool(S["ready"])
    loading = bool(S["loading"])

    if ready:
        error = None
    elif loading:
        error = "OmniVoice is still loading its model."
    else:
        error = (
            "OmniVoice is not loaded. Run 'npm run voice:setup' and restart "
            "the service."
        )

    default_ref = Path(DEFAULT_REF_AUDIO)
    return JSONResponse(
        {
            "ready": ready,
            "loading": loading,
            "cloningAvailable": ready,
            "synthesisAvailable": ready,
            "error": error,
            "engine": "OmniVoice (local)",
            "model": MODEL_ID,
            "device": S["device"],
            "dtype": S["dtype"],
            "sampleRate": SAMPLE_RATE,
            "numStep": NUM_STEP,
            "generated": S["generated"],
            "defaultReference": str(default_ref) if default_ref.exists() else None,
        },
        status_code=200 if ready else 503,
    )


@app.post("/api/generate-voice")
def generate_voice(payload: Dict = Body(...)) -> JSONResponse:
    """Speak a line, cloning a reference voice or designing one from a prompt.

    Body:
        text            the line to speak
        ref_audio_path  optional reference audio; enables zero-shot cloning
        output_path     where to write the clip
        instruct        optional voice-design prompt, used when there is no
                        reference audio
        ref_text        optional transcript of the reference; read from a .txt
                        sidecar when omitted. Better clones, less guessing.
        num_step        optional diffusion steps; cost is near-linear in this.
                        Defaults to OMNIVOICE_NUM_STEP (32).
    """
    _need()

    text = str(payload.get("text") or "").strip()
    if not text:
        raise HTTPException(400, "text is required")
    if len(text) > 5000:
        raise HTTPException(413, "text is too long (max 5000 characters)")

    requested_output = payload.get("output_path") or str(CACHE / "out.wav")
    output_path = Path(requested_output)

    try:
        num_step = int(payload.get("num_step") or NUM_STEP)
    except (TypeError, ValueError) as exc:
        raise HTTPException(400, "num_step must be an integer") from exc
    if num_step < 1 or num_step > 128:
        raise HTTPException(400, "num_step must be between 1 and 128")

    instruct = payload.get("instruct")
    raw_ref = payload.get("ref_audio_path")

    # Precedence, and it matters:
    #   1. an explicit reference  -> clone
    #   2. an explicit instruct   -> voice design
    #   3. neither                -> the bundled default narrator, else design
    # Honouring the default reference ahead of an explicit `instruct` would
    # silently return the wrong voice to anyone deliberately designing one.
    if not raw_ref and not instruct:
        default_ref = Path(DEFAULT_REF_AUDIO)
        if default_ref.exists():
            raw_ref = str(default_ref)
            _log("no reference and no instruct; using the default South Asian narrator")
        else:
            instruct = DEFAULT_INSTRUCT
            _log("no reference and no instruct; using the default voice-design prompt")

    started = time.time()
    temp_ref: Optional[Path] = None
    # Belt and braces: the caller's reference is never ours to delete, whatever
    # _normalise_reference decides to hand back.
    protected = {Path(DEFAULT_REF_AUDIO).resolve()} if Path(DEFAULT_REF_AUDIO).exists() else set()

    try:
        if raw_ref:
            source = Path(str(raw_ref))
            if not source.exists():
                raise HTTPException(404, f"Reference audio not found: {source.name}")
            temp_ref = _normalise_reference(source)
            ref_audio = str(temp_ref)
            ref_text = str(payload.get("ref_text") or "").strip() or _sidecar_text(source)
            if not ref_text:
                # OmniVoice will auto-transcribe with Whisper. Slower, but it
                # means a caller who recorded their own clip still gets a clone.
                _log("no ref_text; OmniVoice will transcribe the reference itself")
                ref_text = None
            mode = "clone"
        else:
            ref_audio = None
            ref_text = None
            mode = "design"

        kwargs = {"text": text, "num_step": num_step}
        if ref_audio:
            kwargs["ref_audio"] = ref_audio
        if ref_text:
            kwargs["ref_text"] = ref_text
        if instruct:
            kwargs["instruct"] = str(instruct)

        with _infer_lock:
            audio = S["model"].generate(**kwargs)

        written = _write_audio(audio, output_path)
        elapsed = time.time() - started
        data = np.asarray(audio[0], dtype=np.float32)
        seconds = len(data) / SAMPLE_RATE
        S["generated"] = int(S["generated"]) + 1

        _log(
            f"{mode}: {seconds:.1f}s audio in {elapsed:.1f}s "
            f"(RTF {seconds / elapsed if elapsed else float('inf'):.2f}) -> {written.name}"
        )

        return JSONResponse(
            {
                "ok": True,
                "mode": mode,
                "output_path": str(written),
                "sampleRate": SAMPLE_RATE,
                "seconds": round(seconds, 2),
                "elapsed": round(elapsed, 2),
                "rtf": round(seconds / elapsed, 3) if elapsed else None,
                "num_step": num_step,
                "device": S["device"],
                "usedDefaultReference": bool(raw_ref) and raw_ref == DEFAULT_REF_AUDIO,
                "engine": "OmniVoice",
            }
        )
    except HTTPException:
        raise
    except ValueError as exc:
        # The model's instruct vocabulary is a closed list, and it says so
        # helpfully. That message is worth passing through: it is a vocabulary,
        # not a server path.
        _log(f"generate rejected: {exc}")
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        # Log the real cause; return something the browser can act on without
        # leaking absolute server paths.
        _log(f"generate failed: {type(exc).__name__}: {exc}")
        _log(traceback.format_exc()[-1200:])
        raise HTTPException(
            500,
            f"OmniVoice could not speak this line ({type(exc).__name__}). "
            f"Check the voice service log for the underlying cause.",
        ) from exc
    finally:
        if temp_ref is not None and temp_ref.resolve() not in protected:
            temp_ref.unlink(missing_ok=True)


@app.post("/api/validate-reference")
def validate_reference(payload: Dict = Body(...)) -> JSONResponse:
    """Check that a reference sample is usable, without generating anything.

    This replaces OpenVoice's upload-time `/clone`. OmniVoice does not extract a
    reusable embedding at upload, so the honest check is: can this audio be
    decoded, and is it long enough to clone from?
    """
    _need()

    raw = payload.get("ref_audio_path")
    if not raw:
        raise HTTPException(400, "ref_audio_path is required")
    source = Path(str(raw))
    if not source.exists():
        raise HTTPException(404, "Reference audio not found.")

    temp: Optional[Path] = None
    protected = {source.resolve(), Path(DEFAULT_REF_AUDIO).resolve()}
    try:
        temp = _normalise_reference(source)
        data, _sr = _read_audio(temp)
        seconds = len(data) / SAMPLE_RATE
        peak = float(np.abs(data).max()) if data.size else 0.0

        if seconds < 3.0:
            raise HTTPException(
                422,
                f"The sample is only {seconds:.1f} seconds long. Read all three "
                f"sentences; zero-shot cloning wants 3-15 seconds of clear speech.",
            )
        if peak < 0.005:
            raise HTTPException(
                422,
                "The sample is effectively silent. Check the microphone input and "
                "record again.",
            )

        return JSONResponse(
            {
                "ok": True,
                "seconds": round(seconds, 2),
                "sampleRate": SAMPLE_RATE,
                "ref_text_known": bool(str(payload.get("ref_text") or "").strip() or _sidecar_text(source)),
                "engine": "OmniVoice",
            }
        )
    finally:
        if temp is not None and temp.resolve() not in protected:
            temp.unlink(missing_ok=True)


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("OMNIVOICE_PORT", "8000"))
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")

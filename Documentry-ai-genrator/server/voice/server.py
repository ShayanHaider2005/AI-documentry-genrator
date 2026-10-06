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

# ---------------------------------------------------------------------------
# Offline mode for an already-downloaded model.
#
# Why this exists. `OmniVoice.from_pretrained` asks the Hugging Face hub which
# revision to load before it reads anything from disk. When that request hangs
# rather than failing, the service prints "loading ...", the port opens, /health
# answers 503 forever, and the process sits at 0% CPU with 4 MB resident. It
# looks like a slow load. It is not: measured on this machine, the same command
# hangs indefinitely with the hub reachable, and loads in 94 seconds with
# HF_HUB_OFFLINE=1.
#
# So: if the weights are already on disk, do not talk to the hub at all. If they
# are not, leave the network alone, because then the download is genuinely
# needed and this is a first run.
#
# An operator can still force either behaviour with HF_HUB_OFFLINE=0 or 1; this
# only fills in the blank.
# ---------------------------------------------------------------------------
def _weights_are_cached(model_id: str) -> bool:
    """Whether a snapshot for model_id already exists in the hub cache."""
    try:
        root = os.environ.get("HUGGINGFACE_HUB_CACHE") or os.environ.get("HF_HOME")
        root = Path(root) if root else Path.home() / ".cache" / "huggingface" / "hub"
        folder = "models--" + model_id.replace("/", "--")
        snapshots = root / folder / "snapshots"
        if not snapshots.is_dir():
            return False
        # A snapshot directory with entries, not an empty one left by an
        # interrupted download.
        return any(snapshots.iterdir())
    except Exception:
        return False


_MODEL_ID = os.environ.get("OMNIVOICE_MODEL", "k2-fsa/OmniVoice")
if "HF_HUB_OFFLINE" not in os.environ:
    if _weights_are_cached(_MODEL_ID):
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
        print(
            f"[omnivoice] {_MODEL_ID} is cached; running offline so the hub "
            f"cannot stall the load (override with HF_HUB_OFFLINE=0)"
        )
    else:
        print(
            f"[omnivoice] {_MODEL_ID} is not cached yet; staying online to "
            f"download it (~3.3 GB, first run only)"
        )

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


def _env_number(name: str, default, caster):
    """Read a numeric environment variable safely.

    Two traps this avoids, both of which have bitten this project already:

    1. An env var is a *string*. `os.environ.get("X", "6") * 1024**3` repeats
       the string a billion times instead of multiplying, producing a number
       with a million digits.
    2. An empty or malformed value (`X=`, or a stray space) makes a bare
       `int()`/`float()` raise, so the service refuses to start on a typo.

    Anything unparseable falls back to the default rather than crashing.
    """
    raw = os.environ.get(name)
    if raw is None or not str(raw).strip():
        return default
    try:
        return caster(raw)
    except (TypeError, ValueError):
        print(f"[omnivoice] {name}={raw!r} is not a number; using {default}", flush=True)
        return default


def _env_int(name: str, default: int) -> int:
    """An integer setting, tolerating a float-typed value.

    `int("6.5")` raises, so a user who writes 6.5 for a count would otherwise
    be silently given the default. Truncating is the least surprising reading
    of a count that arrived as a decimal.
    """
    value = _env_number(name, default, float)
    try:
        return int(value)
    except (TypeError, ValueError, OverflowError):
        return default


def _env_float(name: str, default: float) -> float:
    return _env_number(name, default, float)


# CPU inference is the bottleneck, so the thread count matters. Capping it
# leaves headroom for the OS and for the browser you are watching the preview
# in, at the cost of some raw throughput. Override if you want it all.
TORCH_THREADS = _env_int("OMNIVOICE_TORCH_THREADS", 4)
torch.set_num_threads(max(1, TORCH_THREADS))

# The weights are ~3.3 GB. Only claim a GPU that can actually hold them with
# room for activations, otherwise fall back to CPU. This machine has a 2 GB
# MX330, so it correctly lands on CPU.
GPU_MIN_FREE_GB = _env_float("OMNIVOICE_GPU_MIN_FREE_GB", 6.0)
GPU_MIN_FREE_BYTES = int(GPU_MIN_FREE_GB * 1024**3)

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

# Diffusion decoding steps. Cost is close to linear in this, so fewer steps is
# proportionally faster. 12 is the CPU sweet spot on this hardware: measured
# ~2.7x faster than 32, with little audible difference on narration. Raise it
# for final quality passes, lower it for drafts.
NUM_STEP = _env_int("OMNIVOICE_NUM_STEP", 12)

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


def _temp_path(prefix: str, suffix: str = ".wav") -> Path:
    """A fresh path under the cache directory. Always a NEW file."""
    return CACHE / f"{prefix}{uuid.uuid4().hex}{suffix}"


def _is_protected(path: Path, also_protect: frozenset = frozenset()) -> bool:
    """Is this file ours to delete? No, if it is a source or a narrator.

    Called on every temp file before unlinking it. The failure this guards
    against is severe and has already happened once: a cleanup path handed back
    the caller's own reference and deleted the bundled narrator, destroying the
    only default voice in the project.

    Three rules, in order of paranoia:
      1. if we cannot resolve the path, do not delete it;
      2. anything explicitly handed to us (the caller's reference, the default
         narrator) is untouchable;
      3. anything under server/voices/ is user-facing material, not scratch.
    """
    try:
        resolved = path.resolve()
    except OSError:
        return True  # if we cannot even resolve it, do not delete it
    if resolved in also_protect:
        return True
    try:
        resolved.relative_to(VOICES_DIR.resolve())
        return True
    except ValueError:
        return False


def _normalise_reference(src: Path) -> Path:
    """Return a NEW mono 24 kHz WAV path for the reference.

    ALWAYS a new file under CACHE, named `temp_ref_*.wav`. The caller deletes
    whatever this returns once inference is done, so returning `src` itself
    would destroy the user's recording — and, worse, the bundled default
    narrator. An earlier version did exactly that.

    OmniVoice consumes 24 kHz audio. Browser uploads arrive as webm/opus, which
    libsndfile cannot read, so those need ffmpeg. The website already re-encodes
    in the browser, so this is the path for files recorded elsewhere.
    """
    out = _temp_path("temp_ref_")

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
    """Read <audio>.txt next to a reference: its transcript, if one exists.

    The filename is derived from the audio, so any narrator works without code
    changes: `south_asian_narrator.wav` reads `south_asian_narrator.txt`, and a
    user upload `raj.wav` reads `raj.txt`.
    """
    sidecar = audio.with_suffix(".txt")
    if sidecar.exists():
        try:
            return sidecar.read_text(encoding="utf-8").strip()
        except OSError:
            return ""
    return ""


def _resolve_ref_text(source: Path, explicit: str) -> Optional[str]:
    """The reference transcript, preferring what the caller supplied.

    Order: an explicit `ref_text`, then a .txt sidecar, then None.

    Returning None here is not a failure, it is the expensive path: OmniVoice
    then loads `openai/whisper-large-v3-turbo` (~1.5 GB) and transcribes the
    reference itself. That happens on a cold cache, and on every scene once the
    model is resident, so any caller that can supply the transcript should.
    """
    if explicit and explicit.strip():
        return explicit.strip()
    sidecar = _sidecar_text(source)
    if sidecar:
        return sidecar
    return None


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
                        Defaults to OMNIVOICE_NUM_STEP (12).
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
    # The bundled narrator is the fallback reference, so it is protected on
    # every call whether or not the caller mentioned it.
    protected: set = {Path(DEFAULT_REF_AUDIO).resolve()}

    try:
        if raw_ref:
            source = Path(str(raw_ref))
            protected.add(source.resolve())
            if not source.exists():
                raise HTTPException(404, f"Reference audio not found: {source.name}")
            temp_ref = _normalise_reference(source)
            ref_audio = str(temp_ref)
            ref_text = _resolve_ref_text(source, str(payload.get("ref_text") or ""))
            if ref_text:
                # The cheap path. Passing the transcript means OmniVoice never
                # loads openai/whisper-large-v3-turbo (~1.5 GB) to transcribe a
                # reference we already know the words of.
                _log(f"ref_text supplied ({len(ref_text)} chars); skipping Whisper")
            else:
                # OmniVoice auto-transcribes here. Works, but it is the slow
                # path, so say so plainly in the log rather than hiding it.
                _log(
                    "no ref_text and no sidecar; OmniVoice will load Whisper "
                    "(openai/whisper-large-v3-turbo) and transcribe the reference"
                )
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
                # Whether this call gave OmniVoice the transcript, and so avoided
                # loading Whisper. False means the ~1.5 GB ASR path was taken.
                "refTextKnown": bool(ref_text),
                "whisperUsed": not bool(ref_text),
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
        if temp_ref is not None and not _is_protected(temp_ref, protected):
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
                "ref_text_known": _resolve_ref_text(source, str(payload.get("ref_text") or "")) is not None,
                "engine": "OmniVoice",
            }
        )
    finally:
        if temp is not None and not _is_protected(temp, protected):
            temp.unlink(missing_ok=True)


if __name__ == "__main__":
    import time as _time

    import uvicorn

    port = _env_int("OMNIVOICE_PORT", 8000)

    # Restart the server rather than dying on a transient accept failure.
    #
    # On Windows, asyncio's proactor loop raises WinError 64 ("the network name
    # is no longer available") from finish_accept when a client disconnects
    # mid-handshake. That exception is raised on the accept loop itself, so it
    # takes the listener down: the process stays alive holding 3.3 GB of model
    # and stops answering, with no error in the log to explain why. Observed
    # here during normal health polling.
    #
    # The model is loaded in S already and never reloaded by the restart, so
    # coming back costs a second or two rather than a 3.3 GB reload.
    attempt = 0
    while True:
        attempt += 1
        try:
            uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")
            break
        except KeyboardInterrupt:
            break
        except OSError as exc:
            wait = min(30, 2 ** min(attempt, 4))
            _log(f"server stopped ({exc}); restarting in {wait}s (attempt {attempt})")
            _time.sleep(wait)
        except Exception as exc:  # noqa: BLE001
            wait = min(30, 2 ** min(attempt, 4))
            _log(f"server crashed ({type(exc).__name__}: {exc}); restarting in {wait}s")
            _time.sleep(wait)

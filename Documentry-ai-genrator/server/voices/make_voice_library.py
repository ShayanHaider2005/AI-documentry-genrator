"""Build the default voice library: ten profiles across gender and accent.

Why this exists
---------------
The pipeline needs a narrator before anyone has uploaded a sample of their own.
Until now there was exactly one (a South Asian male). A user who wants a British
female has no way to ask for one, so this generates a small library and the app
lets them pick.

Each profile is a reference WAV plus the transcript of what was said, written to
server/voices/defaults/. The transcript is not optional: OmniVoice's cloning mode
wants ref_text as well as ref_audio, and supplying it skips loading
openai/whisper-large-v3-turbo (~1.5 GB) to transcribe audio whose words we
already know.

On the accents
--------------
OmniVoice's instruct vocabulary is a closed list, and it is worth being precise
about it. The English accents it accepts are exactly:

    american, australian, british, canadian, chinese, indian,
    japanese, korean, portuguese, russian        (each + " accent")

There is no "african accent". The library is therefore mapped onto accents that
genuinely exist, and the manifest records the real instruct string used for each
profile so the UI cannot claim an accent the audio does not have:

    indian  -> indian accent
    uk      -> british accent
    usa     -> american accent
    asian   -> chinese accent        (East/Southeast; japanese/korean also exist)
    other   -> portuguese accent    (the closest available to the Lusophone
                                     West African read this slot is named for)

Cost
----
Generation is a diffusion model, so on CPU each profile is minutes, not seconds.
The whole library is therefore built in one process with the model loaded once.
Existing files are skipped unless FORCE=1, so this is safe to re-run.

Run: server\\voice\\.venv\\Scripts\\python.exe server/voices/make_voice_library.py
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

import numpy as np
import soundfile as sf
import torch

HERE = Path(__file__).resolve().parent
OUT_DIR = HERE / "defaults"

MODEL_ID = os.environ.get("OMNIVOICE_MODEL", "k2-fsa/OmniVoice")
SR = 24000
NUM_STEP = int(os.environ.get("OMNIVOICE_NUM_STEP", "12"))
TORCH_THREADS = int(os.environ.get("OMNIVOICE_TORCH_THREADS", "4"))
GPU_MIN_FREE_GB = float(os.environ.get("OMNIVOICE_GPU_MIN_FREE_GB", "6") or 6)
MIN_SECONDS = 3.0
MIN_PEAK = 0.005

# Must stay identical to VOICE_SAMPLE_SENTENCES in server/tts.js, so a client
# recording these lines and these generated samples are interchangeable.
SENTENCES = [
    "The quality of a system is never an accident, it is engineered one careful "
    "decision at a time.",
    "Our team measured reliability across every release, and the numbers told a "
    "very clear story.",
    "Thank you for listening, and welcome to the next chapter of the story.",
]
TEXT = " ".join(SENTENCES)

# voice_id, display name, gender, accent key, real instruct
#
# `accent_key` is the UI grouping. `instruct` is the only thing the model is
# asked for, and it is recorded in the manifest so the label and the audio
# cannot drift apart.
PROFILES = [
    ("male_indian", "Arjun", "male", "indian", "male, indian accent, moderate pitch"),
    ("male_uk", "Oliver", "male", "uk", "male, british accent, moderate pitch"),
    ("male_usa", "Marcus", "male", "usa", "male, american accent, moderate pitch"),
    ("male_asian", "Wei", "male", "asian", "male, chinese accent, moderate pitch"),
    ("male_other", "Tiago", "male", "other", "male, portuguese accent, moderate pitch"),
    ("female_indian", "Priya", "female", "indian", "female, indian accent, moderate pitch"),
    ("female_uk", "Amelia", "female", "uk", "female, british accent, moderate pitch"),
    ("female_usa", "Eleanor", "female", "usa", "female, american accent, moderate pitch"),
    ("female_asian", "Mei", "female", "asian", "female, chinese accent, moderate pitch"),
    ("female_other", "Ines", "female", "other", "female, portuguese accent, moderate pitch"),
]

# Shown in the UI, and honest about what each slot really is.
ACCENT_LABELS = {
    "indian": "Indian (South Asian)",
    "uk": "UK",
    "usa": "USA",
    "asian": "Asian (East/Southeast)",
    # The model has no African accent. This slot is filled with the closest
    # accent it does have rather than mislabelling the audio.
    "other": "Other (Lusophone)",
}

MANIFEST = OUT_DIR / "manifest.json"


def log(message: str) -> None:
    print(f"[voices] {message}", flush=True)


def pick_device() -> tuple[str, torch.dtype]:
    if torch.cuda.is_available():
        try:
            free, _total = torch.cuda.mem_get_info()
            if free > GPU_MIN_FREE_GB * 1024**3:
                return "cuda:0", torch.float16
            log(f"GPU has {free / 1024 ** 3:.1f} GB free; too small. Using CPU.")
        except Exception:  # noqa: BLE001
            pass
    return "cpu", torch.float32


def main() -> int:
    force = bool(os.environ.get("FORCE"))
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    todo = [
        (vid, name, gender, key, instruct)
        for vid, name, gender, key, instruct in PROFILES
        if force or not (OUT_DIR / f"{vid}.wav").exists()
    ]

    if not todo:
        log("every profile already exists; nothing to do (FORCE=1 to rebuild)")
        write_manifest(existing_only=True)
        return 0

    log(f"{len(todo)} of {len(PROFILES)} profile(s) to generate")
    if len(todo) == len(PROFILES):
        minutes = len(todo) * 2.5
        log(
            f"on CPU this takes roughly {minutes:.0f} minutes in total "
            f"({NUM_STEP} steps, {TORCH_THREADS} threads). Let it finish."
        )

    torch.set_num_threads(max(1, TORCH_THREADS))

    device_map, dtype = pick_device()
    log(f"loading {MODEL_ID} on {device_map} ({dtype}); first run downloads ~3.3 GB")

    from omnivoice import OmniVoice

    t0 = time.time()
    model = OmniVoice.from_pretrained(MODEL_ID, device_map=device_map, dtype=dtype)
    log(f"model ready in {time.time() - t0:.1f}s")

    failures: list[str] = []
    for index, (vid, name, gender, key, instruct) in enumerate(todo, 1):
        log(f"({index}/{len(todo)}) {vid}: {instruct}")
        started = time.time()
        try:
            audio = model.generate(text=TEXT, instruct=instruct, num_step=NUM_STEP)
        except Exception as exc:  # noqa: BLE001
            log(f"  FAILED: {type(exc).__name__}: {exc}")
            failures.append(vid)
            continue

        if not audio:
            log("  FAILED: the model returned no audio")
            failures.append(vid)
            continue

        data = np.asarray(audio[0], dtype=np.float32)
        seconds = len(data) / SR
        peak = float(np.abs(data).max())
        elapsed = time.time() - started

        if seconds < MIN_SECONDS or peak < MIN_PEAK:
            log(f"  REJECTED: {seconds:.1f}s, peak {peak:.4f} - silent or too short")
            failures.append(vid)
            continue

        sf.write(str(OUT_DIR / f"{vid}.wav"), data, SR)
        (OUT_DIR / f"{vid}.txt").write_text(f"{TEXT}\n", encoding="utf-8")
        log(
            f"  wrote {vid}.wav  {seconds:.1f}s audio in {elapsed:.1f}s "
            f"(peak {peak:.3f})"
        )

    if failures:
        log(f"{len(failures)} profile(s) failed: {', '.join(failures)}")

    write_manifest()
    return 1 if failures else 0


def write_manifest(existing_only: bool = False) -> None:
    """Record each profile's file, label, and the instruct that produced it.

    The manifest is what the service and the UI read, so it is written from what
    is actually on disk rather than from what was intended. A profile whose WAV
    is missing is left out instead of being offered and then failing at render.
    """
    entries = []
    for vid, name, gender, key, instruct in PROFILES:
        audio = OUT_DIR / f"{vid}.wav"
        text = OUT_DIR / f"{vid}.txt"
        if not audio.exists():
            continue
        data, sr = sf.read(str(audio), dtype="float32")
        if data.ndim > 1:
            data = data.mean(axis=1)
        entries.append(
            {
                "voiceId": vid,
                "name": name,
                "gender": gender,
                "accent": key,
                "accentLabel": ACCENT_LABELS[key],
                "audioPath": f"server/voices/defaults/{vid}.wav",
                "refTextPath": f"server/voices/defaults/{vid}.txt",
                # Inlined so a caller never has to read two files, and so the
                # transcript cannot go missing while the manifest is used.
                "refText": text.read_text(encoding="utf-8").strip() if text.exists() else "",
                "instruct": instruct,
                "sampleRate": int(sr),
                "seconds": round(len(data) / SR, 2),
            }
        )

    payload = {
        "sampleRate": SR,
        "numStep": NUM_STEP,
        "referenceText": TEXT,
        "accents": ACCENT_LABELS,
        "note": (
            "OmniVoice's instruct vocabulary is closed and has no African accent; "
            "the 'other' slot is generated with the portuguese accent, which is the "
            "closest available. Each entry records the instruct actually used."
        ),
        "voices": entries,
    }
    MANIFEST.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    log(f"wrote {MANIFEST.name} with {len(entries)} profile(s)")
    if existing_only:
        log("nothing regenerated")


if __name__ == "__main__":
    sys.exit(main())

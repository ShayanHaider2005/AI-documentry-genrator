"""Generate the default South Asian narrator reference.

The pipeline needs a reference voice so a video can be produced before anyone
uploads a sample of their own. This builds one with OmniVoice's voice-design
mode, which needs no reference audio at all, and writes the matching transcript.

The transcript goes next to the audio because OmniVoice's cloning mode wants
`ref_text` as well as `ref_audio`. Here the two are guaranteed to agree, which
is the best case for clone quality.

On the name: there is no Pakistani English voice to copy, because the model
designs a voice from a description rather than copying a recorded speaker. The
prompt asks for an Indian English documentary narrator. Anything more specific
should come from a real recording, which is what the voice upload is for.

Run: server\\voice\\.venv\\Scripts\\python.exe server/voices/make_default_voice.py
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

import numpy as np
import soundfile as sf
import torch

HERE = Path(__file__).resolve().parent

MODEL_ID = os.environ.get("OMNIVOICE_MODEL", "k2-fsa/OmniVoice")
SR = 24000
GPU_MIN_FREE_GB = float(os.environ.get("OMNIVOICE_GPU_MIN_FREE_GB", "6"))

# Must stay identical to VOICE_SAMPLE_SENTENCES in server/tts.js, so that a
# client recording these lines and this generated sample are interchangeable.
SENTENCES = [
    "The quality of a system is never an accident, it is engineered one careful "
    "decision at a time.",
    "Our team measured reliability across every release, and the numbers told a "
    "very clear story.",
    "Thank you for listening, and welcome to the next chapter of the story.",
]
TEXT = " ".join(SENTENCES)

# The model's instruct vocabulary is a closed list. Valid English attributes:
#   male, female | child, teenager, young adult, middle-aged, elderly
#   very low pitch, low pitch, moderate pitch, high pitch, very high pitch
#   whisper
#   american, australian, british, canadian, indian, chinese, japanese,
#   korean, portuguese, russian  (each followed by " accent")
# There is no "pakistani accent" and no free-form style words, so anything
# outside this list is a hard error rather than a suggestion.
INSTRUCT = os.environ.get(
    "OMNIVOICE_DEFAULT_INSTRUCT",
    "male, indian accent, moderate pitch",
)

OUT_AUDIO = HERE / "south_asian_narrator.wav"
OUT_TEXT = HERE / "south_asian_narrator.txt"


def pick_device() -> tuple[str, torch.dtype]:
    if torch.cuda.is_available():
        try:
            free, _total = torch.cuda.mem_get_info()
            if free > GPU_MIN_FREE_GB * 1024**3:
                return "cuda:0", torch.float16
            print(f"GPU has {free / 1024 ** 3:.1f} GB free; too small. Using CPU.")
        except Exception:  # noqa: BLE001
            pass
    return "cpu", torch.float32


def main() -> int:
    if OUT_AUDIO.exists() and OUT_TEXT.exists() and not os.environ.get("FORCE"):
        print(f"[voices] {OUT_AUDIO.name} already exists. Set FORCE=1 to rebuild.")
        return 0

    device_map, dtype = pick_device()
    print(f"[voices] loading {MODEL_ID} on {device_map} ({dtype})")
    print("[voices] first run downloads ~3.3 GB and this is slow on CPU")

    from omnivoice import OmniVoice

    t0 = time.time()
    model = OmniVoice.from_pretrained(MODEL_ID, device_map=device_map, dtype=dtype)
    print(f"[voices] model ready in {time.time() - t0:.1f}s")

    print(f"[voices] instruct: {INSTRUCT}")
    t0 = time.time()
    audio = model.generate(text=TEXT, instruct=INSTRUCT)
    elapsed = time.time() - t0

    if not audio:
        print("[voices] the model returned no audio")
        return 1

    data = np.asarray(audio[0], dtype=np.float32)
    seconds = len(data) / SR
    peak = float(np.abs(data).max())
    print(
        f"[voices] generated {seconds:.1f}s of audio in {elapsed:.1f}s "
        f"(RTF {seconds / elapsed:.2f}), peak {peak:.3f}"
    )

    if seconds < 2.0 or peak < 0.005:
        print("[voices] the result is silent or far too short; not writing it")
        return 1

    sf.write(str(OUT_AUDIO), data, SR)
    OUT_TEXT.write_text(f"{TEXT}\n", encoding="utf-8")

    size_kb = OUT_AUDIO.stat().st_size // 1024
    print(f"[voices] wrote {OUT_AUDIO.name} ({size_kb} KB, {SR} Hz mono)")
    print(f"[voices] wrote {OUT_TEXT.name}")
    print("[voices] the service will use this automatically when no sample is uploaded")
    return 0


if __name__ == "__main__":
    sys.exit(main())

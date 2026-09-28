"""Is generated audio actually speech, or silence, hiss, or a stuck tone?

Three independent signals. Any one can be fooled by accident; all three
agreeing is convincing.

  1. Structure: real speech starts and ends in silence. A hum, a stuck tone or
     a codec fault runs continuously from sample 0 to the last one, with no
     quiet head or tail.
  2. Rate: 1.5-4 words per second is human. 20 is a buzz, 0.2 is a stall.
  3. Spectrum: most energy belongs below 4 kHz. Energy piled above 8 kHz is
     hiss.

Two things this deliberately does NOT test, both of which produced a false
alarm on audio that was in fact fine:

  - Zero-crossing rate. A 24 kHz signal has a much higher ZCR than the
    0.02-0.35 band usually quoted for speech, which is calibrated for ~8 kHz
    sample rates.
  - Envelope crest factor. Neural vocoders emit far more even loudness than a
    human recording; measured crest here was 1.7x, which is normal for TTS and
    would fail a threshold borrowed from human speech.

Usage:
    check-audio-quality.py <audio-dir> [--text "the words that were spoken"]
"""

import argparse
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

SILENCE_DB = -45.0  # below this a 40 ms frame counts as a pause
SPEECH_ENRICH_HZ = 4000
WORDS_PER_SECOND = (1.2, 4.0)
SILENCE_HEAD_TAIL = 0.08  # seconds of quiet required at each end
MAX_CLIPPED = 0.001  # fraction of samples at full scale


def count_words(text: str) -> int:
    return len([w for w in str(text).split() if w.strip()])


def frame_envelope(data: np.ndarray, sr: int) -> np.ndarray:
    """RMS per 40 ms frame, the standard resolution for speech envelopes."""
    frame = max(1, int(sr * 0.04))
    usable = len(data) // frame * frame
    if usable == 0:
        return np.array([float(np.sqrt((data**2).mean())) if data.size else 0.0])
    return np.sqrt((data[:usable].reshape(-1, frame) ** 2).mean(axis=1))


def check_clip(path: Path, words: int | None) -> tuple[bool, list[str]]:
    data, sr = sf.read(str(path), dtype="float32", always_2d=False)
    if data.ndim > 1:
        data = data.mean(axis=1)

    notes: list[str] = []
    ok = True
    seconds = len(data) / sr
    rms = float(np.sqrt((data.mean() ** 2))) if data.size else 0.0
    peak = float(np.abs(data).max()) if data.size else 0.0
    clipped = float((np.abs(data) > 0.99).mean()) if data.size else 0.0

    print(f"  file        {path.name}  ({path.stat().st_size / 1024:.0f} KB)")
    print(f"  format      {sr} Hz, mono, {seconds:.2f}s")
    print(f"  level       rms {rms:.4f}, peak {peak:.4f}, clipped {clipped * 100:.2f}%")

    # --- level: is anything there at all, and is it clean? ------------------
    if rms < 0.005:
        ok = False
        notes.append("FAIL effectively silent")
    elif clipped > MAX_CLIPPED:
        ok = False
        notes.append(f"FAIL {clipped * 100:.2f}% of samples clipped")
    else:
        notes.append(f"PASS audible (rms {rms:.4f}) and not clipped")

    # --- structure: silence at both ends means a bounded utterance ---------
    env = frame_envelope(data, sr)
    thresh = 10 ** (SILENCE_DB / 20)
    quiet = env <= thresh
    frame_s = 40 / 1000
    head = quiet[: int(SILENCE_HEAD_TAIL / frame_s)].all() if len(quiet) else False
    tail = quiet[-int(SILENCE_HEAD_TAIL / frame_s) :].all() if len(quiet) else False
    if not (head and tail):
        ok = False
        notes.append(
            f"FAIL no quiet head/tail (head={head}, tail={tail}) - "
            "continuous tone or codec fault, not a spoken utterance"
        )
    else:
        span = int((~quiet).sum() * frame_s)
        notes.append(f"PASS quiet head and tail, {span:.2f}s of speech inside")

    # --- rate: only meaningful when we know the words -----------------------
    if words:
        rate = words / seconds if seconds else 0.0
        lo, hi = WORDS_PER_SECOND
        if not (lo <= rate <= hi):
            ok = False
            notes.append(f"FAIL speech rate {rate:.2f} words/s, human range {lo}-{hi}")
        else:
            notes.append(f"PASS speech rate {rate:.2f} words/s for {words} words")
    else:
        notes.append("SKIP speech rate (no text supplied; pass --text)")

    # --- spectrum: voice vs hiss -------------------------------------------
    spec = np.abs(np.fft.rfft(data * np.hanning(len(data))))
    freqs = np.fft.rfftfreq(len(data), 1 / sr)
    total = float(spec.sum()) + 1e-12
    low = float(spec[freqs < SPEECH_ENRICH_HZ].sum()) / total
    hiss = float(spec[freqs >= 8000].sum()) / total

    if low < 0.40:
        ok = False
        notes.append(f"FAIL only {low * 100:.0f}% of energy below 4 kHz - not voice-like")
    else:
        notes.append(f"PASS {low * 100:.0f}% of energy below 4 kHz")
    if hiss > 0.55:
        ok = False
        notes.append(f"FAIL {hiss * 100:.0f}% of energy above 8 kHz - hiss")
    else:
        notes.append(f"PASS {hiss * 100:.0f}% above 8 kHz (not hiss)")

    return ok, notes


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("audio_dir", help="folder of scene-*.mp3 / scene-*.wav")
    parser.add_argument(
        "--text",
        help="the words actually spoken, for the speech-rate check",
    )
    args = parser.parse_args()

    out_dir = Path(args.audio_dir)
    clips = sorted(out_dir.glob("scene-*.mp3")) + sorted(out_dir.glob("scene-*.wav"))
    if not clips:
        print(f"no generated audio in {out_dir}")
        return 1

    words = count_words(args.text) if args.text else None

    print(f"\nchecking {len(clips)} clip(s) in {out_dir}")
    print(f"speech-rate reference: {words if words else 'none'}\n")

    failures = 0
    for clip in clips:
        ok, notes = check_clip(clip, words)
        for note in notes:
            print(f"  {note}")
        if not ok:
            failures += 1
        print()

    print("All clips are real speech." if failures == 0 else f"{failures} clip(s) failed.")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())

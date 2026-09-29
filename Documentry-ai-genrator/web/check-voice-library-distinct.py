"""Are the ten library voices actually ten different voices?

A generator that ignores its `instruct` would happily write ten files that sound
identical, and the picker would be a lie. This compares them two ways:

  * spectral fingerprint, averaged over the utterance, which catches a different
    accent or gender (different formants and pitch);
  * waveform correlation, which catches a literal duplicate.

The two together are what a listener would notice.
"""

import itertools
import json
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.path.insert(0, str(Path(__file__).resolve().parent))

import voiceprint  # noqa: E402  (needs the path set first)

# This file lives in web/, so the project root is one level up.
ROOT = Path(__file__).resolve().parent.parent
DEFAULTS = ROOT / "server" / "voices" / "defaults"
MANIFEST = DEFAULTS / "manifest.json"

failures = 0


def check(label, ok, detail=""):
    global failures
    print(f"   {'PASS' if ok else 'FAIL'}  {label}{f'  {detail}' if detail else ''}")
    if not ok:
        failures += 1


def main() -> int:
    if not MANIFEST.exists():
        print(f"   SKIP  no manifest at {MANIFEST}")
        return 0

    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    voices = manifest["voices"]

    audio = {}
    for voice in voices:
        path = DEFAULTS / f"{voice['voiceId']}.wav"
        data, sr = sf.read(str(path), dtype="float32")
        if data.ndim > 1:
            data = data.mean(axis=1)
        audio[voice["voiceId"]] = (data, sr)

    print(f"\n{len(audio)} voices\n")
    for voice in voices:
        data, sr = audio[voice["voiceId"]]
        seconds = len(data) / sr
        rms = float(np.sqrt((data**2).mean()))
        peak = float(np.abs(data).max())
        check(
            f"{voice['voiceId']:<15} {voice['accentLabel'][:22]:<22}",
            seconds > 3.0 and rms > 0.01 and peak < 0.999,
            f"{seconds:4.1f}s  rms {rms:.4f}  peak {peak:.3f}",
        )

    # --- what is actually worth measuring ---------------------------------
    #
    # Two earlier versions of this were wrong, and recording why matters more
    # than the numbers they produced:
    #
    #   1. A log-energy fingerprint over 24 bands, compared by cosine similarity,
    #      returned 0.9998 for every pair, including voices that are audibly
    #      nothing alike. Speech concentrates its energy in the same low bands
    #      whatever the speaker, so the measure saturated and separated nothing.
    #   2. Autocorrelation pitch detection read one male narrator at 100 Hz, then
    #      227 Hz, then 353 Hz as the detector was retuned. On real 24 kHz voice
    #      the estimate moved by more than an octave between parameter changes,
    #      so any per-voice pitch claim built on it was worthless.
    #
    # So this checks the things that are unambiguous and reports timbre without
    # asserting anything it cannot support:
    #   * the ten files are not duplicates of one another (waveform correlation,
    #     which needs no tuning parameter at all);
    #   * each is real audio at the right rate, length and level;
    #   * the spectral spread is wide enough to be ten voices, not one ten times.
    #
    # It deliberately does NOT claim to verify gender or accent. Whether the model
    # produced what the instruct asked for is a listening question, so the files
    # are handed over and the limit stated.
    print("\nspectral spread (descriptive only, not a gender or accent test):")
    print(f"{'voice':<16}{'centroid':>11}{'rolloff':>11}   label")
    print("-" * 60)

    centroids = {}
    for voice in voices:
        vid = voice["voiceId"]
        data, sr = audio[vid]
        c, r = voiceprint.fingerprint(data, sr)
        centroids[vid] = c
        print(f"{vid:<16}{c:>8.0f} Hz{r:>8.0f} Hz   {voice['gender']}")

    pairs = list(itertools.combinations(sorted(audio), 2))
    correlations = {}
    for a, b in pairs:
        n = min(len(audio[a][0]), len(audio[b][0]))
        xa = audio[a][0][:n].astype(np.float64)
        xb = audio[b][0][:n].astype(np.float64)
        xa -= xa.mean()
        xb -= xb.mean()
        denom = float(np.sqrt((xa**2).sum() * (xb**2).sum()))
        correlations[(a, b)] = float((xa * xb).sum() / denom) if denom else 0.0

    worst_pair = max(correlations, key=correlations.get)
    spread = max(centroids.values()) - min(centroids.values())

    print()
    print(
        f"highest waveform correlation: {worst_pair[0]} / {worst_pair[1]} "
        f"= {correlations[worst_pair]:.4f}"
    )
    print(
        f"spectral centroid spread:     {min(centroids.values()):.0f}-"
        f"{max(centroids.values()):.0f} Hz ({spread:.0f} Hz)"
    )

    check(
        "no two voices are byte-identical files",
        all(
            (DEFAULTS / f"{a}.wav").read_bytes() != (DEFAULTS / f"{b}.wav").read_bytes()
            for a, b in pairs
        ),
    )
    check(
        "no two voices are the same waveform (max correlation < 0.6)",
        max(correlations.values()) < 0.6,
        f"{worst_pair[0]} / {worst_pair[1]} = {max(correlations.values()):.4f}",
    )
    check(
        "the library spans a wide range of timbre (centroid spread > 500 Hz)",
        spread > 500,
        f"{spread:.0f} Hz",
    )
    check(
        "no voice is silent or clipped",
        all(
            float(np.sqrt((data**2).mean())) > 0.01 and float(np.abs(data).max()) < 0.999
            for data, _sr in audio.values()
        ),
    )

    print()
    print(
        "Not verified here: whether each clip really is the gender and accent its\n"
        "label claims. That needs listening. The files are in server/voices/defaults/."
    )
    print()
    print("All library voices are distinct." if failures == 0 else f"{failures} check(s) failed.")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())

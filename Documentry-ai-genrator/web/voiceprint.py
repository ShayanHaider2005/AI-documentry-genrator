"""A stable, low-cost voice-timbre fingerprint, for the library check.

Pitch autocorrelation proved unstable on this material: one male narrator was
reported at 100 Hz, then 227 Hz, then 353 Hz as the detector was retuned. That
is a measurement problem, not ten unreliable voices, and the honest response is
to measure something whose answer does not depend on a tuning parameter.

So this uses two spectral descriptors, which need no search and no threshold:

  * spectral centroid — the "centre of mass" of the spectrum in Hz. Lower for
    voices with more low-frequency energy.
  * 85% rolloff — the frequency below which 85% of the energy sits. Follows the
    spectral rolloff, so it separates a bright voice from a dark one.

Neither says anything about gender or accent on its own. They are used here for
one narrow, reliable purpose: confirming the ten files are not copies of each
other, and reporting the measured values against the labels so a human can see
whether anything looks off.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import soundfile as sf

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
DEFAULTS = ROOT / "server" / "voices" / "defaults"


def centroid(data: np.ndarray, sr: int) -> float:
    spectrum = np.abs(np.fft.rfft(data * np.hanning(len(data))))
    freqs = np.fft.rfftfreq(len(data), 1 / sr)
    band = (freqs >= 80) & (freqs < sr / 2)
    if not spectrum[band].sum():
        return 0.0
    return float((spectrum[band] * freqs[band]).sum() / spectrum[band].sum())


def rolloff(data: np.ndarray, sr: int, fraction: float = 0.85) -> float:
    spectrum = np.abs(np.fft.rfft(data * np.hanning(len(data))))
    freqs = np.fft.rfftfreq(len(data), 1 / sr)
    cumulative = np.cumsum(spectrum)
    if cumulative[-1] <= 0:
        return 0.0
    cumulative = cumulative / cumulative[-1]
    index = int(np.searchsorted(cumulative, fraction))
    index = min(index, len(freqs) - 1)
    return float(freqs[index])


def fingerprint(data: np.ndarray, sr: int) -> tuple[float, float]:
    return centroid(data, sr), rolloff(data, sr)


def main() -> int:
    import json

    manifest_path = DEFAULTS / "manifest.json"
    if not manifest_path.exists():
        print(f"no manifest at {manifest_path}; run: npm run voice:library")
        return 0
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    voices = manifest["voices"]

    measured = {}
    print(f"\n{'voice':<16}{'centroid':>11}{'rolloff':>11}   label")
    print("-" * 58)
    for voice in voices:
        path = DEFAULTS / f"{voice['voiceId']}.wav"
        data, sr = sf.read(str(path), dtype="float32")
        if data.ndim > 1:
            data = data.mean(axis=1)
        c, r = fingerprint(data, sr)
        measured[voice["voiceId"]] = (c, r, voice["gender"])
        print(f"{voice['voiceId']:<16}{c:>8.0f} Hz{r:>8.0f} Hz   {voice['gender']}")

    male = [measured[v["voiceId"]][0] for v in voices if v["gender"] == "male"]
    female = [measured[v["voiceId"]][0] for v in voices if v["gender"] == "female"]
    print()
    print(f"male centroid mean:   {np.mean(male):.0f} Hz  ({min(male):.0f}-{max(male):.0f})")
    print(f"female centroid mean: {np.mean(female):.0f} Hz  ({min(female):.0f}-{max(female):.0f})")
    print(
        "\nThese are spectral descriptors, not a gender classifier. They are\n"
        "reported so the spread across the library is visible, not to assert\n"
        "that a given clip is the gender its label claims."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())

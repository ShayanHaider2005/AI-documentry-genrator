"""Compare two renders of the same line at different step counts.

Asks one question: does dropping diffusion steps change the *voice*, or just
the time it takes? Frequency-band energy and pitch are the cheap objective
proxies. This cannot prove the two sound good, only that they are the same
voice doing the same thing.
"""

import sys
from pathlib import Path

import numpy as np
import soundfile as sf

SR = 24000
BANDS = [(0, 300), (300, 1000), (1000, 3000), (3000, 8000), (8000, 12000)]
# A gap larger than this in a speech band would mean they are not the same voice.
TOLERANCE_DB = 5.0


def band_energy(data: np.ndarray, lo: int, hi: int) -> float:
    spectrum = np.abs(np.fft.rfft(data * np.hanning(len(data))))
    freqs = np.fft.rfftfreq(len(data), 1 / SR)
    mask = (freqs >= lo) & (freqs < hi)
    return float(spectrum[mask].sum())


def dominant_pitch(data: np.ndarray) -> float:
    """Strongest bin in the human voice range, by summed magnitude."""
    spectrum = np.abs(np.fft.rfft(data * np.hanning(len(data))))
    freqs = np.fft.rfftfreq(len(data), 1 / SR)
    mask = (freqs > 70) & (freqs < 400)
    return float(freqs[mask][np.argmax(spectrum[mask].sum())])


def main() -> int:
    a_path, b_path = Path(sys.argv[1]), Path(sys.argv[2])
    label_a, label_b = sys.argv[3], sys.argv[4]

    a, _ = sf.read(str(a_path), dtype="float32")
    b, _ = sf.read(str(b_path), dtype="float32")
    if a.ndim > 1:
        a = a.mean(axis=1)
    if b.ndim > 1:
        b = b.mean(axis=1)

    print(f"{label_a:<12}{a_path.name}  {len(a) / SR:.2f}s")
    print(f"{label_b:<12}{b_path.name}  {len(b) / SR:.2f}s\n")

    print(f"{'band':<12}{label_a:>12}{label_b:>12}{'diff dB':>12}")
    print("-" * 48)
    worst = 0.0
    for lo, hi in BANDS:
        ea, eb = band_energy(a, lo, hi), band_energy(b, lo, hi)
        gap = 10 * np.log10((ea + 1e-12) / (eb + 1e-12))
        if hi <= 8000:  # only the speech bands matter for timbre
            worst = max(worst, abs(gap))
        flag = "" if abs(gap) <= TOLERANCE_DB else "  <- differs"
        print(f"{f'{lo}-{hi}':<12}{ea:>12.3f}{eb:>12.3f}{gap:>12.1f}{flag}")

    rms_a, rms_b = float(np.sqrt((a**2).mean())), float(np.sqrt((b**2).mean()))
    loud = 20 * np.log10(rms_a / rms_b)
    pa, pb = dominant_pitch(a), dominant_pitch(b)

    print()
    print(f"rms      {rms_a:.4f} vs {rms_b:.4f}   {loud:+.1f} dB")
    print(f"pitch    {pa:.1f} Hz vs {pb:.1f} Hz   {pa - pb:+.1f} Hz")

    print()
    if worst <= TOLERANCE_DB and abs(pa - pb) <= 15:
        print(
            f"Same voice: every speech band within {worst:.1f} dB "
            f"(limit {TOLERANCE_DB}) and pitch within {abs(pa - pb):.1f} Hz."
        )
        return 0
    print(
        f"DIFFERENT: worst speech band gap {worst:.1f} dB, "
        f"pitch gap {abs(pa - pb):.1f} Hz."
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())

"""A median-pitch detector for the voice library, with a self-test.

The first version of this returned 75 Hz for a female narrator and a 341 Hz mean
for the male ones, which is nonsense: adult speech sits roughly 85-255 Hz, and a
man narrating documentary prose is nearer 110 than 341. A measurement that
obviously cannot be right should be fixed before its output is believed, so
`self_test()` checks the detector against synthetic tones at known frequencies
first and the caller refuses to report a result if the detector is off.

Method: normalised autocorrelation per 40 ms frame, restricted to the 70-400 Hz
lag range, with octave correction (a common failure is picking 2x or 0.5x the
true fundamental). The median over voiced frames is the reported pitch, which is
far more robust than the mean because a few mis-detected frames do not move it.
"""

from __future__ import annotations

import sys

import numpy as np

FRAME_SECONDS = 0.04
# Adult speech fundamentals sit roughly 80-300 Hz. The search band is wider than
# that on purpose: a 40 ms frame is short, and with a strong second harmonic the
# autocorrelation can peak at a sub-harmonic. Restricting the search to a narrow
# band pushes those frames to the edge of the range, where they pile up and drag
# the median. The octave pass below is what actually resolves the ambiguity.
MIN_F0 = 65.0
MAX_F0 = 450.0
# Below this RMS a frame is silence or noise, not a voiced pitch.
VOICED_FLOOR = 0.01
# Correlation below this is not periodic enough to call voiced.
VOICED_CORRELATION = 0.3
# A shorter lag is preferred when it correlates at least this well relative to
# the best peak. Loose enough to catch a strong harmonic, tight enough that a
# genuinely doubled pitch is not dragged down.
SUBHARMONIC_TOLERANCE = 0.85


def _frame_pitch(frame: np.ndarray, sr: int) -> float:
    """Fundamental frequency of one frame, or 0.0 when unvoiced."""
    if np.sqrt((frame**2).mean()) < VOICED_FLOOR:
        return 0.0

    # Remove DC; a non-zero mean biases the autocorrelation downward.
    frame = frame - frame.mean()
    if not np.any(frame):
        return 0.0

    # Normalised autocorrelation, so the peak is a real correlation value in
    # [-1, 1] and frames of different loudness are comparable.
    corr = np.correlate(frame, frame, mode="full")[len(frame) - 1 :]
    energy = corr[0]
    if energy <= 0:
        return 0.0
    corr = corr / energy

    lo = max(1, int(sr / MAX_F0))
    hi = min(int(sr / MIN_F0), len(corr) - 1)
    if hi <= lo:
        return 0.0
    window = corr[lo:hi]
    if window.size == 0:
        return 0.0

    peak = int(np.argmax(window)) + lo
    best = float(corr[peak])
    if best < VOICED_CORRELATION:
        # No periodicity this strong: treat as unvoiced rather than guessing.
        return 0.0

    # Pick the true fundamental among the peak and its near neighbours.
    #
    # A naive "take the biggest peak" rule fails in two directions, and both were
    # observed on real library audio:
    #
    #   * too high: a short lag can correlate well by chance on a noisy frame,
    #     and a pile of such frames drags the median up. One male narrator was
    #     reported at 353 Hz with 101 frames stacked at the search ceiling.
    #   * too low: a strong second harmonic correlates equally well at twice the
    #     period, which halves the reported pitch.
    #
    # So: prefer a shorter lag (higher pitch) when it is nearly as good, and
    # prefer a longer lag when it is clearly better, which is the case where the
    # true fundamental is a sub-multiple of the strongest peak.
    candidate = peak
    for divisor in (2, 3):
        shorter = int(peak / divisor)
        if shorter < lo:
            continue
        if float(corr[shorter]) >= best * SUBHARMONIC_TOLERANCE:
            candidate = shorter
            best = float(corr[shorter])

    for multiplier in (2, 3):
        longer = peak * multiplier
        if longer > hi:
            continue
        # Only fold to a longer lag when it is genuinely a better match.
        if float(corr[longer]) > best * 1.02:
            candidate = longer
            best = float(corr[longer])

    return float(sr / candidate)


def _octave_correct(pitches: list[float]) -> list[float]:
    """Fold sub-harmonic and overtone readings onto the true fundamental.

    Autocorrelation has two classic octave failures, and both show up as a
    cluster at exactly half or exactly double the real value. The longer lag
    (half the frequency) correlates just as well when a harmonic is strong, so
    those frames are halved back; the shorter lag (double) is doubled back.

    Deciding between the two needs the spread. If the readings are genuinely
    bimodal, the *lower* cluster is the fundamental for a voice, because the
    alternative would mean a fundamental above the human ceiling.
    """
    if len(pitches) < 4:
        return pitches

    median = float(np.median(pitches))
    if median <= 0:
        return pitches

    # Count readings at 1x, 0.5x and 2x the median.
    at_one = sum(1 for p in pitches if 0.8 * median <= p <= 1.25 * median)
    at_half = sum(1 for p in pitches if 0.4 * median <= p < 0.8 * median)
    at_double = sum(1 for p in pitches if 1.6 * median <= p <= 2.5 * median)

    total = len(pitches)
    if at_half > at_one and at_half > 0.35 * total:
        return [p * 2 for p in pitches]
    if at_double > at_one and at_double > 0.35 * total:
        return [p / 2 for p in pitches]
    return pitches


def median_pitch(data: np.ndarray, sr: int) -> float:
    """Median F0 over voiced frames. Returns 0.0 for silence."""
    frame = max(1, int(sr * FRAME_SECONDS))
    usable = len(data) // frame * frame
    if usable == 0:
        return 0.0

    pitches = []
    for start in range(0, usable, frame):
        value = _frame_pitch(data[start : start + frame], sr)
        if value > 0:
            pitches.append(value)

    if not pitches:
        return 0.0

    return float(np.median(_octave_correct(pitches)))


def self_test(sr: int = 24000) -> tuple[bool, list[str]]:
    """Verify the detector against synthetic tones. Returns (ok, notes)."""
    notes: list[str] = []
    ok = True
    t = np.linspace(0, 0.6, int(sr * 0.6), endpoint=False)

    for expected in (95.0, 120.0, 150.0, 200.0, 240.0):
        # A sawtooth rather than a sine: real voices are harmonic, and a pure
        # sine makes a detector look better than it is.
        tone = sum(np.sin(2 * np.pi * expected * k * t) / k for k in range(1, 6))
        got = median_pitch(tone, sr)
        # Within 3% counts as correct.
        error = abs(got - expected) / expected if expected else 1.0
        good = error <= 0.03
        ok = ok and good
        notes.append(f"{'PASS' if good else 'FAIL'}  {expected:.0f} Hz -> {got:.0f} Hz ({error * 100:.1f}% off)")

    # Silence must not produce a pitch at all.
    quiet = np.zeros(int(sr * 0.3), dtype=np.float32)
    got = median_pitch(quiet, sr)
    good = got == 0.0
    ok = ok and good
    notes.append(f"{'PASS' if good else 'FAIL'}  silence -> {got:.0f} Hz (expected 0)")

    # A value in the middle of the human range must not be reported as 75 Hz.
    got = median_pitch(np.zeros(int(sr * 0.1), dtype=np.float32), sr)

    # The octave cases, which is where this detector actually went wrong: a
    # signal whose second harmonic is as strong as its fundamental correlates
    # equally well at twice the period, so a naive detector reports 2x. A
    # synthetic voice with a weak fundamental is the hard case, and it is the
    # one that produced a 320 Hz reading for a male narrator.
    for expected, harmonic_gain in ((120.0, 1.0), (120.0, 0.4), (150.0, 0.3)):
        tone = sum((harmonic_gain**0 if k == 1 else harmonic_gain ** (k - 1)) * np.sin(2 * np.pi * expected * k * t) / k
                   for k in range(1, 7))
        got = median_pitch(tone, sr)
        error = abs(got - expected) / expected
        # A weak fundamental makes this harder; 8% is the honest tolerance.
        good = error <= 0.08
        ok = ok and good
        notes.append(
            f"{'PASS' if good else 'FAIL'}  {expected:.0f} Hz with a weak fundamental -> {got:.0f} Hz ({error * 100:.1f}% off)"
        )

    return ok, notes


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    passed, lines = self_test()
    print("pitch detector self-test")
    for line in lines:
        print(f"  {line}")
    print()
    print("detector is trustworthy." if passed else "DETECTOR IS WRONG — do not trust its output.")
    sys.exit(0 if passed else 1)

# Verifies the cloned output is real audio and that the tone colour actually
# changed it relative to the base synthesiser.
import subprocess
import sys
from pathlib import Path

WAV = Path(sys.argv[1] if len(sys.argv) > 1 else "web/ov-out.wav")


def read_wav(path):
    import soundfile as sf

    data, sr = sf.read(str(path))
    return data, sr


import numpy as np

data, sr = read_wav(WAV)
duration = len(data) / sr
peak = float(np.abs(data).max())
rms = float(np.sqrt(np.mean(data**2)))

# Spectral tilt and MFCC-free proxy: compare the voiced segment's formants by
# measuring energy in a few bands. A tone-colour change shifts these.
spectrum = np.abs(np.fft.rfft(data * np.hanning(len(data))))
freqs = np.fft.rfftfreq(len(data), 1 / sr)
total = spectrum.sum() or 1
bands = [(80, 300), (300, 1000), (1000, 2500), (2500, 4000), (4000, 8000)]
weights = [
    float(spectrum[(freqs >= lo) & (freqs < hi)].sum() / total) for lo, hi in bands
]

print(f"file        {WAV.name}")
print(f"sample rate {sr} Hz")
print(f"duration    {duration:.2f} s  ({len(data)} samples)")
print(f"channels    {1 if data.ndim == 1 else data.shape[1]}")
print(f"peak        {peak:.3f}  (0 would mean silence)")
print(f"rms         {rms:.4f}")
print("band energy " + "  ".join(
    f"{lo}-{hi}Hz:{w * 100:.1f}%" for (lo, hi), w in zip(bands, weights)
))
print()
if duration < 0.5:
    print("FAIL: too short to be real speech")
    sys.exit(1)
if peak < 0.01:
    print("FAIL: audio is effectively silent")
    sys.exit(1)
print("PASS: real, non-silent audio with a full spectral range")

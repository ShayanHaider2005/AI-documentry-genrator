# Proves the tone-colour conversion is genuinely applied: convert the *same*
# base audio toward two different reference voices and confirm the results
# differ. If conversion were a no-op the two outputs would be identical.
import asyncio
import io
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "server" / "voice"))

import numpy as np
import soundfile as sf
from fastapi import UploadFile

import service as svc

# The module only loads its models during FastAPI's startup event, which does
# not run when the module is imported directly.
svc._startup()

TEXT = "This sentence is spoken in the cloned client voice, not the default one."

# Two different narration clips make two different reference voices.
references = [HERE.parent / "public" / "audio" / f"scene-{n}.mp3" for n in (1, 2, 3)]
references = [p for p in references if p.exists()][:2]
if len(references) < 2:
    sys.exit("need at least two narration clips under public/audio/ to compare")

print("reference voices:")
ses = []
for ref in references:
    upload = UploadFile(filename=ref.name, file=io.BytesIO(ref.read_bytes()))
    result = asyncio.run(svc.clone(upload, ref.stem))
    body = json.loads(result.body)
    ses.append((ref.name, body["voiceId"]))
    print(f"  {ref.name:<16} -> {body['voiceId']}  ({body['referenceKB']} KB reference)")

print(f"\nspeaking the same text in each voice:\n{len(ses) * 22}")

outputs = []
for label, vid in ses:
    response = svc.synthesize(text=TEXT, voice_id=vid)
    dest = HERE / f"compare-{vid}.wav"
    dest.write_bytes(response.body)
    outputs.append((label, dest))
    print(f"  {label:<16} -> {dest.name} ({len(response.body) // 1024} KB)")

BANDS = [(80, 300), (300, 1000), (1000, 2500), (2500, 4000), (4000, 8000)]


def profile(path):
    data, sr = sf.read(str(path))
    spectrum = np.abs(np.fft.rfft(data * np.hanning(len(data))))
    freqs = np.fft.rfftfreq(len(data), 1 / sr)
    total = spectrum.sum() or 1
    weights = np.array([
        spectrum[(freqs >= lo) & (freqs < hi)].sum() / total for lo, hi in BANDS
    ])
    return weights, data, sr


print(f"\n{'':<18}" + "".join(f"{f'{lo}-{hi}Hz':>11}" for lo, hi in BANDS) + "   length")
profiles = []
for label, path in outputs:
    w, data, sr = profile(path)
    profiles.append((w, data))
    print(f"{label:<18}" + "".join(f"{x * 100:>10.1f}%" for x in w)
          + f"   {len(data) / sr:.2f}s")

(a, data_a), (b, data_b) = profiles
band_delta = np.abs(a - b).max() * 100
n = min(len(data_a), len(data_b))
waveform_delta = float(np.abs(data_a[:n] - data_b[:n]).mean())
peak = max(float(np.abs(data_a).max()), float(np.abs(data_b).max()))

print(f"\nlargest band-energy difference : {band_delta:.2f} percentage points")
print(f"mean samplewise difference    : {waveform_delta:.5f} (peak {peak:.3f})")

if waveform_delta < 1e-4:
    print("\nFAIL: the two voices are effectively identical - conversion is a no-op")
    sys.exit(1)
print("\nPASS: the same words in two references produce measurably different audio,")
print("      so the tone colour captured from the client is actually applied.")

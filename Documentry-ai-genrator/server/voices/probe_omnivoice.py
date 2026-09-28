"""Standalone proof that OmniVoice loads and generates on this machine.

Downloads k2-fsa/OmniVoice (~3.3 GB) and produces one short clip two ways:
voice design (no reference) and voice cloning (reference + transcript).

Run: server\\voice\\.venv\\Scripts\\python.exe server\\voices\\probe_omnivoice.py
"""

import json
import sys
import time
from pathlib import Path

import numpy as np
import soundfile as sf
import torch

MODEL = "k2-fsa/OmniVoice"
OUT = Path(__file__).resolve().parent
SR = 24000

SAMPLE_TEXT = (
    "The quality of a system is never an accident, it is engineered one careful "
    "decision at a time."
)


def pick_device():
    if torch.cuda.is_available():
        free, _total = torch.cuda.mem_get_info()
        # The weights alone are ~3.3 GB. Only claim the GPU if it can hold them.
        if free > 6 * 1024**3:
            return "cuda:0", torch.float16
        print(f"[probe] GPU has {free / 1024**3:.1f} GB free; too small for a 3.3 GB model. Using CPU.")
    return "cpu", torch.float32


def report(label, audio, elapsed):
    data = np.asarray(audio[0], dtype=np.float32)
    peak = float(np.abs(data).max())
    rms = float(np.sqrt(np.mean(data**2)))
    seconds = len(data) / SR
    rtf = seconds / elapsed if elapsed > 0 else float("inf")
    print(
        f"[probe] {label}: {seconds:.2f}s audio in {elapsed:.1f}s "
        f"(RTF {rtf:.2f})  peak={peak:.3f} rms={rms:.4f}"
    )
    ok = seconds > 0.3 and peak > 0.01
    print(f"[probe] {label}: {'REAL AUDIO' if ok else 'SUSPECT (silent or too short)'}")
    return data, ok


def main():
    device_map, dtype = pick_device()
    print(f"[probe] device={device_map} dtype={dtype}")
    print(f"[probe] torch {torch.__version__}")

    print("[probe] loading model (this downloads ~3.3 GB on first run)...")
    t0 = time.time()
    model = OmniVoice.from_pretrained(MODEL, device_map=device_map, dtype=dtype)
    print(f"[probe] loaded in {time.time() - t0:.1f}s")

    results = {}

    # ---- 1. voice design: no reference audio at all -----------------------
    # The instruct vocabulary is a closed list. Valid English items:
    #   male, female | child, teenager, young adult, middle-aged, elderly
    #   very low/low/moderate/high/very high pitch | whisper
    #   american, australian, british, canadian, indian, chinese, japanese,
    #   korean, portuguese, russian accent
    # There is no "pakistani accent" and no free-form style words.
    print("\n[probe] === voice design ===")
    t0 = time.time()
    design = model.generate(text=SAMPLE_TEXT, instruct="male, indian accent, moderate pitch")
    data, ok = report("design", design, time.time() - t0)
    results["design"] = {"seconds": len(data) / SR, "ok": ok}
    sf.write(str(OUT / "probe_design.wav"), data, SR)

    # ---- 2. voice cloning: reference audio + its transcript ---------------
    print("\n[probe] === voice cloning ===")
    ref = OUT / "probe_design.wav"
    t0 = time.time()
    clone = model.generate(text=SAMPLE_TEXT, ref_audio=str(ref), ref_text=SAMPLE_TEXT)
    data, ok = report("clone", clone, time.time() - t0)
    results["clone"] = {"seconds": len(data) / SR, "ok": ok}
    sf.write(str(OUT / "probe_clone.wav"), data, SR)

    # The point of cloning is that it follows the reference. Compare the
    # spectral centroids: they should be in the same neighbourhood, and a
    # wildly different centroid would mean ref_audio was ignored.
    ref_data, _ = sf.read(str(ref), dtype="float32")
    ref_centroid = float(np.abs(np.fft.rfftfreq(len(ref_data), 1 / SR) * np.abs(np.fft.rfft(ref_data))).mean())
    clone_centroid = float(np.abs(np.fft.rfftfreq(len(data), 1 / SR) * np.abs(np.fft.rfft(data))).mean())
    ratio = clone_centroid / ref_centroid if ref_centroid else 0
    print(f"\n[probe] spectral centroid  reference={ref_centroid:.1f}  clone={clone_centroid:.1f}  ratio={ratio:.2f}")
    results["centroid_ratio"] = round(ratio, 3)

    (OUT / "probe_results.json").write_text(json.dumps(results, indent=2), encoding="utf-8")
    print("\n[probe] done ->", OUT / "probe_results.json")

    healthy = all(v.get("ok") for v in results.values() if isinstance(v, dict))
    sys.exit(0 if healthy else 1)


if __name__ == "__main__":
    from omnivoice import OmniVoice  # noqa: E402  (after torch, before main runs)

    main()

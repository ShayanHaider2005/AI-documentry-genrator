"""One-time setup for the local OmniVoice voice-cloning service.

    py -3 server/voice/setup.py

Creates a virtualenv, installs CPU-only PyTorch plus OmniVoice, and downloads the
k2-fsa/OmniVoice weights (~3.3 GB). Safe to re-run: every step is skipped when
its result is already present.

Replaces the retired OpenVoice v2 installer. Nothing from that stack is needed
any more — no MeloTTS clone, no tone-colour converter checkpoint, and no NLTK
corpora, because OmniVoice brings its own tokenizer and transcribes references
with Whisper.
"""

import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
VENV = HERE / ".venv"
MODEL_ID = os.environ.get("OMNIVOICE_MODEL", "k2-fsa/OmniVoice")

# The model is ~3.3 GB. Anything under this cannot hold it, so CUDA is skipped
# rather than failing later with an out-of-memory error.
GPU_MIN_FREE_GB = float(os.environ.get("OMNIVOICE_GPU_MIN_FREE_GB", "6"))


def run(cmd, cwd=None, timeout=3600, env=None):
    print(f"\n$ {' '.join(str(c) for c in cmd)}\n", flush=True)
    merged = {**os.environ, **(env or {})}
    return subprocess.run(
        [str(c) for c in cmd], cwd=cwd, timeout=timeout, env=merged
    ).returncode


def venv_python():
    return VENV / "Scripts" / "python.exe"


def step(title):
    print(f"\n{'=' * 60}\n== {title}\n{'=' * 60}", flush=True)


def install(py, *packages, binary=False, timeout=3600):
    cmd = [py, "-m", "pip", "install"]
    if binary:
        # Keep pip from falling back to an sdist build, which fails on Windows
        # without a compiler toolchain.
        cmd += ["--only-binary=:all:"]
    cmd += list(packages)
    return run(cmd, timeout=timeout)


def gpu_is_usable():
    """True when a CUDA GPU exists with enough free memory for the weights."""
    try:
        result = subprocess.run(
            [
                str(venv_python()),
                "-c",
                "import torch;"
                "print('yes' if torch.cuda.is_available() and "
                f"torch.cuda.mem_get_info()[0] > {GPU_MIN_FREE_GB * 1024 ** 3:.0f} else 'no')",
            ],
            capture_output=True,
            text=True,
            timeout=120,
        )
        return result.stdout.strip() == "yes"
    except Exception:  # noqa: BLE001
        return False


def torch_version(py):
    try:
        result = subprocess.run(
            [str(py), "-c", "import torch; print(torch.__version__)"],
            capture_output=True,
            text=True,
            timeout=120,
        )
        return result.stdout.strip()
    except Exception:  # noqa: BLE001
        return ""


def main():
    step("Virtualenv")
    if not venv_python().exists():
        print("Creating virtualenv...", flush=True)
        if run([sys.executable, "-m", "venv", str(VENV)]) != 0:
            sys.exit("venv creation failed")

    py = str(venv_python())
    install(py, "--upgrade", "pip", "setuptools", "wheel")

    step("PyTorch")
    # OmniVoice needs torch>=2.4 and torchaudio>=2.4. CPU-only avoids pulling a
    # multi-gigabyte CUDA runtime on machines that cannot use it.
    install(py, "torch>=2.4", "torchaudio>=2.4", binary=True)

    step("OmniVoice and audio stack")
    # soundfile is what the service reads references with and writes clips
    # through, so it is pinned explicitly rather than left to a transitive dep.
    rc = install(py, "omnivoice", "soundfile")
    if rc != 0:
        print("omnivoice failed to install; trying the source tree", flush=True)
        if run([py, "-m", "pip", "install", "git+https://github.com/k2-fsa/OmniVoice.git"]) != 0:
            sys.exit("could not install omnivoice")

    step("Retrieving the model")
    print(
        f"Downloading {MODEL_ID} (~3.3 GB). This is the slow part and only "
        f"happens once.",
        flush=True,
    )
    code = (
        "from huggingface_hub import snapshot_download;"
        f"print(snapshot_download('{MODEL_ID}'))"
    )
    if run([py, "-c", code], timeout=7200) != 0:
        print(
            "\nThe download did not finish. The service will retry on next "
            "start, so it is safe to continue.",
            flush=True,
        )

    step("Verifying")
    run([
        py,
        "-c",
        "import torch, soundfile; "
        "print('torch', torch.__version__); "
        "print('cuda available:', torch.cuda.is_available()); "
        "print('soundfile', soundfile.__version__)",
    ])
    run([py, "-c", "import omnivoice; print('omnivoice', omnivoice.__version__ if hasattr(omnivoice, '__version__') else 'ok')"])

    if gpu_is_usable():
        print("\nA CUDA GPU with enough memory was found; the service will use it.")
    else:
        print(
            f"\nNo GPU with at least {GPU_MIN_FREE_GB:.0f} GB free was found, so "
            "inference will run on CPU. Expect a noticeably slower first "
            "sentence: a diffusion TTS is compute-heavy without a GPU.",
        )

    print(f"\n{'=' * 60}")
    print("Setup complete. Start the service with:")
    print(f"  npm run voice:start")
    print("  (or just 'npm run web', which starts both services)")
    print("=" * 60)


if __name__ == "__main__":
    main()

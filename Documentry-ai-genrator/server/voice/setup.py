"""One-time setup for local OpenVoice v2 voice cloning.

    py -3 server/voice/setup.py

Creates a virtualenv, installs CPU-only PyTorch plus the OpenVoice / MeloTTS
stack, downloads the tone-colour converter and base speakers, and installs the
NLTK corpora that the English grapheme-to-phoneme step needs.

CPU-only throughout, so no multi-gigabyte CUDA runtime is downloaded. Safe to
re-run: every step is skipped if its result is already present.
"""

import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
VENV = HERE / ".venv"
OPENVOICE_REPO = HERE / "OpenVoice"
MELO_REPO = HERE / "MeloTTS"
CKPT = HERE / "checkpoints_v2"
NLTK_DATA = HERE / "nltk_data"

HF_REPO = "MyShell-ai/OpenVoiceV2"


def run(cmd, cwd=None, timeout=3600, env=None):
    print(f"\n$ {' '.join(str(c) for c in cmd)}\n", flush=True)
    merged = {**os.environ, **(env or {})}
    return subprocess.run(
        [str(c) for c in cmd], cwd=cwd, timeout=timeout, env=merged
    ).returncode


def venv_python():
    return VENV / "Scripts" / "python.exe"


def install(py, *packages, binary=False, timeout=3600):
    cmd = [py, "-m", "pip", "install"]
    if binary:
        # Prevents pip falling back to an sdist build, which fails on Windows
        # without a compiler toolchain.
        cmd += ["--only-binary=:all:"]
    cmd += list(packages)
    return run(cmd, timeout=timeout)


def step(title):
    print(f"\n{'=' * 60}\n== {title}\n{'=' * 60}", flush=True)


def copy_tree(src: Path, dest: Path):
    """Copy a directory tree without requiring an external tool."""
    import shutil

    shutil.copytree(src, dest, dirs_exist_ok=True)


def install_melotts(py):
    """MeloTTS is the base speaker OpenVoice converts.

    Neither PyPI nor `pip install git+...` works: the git package pins
    fugashi==1.3.0, whose PyPI metadata reports version 0.0.0, and the sdist
    declares no dependencies. So the repo is cloned and the pure-Python `melo`
    package is copied into site-packages directly, then its real dependencies
    are installed.
    """
    step("MeloTTS (base speaker)")

    if not (MELO_REPO / "melo" / "api.py").exists():
        run(["git", "clone", "--depth", "1",
             "https://github.com/myshell-ai/MeloTTS.git", str(MELO_REPO)])
    if not (MELO_REPO / "melo" / "api.py").exists():
        print("MeloTTS clone failed; synthesis will fall back to neural TTS.",
              flush=True)
        return

    code = (
        "import shutil, sysconfig;"
        f"shutil.copytree(r'{MELO_REPO / 'melo'}',"
        "sysconfig.get_paths()['purelib'] + '/melo', dirs_exist_ok=True)"
    )
    run([py, "-c", code])

    # MeloTTS imports these across all of its language modules at import time,
    # even though we only ever speak English.
    install(
        py,
        "cached_path", "fugashi>=1.5", "num2words", "transformers",
        "huggingface_hub", "cn2an", "jieba", "pypinyin", "unidecode",
        "anyascii", "jamo", "gruut", "g2p_en", "nltk", "inflect",
        "mecab-python3", "unidic-lite", "pykakasi",
    )
    # soundfile and librosa are imported by the audio path; numpy from a wheel so
    # pip does not attempt a source build.
    install(py, "--upgrade", "numpy", "soundfile", "librosa", binary=True)


def install_nltk_data(py):
    step("NLTK corpora")
    NLTK_DATA.mkdir(parents=True, exist_ok=True)
    # Behind a proxy, NLTK refuses to fetch unless this opt-in is set.
    env = {
        "NLTK_ALLOW_PROXIED_URLOPEN": "1",
        "NLTK_DATA": str(NLTK_DATA),
    }
    code = (
        "import nltk;"
        "nltk.pathsec.ALLOW_PROXIED_FETCH = True;"
        f"nltk.data.path.insert(0, r'{NLTK_DATA}');"
        "paks = ['averaged_perceptron_tagger_eng', 'cmudict', 'punkt_tab'];"
        f"[print(' ', p, '->', nltk.download(p, download_dir=r'{NLTK_DATA}',"
        " quiet=True)) for p in paks]"
    )
    run([py, "-c", code], env=env)


def download_checkpoints(py):
    step("Checkpoints (tone-colour converter + base speakers)")
    if (CKPT / "converter" / "checkpoint.pth").exists():
        print("already present", flush=True)
        return

    # The HuggingFace repo root *is* the checkpoint directory: it contains
    # converter/ and base_speakers/ directly, with no wrapping folder.
    install(py, "huggingface_hub")
    run([
        py, "-c",
        "from huggingface_hub import snapshot_download;"
        "print(snapshot_download(repo_id='MyShell-ai/OpenVoiceV2',"
        f"allow_patterns=['converter/*', 'base_speakers/*'], local_dir=r'{CKPT}'))",
    ], timeout=3600)

    # The base speaker's config ships with MeloTTS, not with the voice weights.
    speaker_config = MELO_REPO / "melo" / "configs" / "config.json"
    target = CKPT / "base_speakers" / "config.json"
    if speaker_config.exists() and not target.exists():
        copy_tree(speaker_config.parent, CKPT / "base_speakers")


def main():
    step("Virtualenv")
    if not venv_python().exists():
        if run([sys.executable, "-m", "venv", str(VENV)]) != 0:
            sys.exit("venv creation failed")

    py = str(venv_python())
    install(py, "--upgrade", "pip", "setuptools", "wheel")

    step("PyTorch (CPU only)")
    rc = install(
        py, "torch", "torchaudio",
        binary=True, timeout=3600,
    )
    if rc != 0:
        print("CPU torch wheel install failed; trying the default index.",
              flush=True)
        install(py, "torch", "torchaudio")

    step("OpenVoice")
    if not (OPENVOICE_REPO / "openvoice" / "api.py").exists():
        run(["git", "clone", "--depth", "1",
             "https://github.com/myshell-ai/OpenVoice.git", str(OPENVOICE_REPO)])

    # OpenVoice's own requirements, then the API server and the audio stack.
    req = OPENVOICE_REPO / "requirements.txt"
    if req.exists():
        install(py, "-r", str(req))
    install(py, "fastapi", "uvicorn[standard]", "python-multipart")
    install(py, "numpy", "soundfile", "librosa", "pydub", "wavmark",
            "eng_to_ipa", "faster-whisper", binary=True)
    # These are only needed to import, so keep them wheel-only.
    install(py, "pydantic", "anyio", "starlette", binary=True)

    install_melotts(py)
    install_nltk_data(py)
    download_checkpoints(py)

    step("Verifying")
    # Run the OpenVoice import from its own directory: the package resolves by
    # name, not as an installed distribution.
    run([py, "-c",
         "import numpy, torch, fastapi; "
         "print('numpy', numpy.__version__); "
         "print('torch', torch.__version__); "
         "print('fastapi ok')"])
    run([py, "-c", "import openvoice; print('openvoice ok')"],
        cwd=str(OPENVOICE_REPO))
    run([py, "-c", "import melo; print('melo ok')"])
    run([py, "-c", "import wavmark; print('wavmark ok')"])

    print(f"\n{'=' * 60}")
    print("Setup complete. Start the service with:")
    print(f"  {HERE / '.venv' / 'Scripts' / 'python.exe'} {HERE / 'service.py'}")
    if not os.environ.get("NLTK_ALLOW_PROXIED_URLOPEN"):
        print("\nIf you are behind a proxy, also set:")
        print("  NLTK_ALLOW_PROXIED_URLOPEN=1")
        print(f"  NLTK_DATA={NLTK_DATA}")
    print("=" * 60)


if __name__ == "__main__":
    main()

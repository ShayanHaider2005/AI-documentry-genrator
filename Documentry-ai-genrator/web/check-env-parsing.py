"""Exercise the env-var helpers against values that would otherwise crash.

The bug these guard against is real and has happened twice in this project: a
string multiplied by a number repeats instead of multiplying, and a bare
int() on an empty or malformed value refuses to start the service at all.
"""

import importlib.util
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = HERE.parent / "server" / "voice" / "server.py"

# Import just the helper functions without pulling in torch and the model.
source = SRC.read_text(encoding="utf-8")
start = source.index("def _env_number")
end = source.index("def _env_int")
helpers = source[start:end]
start2 = end
end2 = source.index("# CPU inference is the bottleneck")
helpers += source[start2:end2]

namespace = {"os": os}
exec(compile(helpers, "helpers", "exec"), namespace)
env_number = namespace["_env_number"]
env_int = namespace["_env_int"]
env_float = namespace["_env_float"]

CASES = [
    (None, 12, 6.0, "unset"),
    ("", 12, 6.0, "empty"),
    ("   ", 12, 6.0, "whitespace"),
    ("abc", 12, 6.0, "not a number"),
    ("12", 12, 6.0, "valid int"),
    ("8", 12, 6.0, "valid int 2"),
    ("6.5", 12, 6.0, "valid float"),
    ("0", 12, 6.0, "zero (falsy but valid)"),
]

failures = 0
print(f"{'value':<12} {'int':>10} {'float':>10}   note")
print("-" * 52)
for raw, di, df, note in CASES:
    if raw is None:
        os.environ.pop("PROBE", None)
    else:
        os.environ["PROBE"] = raw
    got_i = env_int("PROBE", di)
    got_f = env_float("PROBE", df)
    print(f"{raw!r:<12} {got_i:>10} {got_f:>10}   {note}")

    # An unusable value must fall back, never raise.
    try:
        stripped = None if raw is None else str(raw).strip()
        if not stripped:
            if got_i != di or got_f != df:
                print("   FAIL: did not fall back")
                failures += 1
        else:
            try:
                float(stripped)
            except ValueError:
                if got_i != di or got_f != df:
                    print("   FAIL: did not fall back")
                    failures += 1
            else:
                if got_f != float(stripped):
                    print(f"   FAIL: float expected {stripped}, got {got_f}")
                    failures += 1
                if got_i != int(float(stripped)):
                    print(f"   FAIL: int expected {int(float(stripped))}, got {got_i}")
                    failures += 1
    except Exception as exc:  # noqa: BLE001
        print(f"   FAIL: raised {type(exc).__name__}: {exc}")
        failures += 1

os.environ.pop("PROBE", None)

# The specific trap: a string multiplied by a number.
print()
blow_up = "6" * 1024**3
print(f"len('6' * 1024**3) = {len(blow_up):,} digits  <- the original bug")
print(f"len(6 * 1024**3)    = {len(str(6 * 1024**3)):,} digits  <- what we want")

print()
print("All env-helper checks passed." if failures == 0 else f"{failures} check(s) failed.")
sys.exit(0 if failures == 0 else 1)

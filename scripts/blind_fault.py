#!/usr/bin/env python3
"""Blind fault injection for human-baseline practice.

flagd watches infra/otel-demo/upstream/src/flagd/demo.flagd.json (bind-mounted into
the container), so changing a flag's defaultVariant there takes effect live.

  python3 scripts/blind_fault.py inject   # pick a random fault, don't tell me which
  python3 scripts/blind_fault.py reveal   # show what was injected and when
  python3 scripts/blind_fault.py reset    # turn every flag back off
  python3 scripts/blind_fault.py list     # show the candidate faults
"""
import json
import random
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FLAG_FILE = ROOT / "infra/otel-demo/upstream/src/flagd/demo.flagd.json"
SECRET = ROOT / ".blind_fault.json"  # gitignored

# Flags that work in minimal mode (no Kafka, no AI agent layer) and act like real
# incidents. Value = which variant to switch on.
CANDIDATES = {
    "adFailure": "on",
    "adHighCpu": "on",
    "cartFailure": "50%",
    "emailMemoryLeak": "100x",
    "imageSlowLoad": "5sec",
    "intlShippingSlowdown": "5sec",
    "paymentFailure": "50%",
    "paymentUnreachable": "on",
    "productCatalogFailure": "on",
    "productCatalogLockContention": "on",
    "recommendationCacheFailure": "on",
}


def load():
    return json.loads(FLAG_FILE.read_text())


def save(data):
    # Write in place (not temp file + rename): flagd watches this exact file through a
    # Docker bind mount, and a rename can break that watch on macOS.
    FLAG_FILE.write_text(json.dumps(data, indent=2) + "\n")


def reset(quiet=False):
    data = load()
    for flag in data["flags"].values():
        flag["defaultVariant"] = "off"
    save(data)
    if not quiet:
        print("All flags off.")


def inject():
    if SECRET.exists():
        sys.exit("A fault is already active. Run `reveal` or `reset` first.")
    reset(quiet=True)
    name, variant = random.choice(list(CANDIDATES.items()))
    data = load()
    data["flags"][name]["defaultVariant"] = variant
    save(data)
    SECRET.write_text(json.dumps({"flag": name, "variant": variant, "at": time.time()}))
    print("Fault injected. Start your timer and go find it.")


def reveal():
    if not SECRET.exists():
        sys.exit("No active blind fault.")
    s = json.loads(SECRET.read_text())
    mins = (time.time() - s["at"]) / 60
    print(f"It was {s['flag']} = {s['variant']} (injected {mins:.1f} min ago)")
    SECRET.unlink()  # deleting is fine here: it's our own scratch file


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "inject":
        inject()
    elif cmd == "reveal":
        reveal()
    elif cmd == "reset":
        reset()
        SECRET.unlink(missing_ok=True)
    elif cmd == "list":
        for k, v in CANDIDATES.items():
            print(f"{k} = {v}")
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()

"""Pre-built history (SRD §13 fallback for FR-16): four weeks of logger files,
made at build time by the same sensor-to-logger path, shipped compressed and
loaded straight into the logger store at start-up.

The files are tied to the exact code that generates them: a hash of the
generating modules. A runtime whose code hash differs refuses them and
generates its history itself.
"""
from __future__ import annotations

import hashlib
from pathlib import Path

GENERATING = ["config.py", "world.py", "truth.py", "sensors.py", "logger.py", "tap.py", "clock.py"]


def code_hash() -> str:
    here = Path(__file__).resolve().parent
    h = hashlib.sha256()
    for name in GENERATING:
        h.update(name.encode())
        h.update((here / name).read_bytes())
    return h.hexdigest()[:16]

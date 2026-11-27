"""The host clock (FR-14): the only module that reads it.

Real time stamps commands, status reports and captured messages (§9.1, interfaces §3); a stopwatch
measures how long an import took (FR-110). There is no simulation clock: replay is each display
client's own (4.7, D-220), and the 4.1 world and logger that a simulation clock stepped are retired
(plan Phase 8, D-320).
"""
from __future__ import annotations

import time


def perf() -> float:
    """A monotonic stopwatch, in seconds: how long an import took (FR-110). Never a time of day."""
    return time.perf_counter()


def real_seconds() -> float:
    """Real time, Unix seconds: the stamp on commands, status reports and captured messages (§9.1)."""
    return time.time()

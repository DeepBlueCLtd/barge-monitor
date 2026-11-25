"""The host clock (a port, SRD §2.2): real seconds, read here and nowhere else in the back end.

Real time paces the replay clock and stamps captured messages (docs/v4-interfaces.md §3, §4).
Tests pass a ``ManualClock`` instead.
"""
from __future__ import annotations

import time


def real() -> float:
    """Unix seconds now."""
    return time.time()


def perf() -> float:
    """A monotonic timer, for measuring (the importer's rows per second); never a timestamp."""
    return time.perf_counter()


class ManualClock:
    """A host clock set by hand (tests)."""

    def __init__(self, t: float = 1_795_000_000.0):
        self.t = float(t)

    def __call__(self) -> float:
        return self.t

    def advance(self, seconds: float) -> None:
        self.t += float(seconds)

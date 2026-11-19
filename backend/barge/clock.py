"""Simulation clock (B-C01): the single source of time (FR-11).

The clock is a port. ``SimClock`` is the real-time-or-accelerated
implementation; a replay clock can follow without a second code path. The
host's monotonic timer is read here and nowhere else, only to pace simulated
time, never as a timestamp.
"""
from __future__ import annotations

import time
from typing import Callable

from . import config as C


class SimClock:
    def __init__(self, start: float = 0.0, rate: float = C.CLOCK_DEFAULT_RATE,
                 host_seconds: Callable[[], float] = time.monotonic):
        self._host = host_seconds
        self._sim = float(start)
        self._rate = float(rate)
        self._last = self._host()

    def now(self) -> float:
        """Simulated seconds since the epoch, advancing at the current rate."""
        h = self._host()
        dt = max(0.0, h - self._last)
        self._last = h
        self._sim += min(dt * self._rate, C.MAX_TICK_SIM_S)
        return self._sim

    @property
    def rate(self) -> float:
        return self._rate

    def set_rate(self, rate: float) -> None:
        if rate not in C.CLOCK_RATES:
            raise ValueError(f"rate must be one of {C.CLOCK_RATES}")
        self.now()
        self._rate = float(rate)

    @staticmethod
    def statement() -> dict:
        """What the clock accepts, for the display to draw its controls (FR-34)."""
        return {
            "rates": C.CLOCK_RATES,
            "default_rate": C.CLOCK_DEFAULT_RATE,
            "unit": "simulated seconds per real second",
            "max_tick_simulated_seconds": C.MAX_TICK_SIM_S,
        }


class ManualClock:
    """A clock set by hand: for tests, and the shape replay will take."""

    def __init__(self, start: float = 0.0):
        self._sim = float(start)
        self._rate = 0.0

    def now(self) -> float:
        return self._sim

    def advance(self, seconds: float) -> None:
        self._sim += seconds

    @property
    def rate(self) -> float:
        return self._rate

    def set_rate(self, rate: float) -> None:
        if rate not in C.CLOCK_RATES:
            raise ValueError(f"rate must be one of {C.CLOCK_RATES}")
        self._rate = float(rate)

    statement = staticmethod(SimClock.statement)

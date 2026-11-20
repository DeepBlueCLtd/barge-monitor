"""Simulation clock (B-C01): the single source of time (FR-14, FR-52, FR-53).

The clock is a port. It starts **off**: nothing advances until play. The host
monotonic timer is read here and nowhere else in the backend, only to pace
simulated time, never as a timestamp.
"""
from __future__ import annotations

import time
from typing import Callable

from . import config as C


class SimClock:
    def __init__(self, start: float = 0.0, host_seconds: Callable[[], float] = time.monotonic):
        self._host = host_seconds
        self._sim = float(start)
        self._rate = C.CLOCK_DEFAULT_RATE
        self._playing = False
        self._last = self._host()

    def now(self) -> float:
        h = self._host()
        if self._playing:
            self._sim += max(0.0, h - self._last) * self._rate
        self._last = h
        return self._sim

    @property
    def rate(self) -> float:
        return self._rate

    @property
    def playing(self) -> bool:
        return self._playing

    def play(self) -> None:
        self.now()
        self._playing = True

    def pause(self) -> None:
        self.now()
        self._playing = False

    def set_rate(self, rate: float) -> None:
        if rate not in C.CLOCK_RATES:
            raise ValueError(f"rate must be one of {C.CLOCK_RATES}")
        self.now()
        self._rate = float(rate)

    def state(self) -> dict:
        return {"t": self.now(), "rate": self._rate, "playing": self._playing,
                "rates": C.CLOCK_RATES, "default_rate": C.CLOCK_DEFAULT_RATE}


class ManualClock:
    """Set by hand: for tests, and the shape replay will take."""

    def __init__(self, start: float = 0.0):
        self._sim = float(start)
        self._rate = C.CLOCK_DEFAULT_RATE
        self._playing = False

    def now(self) -> float:
        return self._sim

    def advance(self, seconds: float) -> None:
        self._sim += seconds

    rate = property(lambda self: self._rate)
    playing = property(lambda self: self._playing)

    def play(self):
        self._playing = True

    def pause(self):
        self._playing = False

    def set_rate(self, rate: float) -> None:
        if rate not in C.CLOCK_RATES:
            raise ValueError(f"rate must be one of {C.CLOCK_RATES}")
        self._rate = float(rate)

    def state(self) -> dict:
        return {"t": self._sim, "rate": self._rate, "playing": self._playing,
                "rates": C.CLOCK_RATES, "default_rate": C.CLOCK_DEFAULT_RATE}

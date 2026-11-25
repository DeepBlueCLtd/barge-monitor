"""Absolute UTC times, as the CSV files write them (docs/v4-interfaces.md §4).

Everything served is ISO 8601 UTC. Internally a time is Unix seconds (float). The world
(world.py, truth.py) counts from SIM_EPOCH_UNIX: world seconds = unix - SIM_EPOCH_UNIX.
"""
from __future__ import annotations

import numpy as np

from . import config as C


def iso(unix: float) -> str:
    """Whole seconds when the time is whole, milliseconds otherwise."""
    u = float(unix)
    if u == int(u):
        return str(np.datetime64(int(u), "s")) + "Z"
    return str(np.datetime64(int(round(u * 1000)), "ms")) + "Z"


def iso_many(t) -> list[str]:
    a = np.asarray(t, dtype=float)
    if not len(a):
        return []
    if np.all(a == np.floor(a)):
        return [s + "Z" for s in a.astype("int64").astype("datetime64[s]").astype(str).tolist()]
    return [s + "Z" for s in np.round(a * 1000).astype("int64").astype("datetime64[ms]").astype(str).tolist()]


def parse_iso(s: str) -> float:
    s = str(s).strip()
    if s.endswith("Z"):
        s = s[:-1]
    elif s.endswith("+00:00"):
        s = s[:-6]
    if "+" in s[10:] or (len(s) > 19 and "-" in s[19:]):
        raise ValueError(f"{s}: only UTC (Z) times are supported")
    return float(np.datetime64(s, "ms").astype("int64")) / 1000.0


def parse_many(values) -> np.ndarray:
    if not len(values):
        return np.empty(0)
    a = np.array([v[:-1] if v.endswith("Z") else v for v in values], dtype="datetime64[ms]")
    return a.astype("int64") / 1000.0


def world_seconds(unix):
    """World (truth) seconds for Unix seconds: what the referee scores against."""
    return np.asarray(unix, dtype=float) - C.SIM_EPOCH_UNIX

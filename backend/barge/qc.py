"""QARTOD quality flags, computed on import (FR-32): never by altering the files.

The range and spike checks of Version 4.1, unchanged, with CO₂ added (FR-09a).
Flags: 1 pass, 2 not evaluated (a variable wind direction), 3 suspect (spike),
4 fail (out of range), 9 missing.
"""
from __future__ import annotations

import numpy as np

QC_RANGE = {
    "air_temperature": (-30.0, 50.0), "relative_humidity": (0.0, 100.0), "pressure": (900.0, 1100.0),
    "apparent_wind_speed": (0.0, 60.0), "apparent_wind_direction": (0.0, 360.0),
    "solar_irradiance": (0.0, 1500.0), "water_temperature": (-2.0, 35.0), "co2": (250.0, 5000.0),
}
# A reading further than this from the mean of its two neighbours is suspect (QARTOD spike test).
QC_SPIKE = {"air_temperature": 0.8, "relative_humidity": 6.0, "pressure": 0.5, "apparent_wind_speed": 3.5,
            "solar_irradiance": 150.0, "water_temperature": 0.4, "co2": 60.0}
_TOKENS = np.array(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"], dtype=object)


def flags(name: str, v: np.ndarray, variable: np.ndarray | None = None) -> np.ndarray:
    """QARTOD flags as Category tokens ("1", "3", …) for one column of readings."""
    flag = np.full(len(v), 1, dtype=np.int8)
    lo, hi = QC_RANGE[name]
    with np.errstate(invalid="ignore"):
        flag[(v < lo) | (v > hi)] = 4
        if name in QC_SPIKE and len(v) >= 3:
            mid = 0.5 * (v[:-2] + v[2:])
            spike = np.abs(v[1:-1] - mid) > QC_SPIKE[name]
            core = flag[1:-1]
            core[spike & (core == 1)] = 3
    missing = np.isnan(v)
    if variable is not None:
        flag[variable] = 2
        missing &= ~variable
    flag[missing] = 9
    return _TOKENS[flag]

"""Quality control in the facade (FR-19): flags, never edits.

Raw values are passed through untouched; each parameter gains a companion
``<name>_qc`` flag, and positions a ``position_qc`` flag. Positions missing
because the receiver had no fix (inside the tunnel) are filled for the
coverage's domain by interpolation and flagged as such.
"""
from __future__ import annotations

import numpy as np

GOOD, SPIKE, RANGE, MISSING, VARIABLE = 0, 1, 2, 3, 4
QC_CATEGORIES = {"good": GOOD, "spike": SPIKE, "out-of-range": RANGE, "missing": MISSING, "variable": VARIABLE}
POS_FIX, POS_INTERPOLATED, POS_HELD = 0, 1, 2
POSITION_CATEGORIES = {"fix": POS_FIX, "interpolated": POS_INTERPOLATED, "held": POS_HELD}

# Declared QC configuration: plausible range, and the largest departure from
# the median of the five neighbouring readings that is not a spike.
QC_CONFIG = {
    "air_temperature": {"range": [-30.0, 50.0], "spike": 1.0},
    "relative_humidity": {"range": [0.0, 100.0], "spike": 8.0},
    "pressure": {"range": [900.0, 1100.0], "spike": 0.6},
    "apparent_wind_speed": {"range": [0.0, 60.0], "spike": 4.0},
    "apparent_wind_direction": {"range": [0.0, 360.0], "spike": None},
    "solar_irradiance": {"range": [0.0, 1500.0], "spike": 150.0},
    "water_temperature": {"range": [-2.0, 35.0], "spike": 0.5},
}
PAD = 2  # neighbours each side used by the spike test


def flags(name: str, values: np.ndarray, wd_code: np.ndarray | None = None) -> np.ndarray:
    """Flags for a padded slice; the caller trims PAD from each end."""
    cfg = QC_CONFIG[name]
    f = np.zeros(len(values), dtype=np.int8)
    lo, hi = cfg["range"]
    f[(values < lo) | (values > hi)] = RANGE
    if cfg["spike"] is not None and len(values) >= 2 * PAD + 1:
        w = np.lib.stride_tricks.sliding_window_view(values, 2 * PAD + 1)
        med = np.nanmedian(w, axis=1)
        dev = np.abs(values[PAD:-PAD] - med)
        core = f[PAD:-PAD]
        core[(dev > cfg["spike"]) & (core == GOOD)] = SPIKE
    missing = np.isnan(values)
    f[missing] = MISSING
    if wd_code is not None:
        f[wd_code == 1] = VARIABLE
    return f


def fill_positions(t: np.ndarray, lat: np.ndarray, lon: np.ndarray):
    """Fill missing fixes by interpolation in time; hold the last fix at the end."""
    ok = ~np.isnan(lat)
    flag = np.where(ok, POS_FIX, POS_INTERPOLATED).astype(np.int8)
    if ok.all() or not ok.any():
        if not ok.any():
            flag[:] = POS_HELD
        return lat.copy(), lon.copy(), flag
    lat_f = np.interp(t, t[ok], lat[ok])
    lon_f = np.interp(t, t[ok], lon[ok])
    last = np.flatnonzero(ok)[-1]
    first = np.flatnonzero(ok)[0]
    flag[last + 1:] = POS_HELD
    flag[:first] = POS_HELD
    return lat_f, lon_f, flag

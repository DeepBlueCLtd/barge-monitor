"""Store adapter (B-C06): the only code that understands the logger's format.

It reads the logger's files incrementally, consuming only complete records,
and builds the facade's own columnar index (FR-18a). The store is never
altered; the index can be dropped and rebuilt from the store at any time.

Everything above this module sees sensors as columns of floats keyed by
simulated time. Replacing the stand-in with another format (AT-03) means
replacing this module and nothing else.
"""
from __future__ import annotations

import numpy as np

from . import config as C
from . import logger as L

COLUMNS = [
    "t", "lat", "lon", "alt",
    "air_temperature", "relative_humidity", "pressure",
    "apparent_wind_speed", "apparent_wind_direction",
    "solar_irradiance", "water_temperature",
    "wd_code",  # 0 = a direction, 1 = VRB (too light), 2 = missing
]
SENSOR_OF_PREFIX = {v: k for k, v in L.FILE_PREFIX.items()}


class _Growable:
    def __init__(self, cap: int = 4096):
        self.a = np.empty(cap)
        self.n = 0

    def extend(self, x: np.ndarray) -> None:
        need = self.n + len(x)
        if need > len(self.a):
            cap = max(need, 2 * len(self.a))
            b = np.empty(cap)
            b[: self.n] = self.a[: self.n]
            self.a = b
        self.a[self.n:need] = x
        self.n = need

    def view(self) -> np.ndarray:
        return self.a[: self.n]


def _digits(block: np.ndarray) -> np.ndarray:
    """Fixed-width decimal digits (uint8 ASCII rows) to integers."""
    d = block.astype(np.int64) - 48
    w = block.shape[1]
    return d @ (10 ** np.arange(w - 1, -1, -1, dtype=np.int64))


def _field(rows: np.ndarray, name: str) -> np.ndarray:
    off, width = L.FIELDS[name]
    return rows[:, off:off + width]


def _plain(rows, name, scale=1.0):
    f = _field(rows, name)
    missing = (f == ord("/")).any(axis=1)
    safe = np.where(missing[:, None], ord("0"), f)
    v = _digits(safe).astype(float) / scale
    v[missing] = np.nan
    return v


def _metar(rows, name):
    f = _field(rows, name)
    missing = (f == ord("/")).any(axis=1)
    neg = f[:, 0] == ord("M")
    safe = f.copy()
    safe[neg, 0] = ord("0")
    safe = np.where(missing[:, None], ord("0"), safe)
    v = _digits(safe).astype(float) / 10.0
    v[neg] *= -1
    v[missing] = np.nan
    return v


def parse_records(data: bytes) -> dict[str, np.ndarray]:
    """Parse a block of complete records into columns."""
    rows = np.frombuffer(data, dtype=np.uint8).reshape(-1, L.REC_LEN)
    if not (rows[:, -1] == ord("\n")).all():
        raise ValueError("misaligned record block")
    ticks = _digits(_field(rows, "ticks"))
    t = ticks / L.TICKS_PER_SECOND + L.LOGGER_EPOCH_UNIX - C.SIM_EPOCH_UNIX
    g = _field(rows, "gps")
    # $GPGGA,hhmmss.ss, is 17 characters; an empty latitude means no fix.
    fix = g[:, 17] != ord(",")
    lat = np.full(len(rows), np.nan)
    lon = np.full(len(rows), np.nan)
    alt = np.full(len(rows), np.nan)
    if fix.any():
        gf = g[fix]
        lat_v = _digits(gf[:, 17:19]) + (_digits(gf[:, 19:21]) + _digits(gf[:, 22:26]) / 1e4) / 60.0
        lat_v = np.where(gf[:, 27] == ord("S"), -lat_v, lat_v)
        lon_v = _digits(gf[:, 29:32]) + (_digits(gf[:, 32:34]) + _digits(gf[:, 35:39]) / 1e4) / 60.0
        lon_v = np.where(gf[:, 40] == ord("W"), -lon_v, lon_v)
        alt_v = _digits(gf[:, 51:54]) + _digits(gf[:, 55:56]) / 10.0
        lat[fix], lon[fix], alt[fix] = lat_v, lon_v, alt_v
    wd_f = _field(rows, "apparent_wind_direction")
    vrb = wd_f[:, 0] == ord("V")
    wd_missing = (wd_f == ord("/")).any(axis=1)
    wd = _digits(np.where((vrb | wd_missing)[:, None], ord("0"), wd_f)).astype(float)
    wd[vrb | wd_missing] = np.nan
    return {
        "t": t,
        "lat": lat,
        "lon": lon,
        "alt": alt,
        "air_temperature": _metar(rows, "air_temperature"),
        "relative_humidity": _plain(rows, "relative_humidity"),
        "pressure": _plain(rows, "pressure", 10.0),
        "apparent_wind_speed": _plain(rows, "apparent_wind_speed", 10.0),
        "apparent_wind_direction": wd,
        "solar_irradiance": _plain(rows, "solar_irradiance"),
        "water_temperature": _metar(rows, "water_temperature"),
        "wd_code": np.where(vrb, 1.0, np.where(wd_missing, 2.0, 0.0)),
    }


class StoreAdapter:
    def __init__(self, logger: L.Logger):
        self.logger = logger
        self.reset()

    def reset(self) -> None:
        """Drop the index. The next refresh rebuilds it from the store."""
        self._offsets: dict[str, int] = {}
        self._cols = {s: {c: _Growable() for c in COLUMNS} for s in L.FILE_PREFIX}

    def refresh(self) -> int:
        """Consume complete records appended since the last refresh."""
        added = 0
        for name, size in self.logger.list_files():
            off = self._offsets.get(name, 0)
            if size <= off:
                continue
            data = self.logger.read(name, off)
            usable = len(data) - len(data) % L.REC_LEN
            # A trailing partial record stays for the next refresh.
            if usable and data[usable - 1:usable] != b"\n":
                cut = data.rfind(b"\n", 0, usable)
                usable = cut + 1
            if usable <= 0:
                continue
            cols = parse_records(data[:usable])
            sensor = SENSOR_OF_PREFIX[name.split("_")[0]]
            for c in COLUMNS:
                self._cols[sensor][c].extend(cols[c])
            self._offsets[name] = off + usable
            added += usable // L.REC_LEN
        return added

    def columns(self, sensor: str) -> dict[str, np.ndarray]:
        return {c: g.view() for c, g in self._cols[sensor].items()}

    def count(self, sensor: str) -> int:
        return self._cols[sensor]["t"].n

    def time_range(self, sensor: str):
        t = self._cols[sensor]["t"].view()
        if len(t) == 0:
            return None
        return float(t[0]), float(t[-1])

    def slice_by_time(self, sensor: str, t0: float, t1: float):
        """Index range [i0, i1) of records with t0 <= t <= t1 (time is sorted)."""
        t = self._cols[sensor]["t"].view()
        return int(np.searchsorted(t, t0, "left")), int(np.searchsorted(t, t1, "right"))

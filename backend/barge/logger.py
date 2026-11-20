"""The logger store (B-C05): a deliberately awkward, append-only store (FR-19).

* fixed-width text records, one file per sensor per day (``BOW_YYYYMMDD.DAT``,
  ``STN_YYYYMMDD.DAT``), rolling over at midnight UTC;
* time as a count of **half-seconds since 1994-01-01T00:00:00Z** (the logger's
  epoch), ten zero-padded digits;
* coded values: temperatures in tenths with ``M`` for minus (``M012`` is
  -1.2 °C), wind direction ``VRB`` when too light to have one, ``/`` filling a
  missing value, precipitation as a one-letter code (N, D, R, S);
* no index, and records are appended while being read: the logger flushes in
  chunks and holds back part of the last record.

FR-20: only the sensors write here and only the store adapter reads it. The
store carries on while the server restarts or is down.

Record layout (48 bytes including the newline)::

    0   10  ticks      half-seconds since the logger epoch
    11  1   status     A = normal
    13  4   air T      tenths °C, METAR sign
    18  3   RH         whole %
    22  5   pressure   tenths hPa
    28  3   wind speed tenths m/s (apparent)
    32  3   wind dir   whole degrees relative to bow, or VRB
    36  4   solar      whole W/m²
    41  4   water T    tenths °C, METAR sign
    46  1   precip     N none, D drizzle, R rain, S showers
"""
from __future__ import annotations

import datetime as _dt

import numpy as np

from . import config as C

LOGGER_EPOCH_UNIX = 757382400  # 1994-01-01T00:00:00Z
TICKS_PER_SECOND = 2
REC_LEN = 48
FILE_PREFIX = {"bow": "BOW", "stern": "STN"}
PRECIP_CODES = b"NDRS"
_FLUSH_HOLDBACK = 17

FIELDS = {  # name: (offset, width)
    "ticks": (0, 10),
    "status": (11, 1),
    "air_temperature": (13, 4),
    "relative_humidity": (18, 3),
    "pressure": (22, 5),
    "apparent_wind_speed": (28, 3),
    "apparent_wind_direction": (32, 3),
    "solar_irradiance": (36, 4),
    "water_temperature": (41, 4),
    "precipitation_type": (46, 1),
}


def sim_to_ticks(t_sim):
    return np.round((C.SIM_EPOCH_UNIX + np.asarray(t_sim, dtype=float) - LOGGER_EPOCH_UNIX) * TICKS_PER_SECOND).astype(np.int64)


def day_key(t_sim: float) -> str:
    d = _dt.datetime.fromtimestamp(C.SIM_EPOCH_UNIX + float(t_sim), tz=_dt.timezone.utc)
    return f"{d:%Y%m%d}"


def file_name(sensor: str, t_sim: float) -> str:
    return f"{FILE_PREFIX[sensor]}_{day_key(t_sim)}.DAT"


def _put_digits(out, off, width, v):
    v = np.asarray(v, dtype=np.int64)
    for k in range(width):
        out[:, off + width - 1 - k] = 48 + (v // 10 ** k) % 10


def _put_metar(out, off, x):
    """Tenths with M for minus; //// when missing."""
    missing = ~np.isfinite(x)
    n = np.round(np.where(missing, 0, x) * 10).astype(np.int64)
    neg = n < 0
    _put_digits(out, off, 4, np.clip(np.abs(n), 0, 9999))
    out[neg, off] = ord("M")
    a = np.clip(-n[neg], 0, 999)
    for k in range(3):
        out[np.flatnonzero(neg), off + 3 - k] = 48 + (a // 10 ** k) % 10
    out[missing, off:off + 4] = ord("/")


def _put_int(out, off, width, x, scale=1.0):
    missing = ~np.isfinite(x)
    n = np.clip(np.round(np.where(missing, 0, x) * scale), 0, 10 ** width - 1).astype(np.int64)
    _put_digits(out, off, width, n)
    out[missing, off:off + width] = ord("/")


def format_records(t, values: dict) -> bytes:
    """Fixed-width records for times t (whole seconds), vectorised."""
    n = len(t)
    out = np.full((n, REC_LEN), ord(" "), dtype=np.uint8)
    out[:, -1] = ord("\n")
    _put_digits(out, 0, 10, sim_to_ticks(t))
    out[:, 11] = ord("A")
    _put_metar(out, 13, values["air_temperature"])
    _put_int(out, 18, 3, values["relative_humidity"])
    _put_int(out, 22, 5, values["pressure"], 10.0)
    ws = values["apparent_wind_speed"]
    _put_int(out, 28, 3, ws, 10.0)
    wd = np.round(np.asarray(values["apparent_wind_direction"], dtype=float)) % 360
    _put_int(out, 32, 3, wd)
    vrb = np.isfinite(ws) & (ws < 0.5)
    out[vrb, 32:35] = np.frombuffer(b"VRB", dtype=np.uint8)
    _put_int(out, 36, 4, values["solar_irradiance"])
    _put_metar(out, 41, values["water_temperature"])
    out[:, 46] = np.frombuffer(PRECIP_CODES, dtype=np.uint8)[np.asarray(values["precipitation_type"], dtype=int)]
    return out.tobytes()


class Logger:
    """In-memory files, append-only. See the module docstring for the format."""

    def __init__(self):
        self._files: dict[str, bytearray] = {}
        self._held: dict[str, bytes] = {}

    def append(self, name: str, data: bytes) -> None:
        buf = self._files.setdefault(name, bytearray())
        data = self._held.pop(name, b"") + data
        if len(data) > _FLUSH_HOLDBACK:
            buf += data[:-_FLUSH_HOLDBACK]
            self._held[name] = data[-_FLUSH_HOLDBACK:]
        else:
            self._held[name] = data

    def close(self, name: str) -> None:
        """A file is complete (day rollover): write out anything held back."""
        if name in self._held:
            self._files[name] += self._held.pop(name)

    def list_files(self) -> list[tuple[str, int]]:
        return sorted((n, len(b)) for n, b in self._files.items())

    def read(self, name: str, offset: int = 0, end: int | None = None) -> bytes:
        return bytes(memoryview(self._files[name])[offset:end])

    def total_bytes(self) -> int:
        return sum(len(b) for b in self._files.values())

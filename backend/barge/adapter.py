"""Store adapter (C-03): the only code that understands the logger's format (FR-20).

It holds **its own index** over the store (FR-21): for every file, the time
of each complete record, so that a time range maps to a byte range. The store
is never altered. The index is dropped on every server start and rebuilt
from the store, a step at a time so the server can wait while it does
(FR-22, FR-47). Records are parsed only when asked for.

Replacing the logger with another format (AT-03) means replacing this module.
"""
from __future__ import annotations

import numpy as np

from . import config as C
from . import logger as L
from .tap import NULL, Tap

SENSOR_OF_PREFIX = {v: k for k, v in L.FILE_PREFIX.items()}
COLUMNS = ["t", "air_temperature", "relative_humidity", "pressure", "apparent_wind_speed",
           "apparent_wind_direction", "solar_irradiance", "water_temperature", "precipitation_type",
           "wd_variable"]


def _digits(block: np.ndarray) -> np.ndarray:
    d = block.astype(np.int64) - 48
    w = block.shape[1]
    return d @ (10 ** np.arange(w - 1, -1, -1, dtype=np.int64))


def _field(rows, name):
    off, width = L.FIELDS[name]
    return rows[:, off:off + width]


def _plain(rows, name, scale=1.0):
    f = _field(rows, name)
    missing = (f == ord("/")).any(axis=1)
    v = _digits(np.where(missing[:, None], ord("0"), f)).astype(float) / scale
    v[missing] = np.nan
    return v


def _metar(rows, name):
    f = _field(rows, name).copy()
    missing = (f == ord("/")).any(axis=1)
    neg = f[:, 0] == ord("M")
    f[neg, 0] = ord("0")
    v = _digits(np.where(missing[:, None], ord("0"), f)).astype(float) / 10.0
    v[neg] *= -1
    v[missing] = np.nan
    return v


def ticks_to_sim(ticks):
    return np.asarray(ticks) / L.TICKS_PER_SECOND + L.LOGGER_EPOCH_UNIX - C.SIM_EPOCH_UNIX


def parse_records(data: bytes) -> dict[str, np.ndarray]:
    rows = np.frombuffer(data, dtype=np.uint8).reshape(-1, L.REC_LEN)
    if len(rows) and not (rows[:, -1] == ord("\n")).all():
        raise ValueError("misaligned record block")
    wd_f = _field(rows, "apparent_wind_direction")
    vrb = wd_f[:, 0] == ord("V")
    wd_missing = (wd_f == ord("/")).any(axis=1)
    wd = _digits(np.where((vrb | wd_missing)[:, None], ord("0"), wd_f)).astype(float)
    wd[vrb | wd_missing] = np.nan
    pcode = _field(rows, "precipitation_type")[:, 0]
    precip = np.full(len(rows), np.nan)
    for i, c in enumerate(L.PRECIP_CODES):
        precip[pcode == c] = i
    return {
        "t": ticks_to_sim(_digits(_field(rows, "ticks"))),
        "air_temperature": _metar(rows, "air_temperature"),
        "relative_humidity": _plain(rows, "relative_humidity"),
        "pressure": _plain(rows, "pressure", 10.0),
        "apparent_wind_speed": _plain(rows, "apparent_wind_speed", 10.0),
        "apparent_wind_direction": wd,
        "solar_irradiance": _plain(rows, "solar_irradiance"),
        "water_temperature": _metar(rows, "water_temperature"),
        "precipitation_type": precip,
        "wd_variable": vrb.astype(float),
    }


class _FileIndex:
    def __init__(self, name):
        self.name = name
        self.sensor = SENSOR_OF_PREFIX[name.split("_")[0]]
        self.t = np.empty(0)
        self.bytes = 0  # complete records indexed


class StoreAdapter:
    def __init__(self, logger: L.Logger, tap: Tap = NULL):
        self.logger = logger
        self.tap = tap
        self.reset()

    # --- the index ---------------------------------------------------------
    def reset(self) -> None:
        """Drop the index. It is rebuilt from the store."""
        self._files: dict[str, _FileIndex] = {}

    def index_step(self, max_records: int = C.INDEX_CHUNK_RECORDS) -> bool:
        """Index up to max_records new complete records. True when up to date."""
        budget = max_records
        for name, size in self.logger.list_files():
            fi = self._files.get(name)
            if fi is None:
                fi = self._files[name] = _FileIndex(name)
            complete = size - size % L.REC_LEN
            if complete <= fi.bytes:
                continue
            take = min(complete - fi.bytes, budget * L.REC_LEN)
            data = self.logger.read(name, fi.bytes, fi.bytes + take)
            rows = np.frombuffer(data, dtype=np.uint8).reshape(-1, L.REC_LEN)
            fi.t = np.concatenate([fi.t, ticks_to_sim(_digits(_field(rows, "ticks")))])
            fi.bytes += take
            budget -= take // L.REC_LEN
            if budget <= 0:
                return False
        return True

    def refresh(self) -> None:
        """Bring the index up to date with records appended since."""
        while not self.index_step():
            pass

    def indexed_records(self) -> int:
        return sum(len(f.t) for f in self._files.values())

    def store_records(self) -> int:
        return sum(s // L.REC_LEN for _, s in self.logger.list_files())

    def time_range(self, sensor: str):
        files = [f for f in self._sorted(sensor) if len(f.t)]
        if not files:
            return None
        return float(files[0].t[0]), float(files[-1].t[-1])

    def _sorted(self, sensor):
        return [self._files[n] for n in sorted(self._files) if self._files[n].sensor == sensor]

    # --- reading ---------------------------------------------------------------
    def count(self, sensor: str, t0: float, t1: float) -> int:
        n = 0
        for f in self._sorted(sensor):
            if len(f.t) and f.t[0] <= t1 and f.t[-1] >= t0:
                n += int(np.searchsorted(f.t, t1, "right") - np.searchsorted(f.t, t0, "left"))
        return n

    def read(self, sensor: str, t0: float, t1: float, limit: int | None = None, offset: int = 0, quiet=False) -> dict:
        """Records with t0 <= t <= t1, oldest first, after skipping `offset`."""
        blocks = []
        want = limit if limit is not None else None
        skip = offset
        for f in self._sorted(sensor):
            if not len(f.t) or f.t[0] > t1 or f.t[-1] < t0:
                continue
            i0 = int(np.searchsorted(f.t, t0, "left"))
            i1 = int(np.searchsorted(f.t, t1, "right"))
            if skip:
                d = min(skip, i1 - i0)
                i0 += d
                skip -= d
            if want is not None:
                i1 = min(i1, i0 + want)
            if i1 <= i0:
                continue
            self.tap.emit("adapter", "store", "S", f"read {f.name} at byte {i0 * L.REC_LEN}, found through the index",
                          {"op": "read", "file": f.name, "offset": i0 * L.REC_LEN, "length": (i1 - i0) * L.REC_LEN,
                           "records": i1 - i0, "found_by": "index: time to file and offset"}, quiet=quiet)
            data = self.logger.read(f.name, i0 * L.REC_LEN, i1 * L.REC_LEN)
            self.tap.emit("store", "adapter", "L", f"{i1 - i0} records from {f.name}",
                          data[: L.REC_LEN * 3].decode("ascii") + ("…" if i1 - i0 > 3 else ""), quiet=quiet)
            blocks.append(parse_records(data))
            if want is not None:
                want -= i1 - i0
                if want <= 0:
                    break
        if not blocks:
            return {c: np.empty(0) for c in COLUMNS}
        return {c: np.concatenate([b[c] for b in blocks]) for c in COLUMNS}

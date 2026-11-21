"""A second, differently awkward logger store and the adapter that reads it (AT-03).

Nothing here ships: it exists to show that a different store changes the store
adapter and nothing else. Where the first logger writes fixed-width records in
daily files, this one writes:

* semicolon-separated lines of **variable length**, under a header line that
  every file repeats;
* one file per sensor per **hour**, in a folder per sensor
  (``bow/H0000123.csv``, numbered by hours since the logger was switched on);
* time as a **spreadsheet serial day number** (days since 1899-12-30, six
  decimals);
* temperatures in **hundredths of a kelvin**, pressure in **pascals**, wind
  speed in **centimetres per second**, direction ``-1`` when too light to have
  one, an **empty field** for a missing value, precipitation as a number.

An index of fixed record lengths is no use here: this adapter keeps the byte
offset of every line.
"""
from __future__ import annotations

import io

import numpy as np

from barge import config as C
from barge.adapter import COLUMNS
from barge.tap import NULL

SERIAL_EPOCH_UNIX = -2209161600  # 1899-12-30T00:00:00Z
HEADER = b"serial;T_cK;RH;P_Pa;WS_cms;WD;SOL;TW_cK;PR\n"
NAMES = ["air_temperature", "relative_humidity", "pressure", "apparent_wind_speed", "apparent_wind_direction",
         "solar_irradiance", "water_temperature", "precipitation_type"]


class Format:
    """How the second logger writes (the counterpart of ``barge.logger``'s functions)."""

    @staticmethod
    def file_name(sensor: str, t_sim: float) -> str:
        return f"{sensor}/H{int(t_sim // 3600):07d}.csv"

    def format_records(self, t, values: dict) -> bytes:
        def num(x, scale=1.0, offset=0.0):
            x = np.asarray(x, dtype=float)
            return ["" if not np.isfinite(v) else str(int(round(v * scale + offset))) for v in x]

        ws = np.asarray(values["apparent_wind_speed"], dtype=float)
        wd = np.round(np.asarray(values["apparent_wind_direction"], dtype=float)) % 360
        wd_txt = ["-1" if np.isfinite(s) and s < 0.5 else w for s, w in zip(ws, num(wd))]
        serial = (C.SIM_EPOCH_UNIX + np.asarray(t, dtype=float) - SERIAL_EPOCH_UNIX) / 86400.0
        cols = [[f"{s:.6f}" for s in serial],
                num(np.round(np.asarray(values["air_temperature"], dtype=float) * 10), 10, 27315),
                num(values["relative_humidity"]), num(np.round(np.asarray(values["pressure"], dtype=float) * 10), 10),
                num(np.round(ws * 10), 10), wd_txt, num(values["solar_irradiance"]),
                num(np.round(np.asarray(values["water_temperature"], dtype=float) * 10), 10, 27315),
                [str(int(p)) for p in values["precipitation_type"]]]
        # A chunk never crosses a file: the platform asks for the file by the chunk's first reading.
        # A file that starts on the hour starts with the header line.
        out = bytearray(HEADER if len(t) and int(t[0]) % 3600 == 0 else b"")
        for i in range(len(t)):
            out += (";".join(c[i] for c in cols) + "\n").encode()
        return bytes(out)


class _FileIndex:
    def __init__(self, name):
        self.name = name
        self.sensor = name.split("/")[0]
        self.t = np.empty(0)
        self.start = np.empty(0, dtype=np.int64)  # byte offset of each record's line
        self.end = 0  # bytes indexed: up to the last complete line


def serial_to_sim(serial):
    return np.round(np.asarray(serial, dtype=float) * 86400.0 + SERIAL_EPOCH_UNIX - C.SIM_EPOCH_UNIX)


def parse(data: bytes) -> dict:
    rows = np.genfromtxt(io.BytesIO(data), delimiter=";", dtype=float, filling_values=np.nan, ndmin=2) if data else np.empty((0, 9))
    wd = rows[:, 5].copy()
    vrb = wd == -1
    wd[vrb] = np.nan
    return {"t": serial_to_sim(rows[:, 0]), "air_temperature": (rows[:, 1] - 27315) / 100.0, "relative_humidity": rows[:, 2],
            "pressure": rows[:, 3] / 100.0, "apparent_wind_speed": rows[:, 4] / 100.0, "apparent_wind_direction": wd,
            "solar_irradiance": rows[:, 6], "water_temperature": (rows[:, 7] - 27315) / 100.0,
            "precipitation_type": rows[:, 8], "wd_variable": vrb.astype(float)}


class SecondStoreAdapter:
    """The same questions answered over the second store. Only this class knows its format."""

    def __init__(self, logger, tap=NULL):
        self.logger = logger
        self.tap = tap
        self.reset()

    def reset(self) -> None:
        self._files: dict[str, _FileIndex] = {}

    def index_step(self, max_records: int = C.INDEX_CHUNK_RECORDS) -> bool:
        budget = max_records
        for name, size in self.logger.list_files():
            fi = self._files.get(name)
            if fi is None:
                fi = self._files[name] = _FileIndex(name)
            if size <= fi.end:
                continue
            data = self.logger.read(name, fi.end, size)
            last = data.rfind(b"\n")
            if last < 0:
                continue  # only part of a line so far
            data = data[:last + 1]
            ends = np.flatnonzero(np.frombuffer(data, dtype=np.uint8) == 10) + 1
            starts = np.concatenate([[0], ends[:-1]])
            keep = np.array([not data[s:s + 6] == HEADER[:6] for s in starts])
            lines = b"".join(data[s:e] for s, e in zip(starts[keep], ends[keep]))
            fi.t = np.concatenate([fi.t, parse(lines)["t"]])
            fi.start = np.concatenate([fi.start, starts[keep] + fi.end])
            fi.end += len(data)
            budget -= int(keep.sum())
            if budget <= 0:
                return False
        return True

    def refresh(self) -> None:
        while not self.index_step():
            pass

    def indexed_records(self) -> int:
        return sum(len(f.t) for f in self._files.values())

    def store_records(self) -> int:
        return sum(self.logger.read(n).count(b"\n") - 1 for n, _ in self.logger.list_files())

    def _sorted(self, sensor):
        return [self._files[n] for n in sorted(self._files) if self._files[n].sensor == sensor]

    def time_range(self, sensor: str):
        files = [f for f in self._sorted(sensor) if len(f.t)]
        return (float(files[0].t[0]), float(files[-1].t[-1])) if files else None

    def count(self, sensor: str, t0: float, t1: float) -> int:
        return sum(int(np.searchsorted(f.t, t1, "right") - np.searchsorted(f.t, t0, "left")) for f in self._sorted(sensor) if len(f.t))

    def read(self, sensor: str, t0: float, t1: float, limit: int | None = None, offset: int = 0, quiet=False) -> dict:
        blocks, want, skip = [], limit, offset
        for f in self._sorted(sensor):
            if not len(f.t) or f.t[0] > t1 or f.t[-1] < t0:
                continue
            i0, i1 = int(np.searchsorted(f.t, t0, "left")), int(np.searchsorted(f.t, t1, "right"))
            if skip:
                d = min(skip, i1 - i0)
                i0 += d
                skip -= d
            if want is not None:
                i1 = min(i1, i0 + want)
            if i1 <= i0:
                continue
            a, b = int(f.start[i0]), int(f.start[i1]) if i1 < len(f.start) else f.end
            self.tap.emit("adapter", "store", "S", f"read {f.name} at byte {a}, found through the index",
                          {"op": "read", "file": f.name, "offset": a, "length": b - a, "records": i1 - i0,
                           "found_by": "index: time to file and offset"}, quiet=quiet)
            data = self.logger.read(f.name, a, b)
            self.tap.emit("store", "adapter", "L", f"{i1 - i0} records from {f.name}", data[:160].decode("ascii"), quiet=quiet)
            blocks.append(parse(data))
            if want is not None:
                want -= i1 - i0
                if want <= 0:
                    break
        if not blocks:
            return {c: np.empty(0) for c in COLUMNS}
        return {c: np.concatenate([b[c] for b in blocks]) for c in COLUMNS}

"""Resources the models create, and the observations they publish (FR-28).

The registry is the data server's own store of created resources: systems,
datastreams, control streams, commands and observations. Like a real server's
database it outlives server restarts (decision D-11). Field toggles never
touch it: the server applies the offering when it serves (fields.py).

Observations are kept as columns: numeric fields as float arrays (NaN for a
missing value), everything else as object arrays. Nothing is dropped: the
server keeps no account of who has read what (FR-06).
"""
from __future__ import annotations

import numpy as np

NUMERIC = {"Quantity", "Count", "Boolean"}


class Series:
    """Append-only columns ordered by time."""

    def __init__(self, fields: list[dict]):
        self.types = {f["name"]: f["type"] for f in fields if f["name"] != "time"}
        self.t = np.empty(0)
        self.cols: dict[str, np.ndarray] = {n: self._empty(ty) for n, ty in self.types.items()}

    def __len__(self):
        return len(self.t)

    @staticmethod
    def _empty(ty):
        return np.empty(0) if ty in NUMERIC else np.empty(0, dtype=object)

    def clear(self):
        self.t = np.empty(0)
        self.cols = {n: self._empty(ty) for n, ty in self.types.items()}

    def append(self, cols: dict) -> int:
        t = np.asarray(cols["t"], dtype=float)
        if not len(t):
            return 0
        keep = t >= self.t[-1] if len(self.t) else np.ones(len(t), bool)  # equal times allowed: two runs in one second
        idx = np.flatnonzero(keep)
        if not len(idx):
            return 0
        self.t = np.concatenate([self.t, t[idx]])
        for n, ty in self.types.items():
            v = cols.get(n)
            if ty in NUMERIC:
                arr = np.full(len(t), np.nan) if v is None else np.asarray(v, dtype=float)
                self.cols[n] = np.concatenate([self.cols[n], arr[idx]])
            else:
                arr = np.full(len(t), None, dtype=object) if v is None else np.asarray(list(v) if not isinstance(v, np.ndarray) else v, dtype=object)
                self.cols[n] = np.concatenate([self.cols[n], arr[idx]])
        return int(len(idx))

    def range(self, t0: float, t1: float) -> tuple[int, int]:
        return int(np.searchsorted(self.t, t0, "left")), int(np.searchsorted(self.t, t1, "right"))

    def slice(self, i0: int, i1: int, names=None) -> dict:
        out = {"t": self.t[i0:i1]}
        for n in (names if names is not None else self.cols):
            if n in self.cols:
                c = self.cols[n]
                out[n] = c[i0:i1]
        return out


class Registry:
    """Created resources. Keys are stable (system:name); public ids carry a schema hash."""

    def __init__(self):
        self.systems: dict[str, dict] = {}  # id -> system
        self.datastreams: dict[str, dict] = {}  # key -> {key, system, outputName, name, schema, series}
        self.controlstreams: dict[str, dict] = {}  # key -> {key, system, inputName, name, schema}
        self.commands: dict[str, dict] = {}  # id -> command
        self.command_seq = 0

    def system_id_for(self, unique_id: str) -> str:
        """A readable id from the uniqueId's last part, made unique."""
        base = unique_id.rsplit(":", 1)[-1] or "system"
        sid, n = base, 1
        while sid in self.systems:
            n += 1
            sid = f"{base}-{n}"
        return sid

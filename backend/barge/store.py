"""The data server's store: systems, datastreams, control streams, commands and observations.

Like OpenSensorHub's database it outlives a server restart; only Reset instance empties it
(FR-50a). Identifiers are **opaque** (four base-32 characters, like OpenSensorHub's `040g`):
nobody may rely on them; clients find everything by uniqueId and outputName (§6).

Observations are kept as columns: numeric fields as float arrays (NaN for a missing value),
everything else as object arrays; times as Unix seconds. Each observation also has a result
time and an insertion sequence: ``resultTime=latest`` is the last one inserted.

The server applies **no permission per system**, as OpenSensorHub behind the access gateway
(§9.5): restriction is the gateway's (``gateway.py``).
"""
from __future__ import annotations

import asyncio
import itertools

import numpy as np

from . import accounts as A  # noqa: F401 - Subscription's account
from .swe import NUMERIC

B32 = "0123456789abcdefghijklmnopqrstuv"
URN = "urn:x-barge:"


def _b32(n: int) -> str:
    return "".join(B32[(n >> (5 * i)) & 31] for i in (3, 2, 1, 0))


class Ids:
    """Opaque, deterministic identifiers: a scrambled counter per kind."""

    def __init__(self):
        self.n = {}

    def next(self, kind: str) -> str:
        k = self.n.get(kind, 0) + 1
        self.n[kind] = k
        off = {"system": 4, "datastream": 9001, "controlstream": 17011, "command": 23023, "status": 29021}.get(kind, 0)
        return _b32((k * 7919 + off) % (32 ** 4))


class Series:
    """Append-only observations of one datastream, ordered by phenomenon time on reading."""

    def __init__(self, fields: list[dict]):
        self.types = {f["name"]: f["type"] for f in fields if f["name"] != "time"}
        self.t = np.empty(0)
        self.rt = np.empty(0)  # result time
        self.seq = np.empty(0, dtype=np.int64)
        self.cols: dict[str, np.ndarray] = {n: self._empty(ty) for n, ty in self.types.items()}
        self._pending: list[dict] = []
        self._rows: list[tuple] = []  # single observations not yet consolidated

    def __len__(self):
        self._flush()
        return len(self.t)

    @staticmethod
    def _empty(ty):
        return np.empty(0) if ty in NUMERIC or ty == "Time" else np.empty(0, dtype=object)

    def append_cols(self, cols: dict, seq0: int) -> int:
        """Columns {t, rt?, field: array}. Returns the number of observations."""
        self._flush_rows()
        n = len(cols["t"])
        if n:
            self._pending.append({**cols, "seq": np.arange(seq0, seq0 + n, dtype=np.int64)})
        return n

    def append_row(self, t: float, rt: float, values: dict, seq: int) -> None:
        self._rows.append((t, rt, seq, values))

    def _flush_rows(self):
        if not self._rows:
            return
        rows, self._rows = self._rows, []
        cols = {"t": np.array([r[0] for r in rows], dtype=float), "rt": np.array([r[1] for r in rows], dtype=float),
                "seq": np.array([r[2] for r in rows], dtype=np.int64)}
        for n, ty in self.types.items():
            vals = [r[3].get(n) for r in rows]
            if ty in NUMERIC or ty == "Time":
                cols[n] = np.array([np.nan if v is None else v for v in vals], dtype=float)
            else:
                a = np.empty(len(vals), dtype=object)
                a[:] = vals
                cols[n] = a
        self._pending.append(cols)

    def _flush(self):
        self._flush_rows()
        if not self._pending:
            return
        blocks, self._pending = self._pending, []
        prev_max = self.t[-1] if len(self.t) else -np.inf
        ts = [self.t] + [np.asarray(b["t"], dtype=float) for b in blocks]
        self.t = np.concatenate(ts)
        self.rt = np.concatenate([self.rt] + [np.asarray(b.get("rt", b["t"]), dtype=float) for b in blocks])
        self.seq = np.concatenate([self.seq] + [b["seq"] for b in blocks])
        for n, ty in self.types.items():
            parts = [self.cols[n]]
            for b in blocks:
                v = b.get(n)
                m = len(b["t"])
                if v is None:
                    v = np.full(m, np.nan) if (ty in NUMERIC or ty == "Time") else np.full(m, None, dtype=object)
                parts.append(np.asarray(v, dtype=float) if (ty in NUMERIC or ty == "Time") else np.asarray(v, dtype=object))
            self.cols[n] = np.concatenate(parts)
        if any(len(b["t"]) and (np.min(b["t"]) < prev_max or np.any(np.diff(b["t"]) < 0)) for b in blocks):
            order = np.argsort(self.t, kind="stable")
            self.t, self.rt, self.seq = self.t[order], self.rt[order], self.seq[order]
            for n in self.cols:
                self.cols[n] = self.cols[n][order]

    def range(self, t0: float, t1: float) -> tuple[int, int]:
        self._flush()
        return int(np.searchsorted(self.t, t0, "left")), int(np.searchsorted(self.t, t1, "right"))

    def latest(self) -> int | None:
        self._flush()
        return int(np.argmax(self.seq)) if len(self.seq) else None

    def span(self):
        self._flush()
        return (float(self.t[0]), float(self.t[-1])) if len(self.t) else None

    def take(self, idx, names=None) -> dict:
        self._flush()
        out = {"t": self.t[idx], "rt": self.rt[idx]}
        for n in (names if names is not None else self.cols):
            if n in self.cols:
                out[n] = self.cols[n][idx]
        return out


class Store:
    """Created resources. Everything is kept until Reset instance."""

    def __init__(self):
        self.ids = Ids()
        self.systems: dict[str, dict] = {}
        self.datastreams: dict[str, dict] = {}
        self.boot = 0  # the server start that is running; a datastream notes the start that last declared it
        self.controlstreams: dict[str, dict] = {}
        self.commands: dict[str, dict] = {}
        self.status_reports: dict[str, list] = {}  # control stream id -> reports
        self.seq = itertools.count(1)

    # --- systems ------------------------------------------------------------------
    def system_by_uid(self, uid: str) -> dict | None:
        return next((s for s in self.systems.values() if s["uid"] == uid), None)

    def add_system(self, uid, label, description="", feature="sosa:System", asset="Equipment", parent=None,
                   owner=None, restricted=False, workspace_of=None, characteristics=None) -> tuple[dict, bool]:
        """The system with this uniqueId: (system, created)."""
        old = self.system_by_uid(uid)
        if old is not None:
            return old, False
        sid = self.ids.next("system")
        s = {"id": sid, "uid": uid, "label": label, "description": description, "feature": feature, "asset": asset,
             "parent": parent, "owner": owner, "restricted": restricted, "workspace_of": workspace_of,
             "characteristics": dict(characteristics or {})}
        self.systems[sid] = s
        return s, True

    def system_list(self) -> list[dict]:
        return list(self.systems.values())

    def ancestors(self, sid: str) -> list[dict]:
        out, cur = [], self.systems.get(sid)
        while cur is not None:
            out.append(cur)
            cur = self.systems.get(cur["parent"]) if cur["parent"] else None
        return out

    # --- datastreams and control streams --------------------------------------------
    def add_datastream(self, system_id, output, name, schema, owner=None) -> tuple[dict, bool]:
        """201 semantics: the same outputName with the same fields is the one already there; a different
        schema makes a new datastream with a new id, and the old one is no longer listed (FR-51)."""
        names = [f["name"] for f in schema["fields"]]
        for d in self.datastreams.values():
            if d["system"] == system_id and d["outputName"] == output and not d["replaced"]:
                if [f["name"] for f in d["schema"]["fields"]] == names and \
                        [f["type"] for f in d["schema"]["fields"]] == [f["type"] for f in schema["fields"]]:
                    d["declared_at_boot"] = self.boot
                    return d, False
                d["replaced"] = True
        did = self.ids.next("datastream")
        d = {"id": did, "system": system_id, "outputName": output, "name": name, "schema": schema,
             "series": Series(schema["fields"]), "owner": owner, "replaced": False, "declared_at_boot": self.boot}
        self.datastreams[did] = d
        return d, True

    def add_controlstream(self, system_id, input_name, name, schema, owner=None) -> tuple[dict, bool]:
        for c in self.controlstreams.values():
            if c["system"] == system_id and c["inputName"] == input_name and not c["replaced"]:
                if c["schema"]["fields"] == schema["fields"]:
                    return c, False
                c["replaced"] = True
        cid = self.ids.next("controlstream")
        c = {"id": cid, "system": system_id, "inputName": input_name, "name": name, "schema": schema, "owner": owner,
             "replaced": False}
        self.controlstreams[cid] = c
        return c, True

    def datastream(self, system_uid: str, output: str) -> dict | None:
        s = self.system_by_uid(system_uid)
        if s is None:
            return None
        return next((d for d in self.datastreams.values()
                     if d["system"] == s["id"] and d["outputName"] == output and not d["replaced"]), None)

    def controlstream(self, system_uid: str, input_name: str) -> dict | None:
        s = self.system_by_uid(system_uid)
        if s is None:
            return None
        return next((c for c in self.controlstreams.values()
                     if c["system"] == s["id"] and c["inputName"] == input_name and not c["replaced"]), None)

    # --- observations ------------------------------------------------------------------
    def append_cols(self, d: dict, cols: dict) -> int:
        n = len(cols["t"])
        seq0 = next(self.seq)
        for _ in range(n - 1):
            next(self.seq)
        return d["series"].append_cols(cols, seq0)

    def append_row(self, d: dict, t: float, rt: float, values: dict) -> None:
        d["series"].append_row(t, rt, values, next(self.seq))


class Subscription:
    """One push subscription to a control stream (§9.2): commands queue here until written to the stream."""

    def __init__(self, cs_id: str, acct: A.Account, component: str, model: str | None):
        self.cs_id = cs_id
        self.account = acct
        self.component = component
        self.model = model
        self.queue: asyncio.Queue = asyncio.Queue()
        self.closed = False

    def close(self):
        if not self.closed:
            self.closed = True
            self.queue.put_nowait(None)


class Hub:
    """Command delivery: pushed to every subscriber at once; dropped without one (§9.1)."""

    def __init__(self):
        self.subs: list[Subscription] = []

    def subscribe(self, sub: Subscription) -> Subscription:
        self.subs.append(sub)
        return sub

    def unsubscribe(self, sub: Subscription) -> None:
        sub.close()
        if sub in self.subs:
            self.subs.remove(sub)

    def subscribers(self, cs_id: str) -> list[Subscription]:
        return [s for s in self.subs if s.cs_id == cs_id and not s.closed]

    def close_all(self) -> None:
        for s in self.subs:
            s.close()
        self.subs = []

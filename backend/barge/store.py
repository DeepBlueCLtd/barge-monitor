"""The data server's store of resources: systems, datastreams, control streams, commands, status reports.

Like OpenSensorHub's database it outlives a server restart (decision D-11). Identifiers are
**opaque** (four base-32 characters, like OpenSensorHub's ``040g``): nobody may rely on them;
clients find everything by uniqueId and outputName (docs/v4-interfaces.md §6, §9.1).

A datastream is either ``stored`` (its observations are kept here, as columns) or ``sensor``
(its observations are read from the 4.1 logger store through the store adapter, for the 4.1 display
client and models, until plans Phases 6 and 7). The CSV importer writes its datasets **in bulk** into
stored datastreams (``append_cols``, FR-20a). Columns: numbers as float arrays (NaN for a
missing value), everything else as object arrays. Each observation also has an insertion
sequence: ``resultTime=latest`` is the last one inserted.

Each resource carries its ``owner`` (the account that created it), for the permission checks of
§9.3, which are the server's own (4.7: no gateway).
"""
from __future__ import annotations

import asyncio

import numpy as np

NUMERIC = {"Quantity", "Count", "Boolean"}
B32 = "0123456789abcdefghijklmnopqrstuv"
URN = "urn:x-barge:"


def _b32(n: int) -> str:
    return "".join(B32[(n >> (5 * i)) & 31] for i in (3, 2, 1, 0))


class Ids:
    """Opaque, deterministic identifiers: a scrambled counter per kind."""

    OFFSET = {"system": 4, "datastream": 9001, "controlstream": 17011, "command": 23023, "status": 29021}

    def __init__(self):
        self.n: dict[str, int] = {}

    def next(self, kind: str) -> str:
        k = self.n.get(kind, 0) + 1
        self.n[kind] = k
        return _b32((k * 7919 + self.OFFSET.get(kind, 0)) % (32 ** 4))


class Series:
    """Observations of one stored datastream, ordered by phenomenon time on reading."""

    def __init__(self, fields: list[dict]):
        self.types = {f["name"]: f["type"] for f in fields if f["name"] != "time"}
        self.t = np.empty(0)
        self.seq = np.empty(0, dtype=np.int64)
        self.cols: dict[str, np.ndarray] = {n: self._empty(ty) for n, ty in self.types.items()}
        self._rows: list[tuple] = []  # single observations not yet consolidated

    def __len__(self):
        self._flush()
        return len(self.t)

    @staticmethod
    def _empty(ty):
        return np.empty(0) if ty in NUMERIC or ty == "Time" else np.empty(0, dtype=object)

    def append_row(self, t: float, values: dict, seq: int) -> None:
        self._rows.append((t, seq, values))

    def append_cols(self, t: np.ndarray, cols: dict, seq: np.ndarray) -> None:
        """Many observations at once, as columns: the importer's bulk write (FR-20a)."""
        self._flush()
        t = np.asarray(t, dtype=float)
        if not len(t):
            return
        prev = self.t[-1] if len(self.t) else -np.inf
        self.t = np.concatenate([self.t, t])
        self.seq = np.concatenate([self.seq, np.asarray(seq, dtype=np.int64)])
        for n, ty in self.types.items():
            v = cols.get(n)
            if ty in NUMERIC or ty == "Time":
                col = np.full(len(t), np.nan) if v is None else np.asarray(v, dtype=float)
            else:
                col = np.empty(len(t), dtype=object)
                if v is not None:
                    col[:] = v
            self.cols[n] = np.concatenate([self.cols[n], col])
        if t[0] < prev or np.any(np.diff(t) < 0):
            order = np.argsort(self.t, kind="stable")
            self.t, self.seq = self.t[order], self.seq[order]
            for n in self.cols:
                self.cols[n] = self.cols[n][order]

    def _flush(self):
        if not self._rows:
            return
        rows, self._rows = self._rows, []
        t = np.array([r[0] for r in rows], dtype=float)
        prev = self.t[-1] if len(self.t) else -np.inf
        self.t = np.concatenate([self.t, t])
        self.seq = np.concatenate([self.seq, np.array([r[1] for r in rows], dtype=np.int64)])
        for n, ty in self.types.items():
            vals = [r[2].get(n) for r in rows]
            if ty in NUMERIC or ty == "Time":
                col = np.array([np.nan if v is None else v for v in vals], dtype=float)
            else:
                col = np.empty(len(vals), dtype=object)
                col[:] = vals
            self.cols[n] = np.concatenate([self.cols[n], col])
        if t.min() < prev or np.any(np.diff(t) < 0):
            order = np.argsort(self.t, kind="stable")
            self.t, self.seq = self.t[order], self.seq[order]
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
        out = {"t": self.t[idx]}
        for n in (names if names is not None else self.cols):
            if n in self.cols:
                out[n] = self.cols[n][idx]
        return out


def _same_schema(a: dict, b: dict) -> bool:
    return [(f["name"], f["type"]) for f in a["fields"]] == [(f["name"], f["type"]) for f in b["fields"]]


class Store:
    """Created resources. Everything is kept across restarts; only Reset instance deletes the whole store
    (FR-50a), and then a new one keeps counting identifiers, so that none is reused for something else."""

    def __init__(self, ids: Ids | None = None):
        self.ids = ids or Ids()
        self.systems: dict[str, dict] = {}
        self.datastreams: dict[str, dict] = {}
        self.controlstreams: dict[str, dict] = {}
        self.commands: dict[str, dict] = {}
        self.status_reports: dict[str, list] = {}  # control stream id -> reports
        self._seq = 0

    # --- systems ------------------------------------------------------------------
    def system_by_uid(self, uid: str) -> dict | None:
        return next((s for s in self.systems.values() if s["uid"] == uid), None)

    def add_system(self, uid, label, description="", feature="http://www.w3.org/ns/sosa/System", asset="Equipment",
                   parent=None, owner=None) -> tuple[dict, bool]:
        """The system with this uniqueId: (system, created). Creating what exists is not an error (§9.1)."""
        old = self.system_by_uid(uid)
        if old is not None:
            return old, False
        sid = self.ids.next("system")
        s = {"id": sid, "uid": uid, "label": label, "description": description, "feature": feature, "asset": asset,
             "parent": parent, "owner": owner}
        self.systems[sid] = s
        return s, True

    def chain(self, sid: str | None) -> list[dict]:
        """A system and its ancestors, nearest first."""
        out, seen = [], set()
        cur = self.systems.get(sid) if sid else None
        while cur is not None and cur["id"] not in seen:
            seen.add(cur["id"])
            out.append(cur)
            cur = self.systems.get(cur["parent"]) if cur["parent"] else None
        return out

    # --- datastreams and control streams --------------------------------------------
    def add_datastream(self, system_id, output, name, schema, owner=None, kind="stored", sensor=None) -> tuple[dict, bool]:
        """The same outputName with the same fields is the datastream already there (201 with its Location); a
        different schema makes a new datastream with a new id, and the old one is no longer listed (FR-51).
        Going back to a schema served before brings that datastream, and its identifier, back."""
        same = [d for d in self.datastreams.values() if d["system"] == system_id and d["outputName"] == output]
        live = next((d for d in same if not d["replaced"]), None)
        if live is not None and _same_schema(live["schema"], schema):
            return live, False
        back = next((d for d in same if d["replaced"] and _same_schema(d["schema"], schema)), None)
        for d in same:
            d["replaced"] = True
        if back is not None:
            back["replaced"] = False
            return back, False
        did = self.ids.next("datastream")
        d = {"id": did, "system": system_id, "outputName": output, "name": name, "schema": schema, "owner": owner,
             "kind": kind, "sensor": sensor, "series": Series(schema["fields"]) if kind == "stored" else None,
             "replaced": False}
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
    def append_row(self, d: dict, t: float, values: dict) -> None:
        self._seq += 1
        d["series"].append_row(t, values, self._seq)

    def append_cols(self, d: dict, t, cols: dict) -> None:
        """Rows in bulk, inside the server (FR-20a): the CSV importer's write."""
        n = len(t)
        seq = np.arange(self._seq + 1, self._seq + 1 + n, dtype=np.int64)
        self._seq += n
        d["series"].append_cols(t, cols, seq)


class Subscription:
    """One push subscription to a control stream (§9.2): commands queue here until written to the stream.

    The queue belongs to the event loop the subscription was opened in; a command sent from another
    loop (the CPython tests run the models in a loop of their own) is handed over thread-safely."""

    def __init__(self, cs_id: str, account, model: str | None):
        self.cs_id = cs_id
        self.account = account
        self.model = model
        self.loop = asyncio.get_event_loop()
        self.queue: asyncio.Queue = asyncio.Queue()
        self.closed = False

    def put(self, item) -> None:
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if running is self.loop:
            self.queue.put_nowait(item)
        elif not self.loop.is_closed():
            try:
                self.loop.call_soon_threadsafe(self.queue.put_nowait, item)
            except (AttributeError, NotImplementedError, RuntimeError):  # a loop without threads (Pyodide's)
                self.queue.put_nowait(item)

    def close(self):
        if not self.closed:
            self.closed = True
            self.put(None)


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
        """The server stopped: every subscription ends (§9.2); receivers resubscribe once it answers again."""
        for s in self.subs:
            s.close()
        self.subs = []

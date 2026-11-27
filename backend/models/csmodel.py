"""What every model is written against: the data server, over HTTP only (docs/v4-interfaces.md §10.1).

``Api`` is the 4.7 interface (§10.1): every method is one or more HTTP requests with the model's
**service credentials**, behaving as OpenSensorHub requires (§9.1):

* discovery by ``GET /systems?searchMembers=true`` (D-193); SensorML sent as ``application/sml+json``
  (D-194); ``201`` with the existing ``Location`` is success;
* ``f=application/swe+json`` and paging by offset; ``"NaN"`` for a missing value, both ways;
* **one observation per** ``POST``;
* commands are **pushed** on a subscription held on the internal endpoint (§9.2, D-223); the receiver
  validates every bound and reports ``REJECTED`` naming it, else ``ACCEPTED`` then ``COMPLETED``;
* a command's outcome, as a sender reads it, is its latest status report other than ``PENDING`` (D-199).

``Model`` and ``Runner`` are the 4.7 ones (§10.2): models follow no clock and no current dataset. The
runner finds datasets in the importer's catalogue, declares every datastream a model may publish for a
new one, then processes the **whole dataset** in windows aligned to its start, and logs each run's
progress in ``runs__{ds}``. Times are Unix seconds throughout.

The same model code runs in the browser, one model per worker (``web/src/workers/model.worker.ts``),
and in CPython in-process for the tests (``barge/local_models.py``): the same requests either way.
Models see only what the server serves: never the manifest (FR-37); scores come from the referee.
"""
from __future__ import annotations

import asyncio
import base64
import json
import re
import time
from pathlib import Path

import numpy as np

SOSA = "http://www.w3.org/ns/sosa/"
DEF = "https://deepbluecltd.github.io/barge-monitor/def/"
URN = "urn:x-barge:"
SAMPLING_TIME = "http://www.opengis.net/def/property/OGC/0/SamplingTime"
QUANTITIES = ["air_temperature", "apparent_wind_speed", "relative_humidity", "pressure",
              "apparent_wind_direction", "solar_irradiance", "water_temperature"]
UNITS = {"air_temperature": "Cel", "apparent_wind_speed": "m/s", "relative_humidity": "%", "pressure": "hPa",
         "apparent_wind_direction": "deg", "solar_irradiance": "W/m2", "water_temperature": "Cel",
         "co2": "[ppm]"}  # UCUM codes (D-195)
LABELS = {"air_temperature": "Air temperature", "apparent_wind_speed": "Wind speed", "relative_humidity": "Humidity",
          "pressure": "Pressure", "apparent_wind_direction": "Wind direction", "solar_irradiance": "Solar irradiance",
          "water_temperature": "Water temp", "co2": "CO₂"}
PRECIP = ["none", "drizzle", "rain", "showers"]
PAGE = 50_000  # observations asked for per request
SWE = "application%2Fswe%2Bjson"
SML = "application/sml+json"
IN_FLIGHT = 16  # observations published at once by publish_many: one POST each, several in flight


def outcome(reports: list, cmd_id: str) -> dict | None:
    """A command's outcome: its latest status report other than ``PENDING`` (D-199, revising D-164).

    OpenSensorHub stores the sender's ``PENDING`` when the ``POST`` answers (about 5 s after it was sent), which is
    often after the receiver's ``COMPLETED``; the latest report alone would read ``PENDING``."""
    mine = [r for r in reports if r.get("command@id") == cmd_id and r.get("statusCode") != "PENDING"]
    mine.sort(key=lambda r: r.get("reportTime") or "")  # stable: equal times keep the server's order
    return mine[-1] if mine else None


class Unavailable(Exception):
    """The data server does not answer (starting, down, or not reachable): try again later."""


class Refused(Exception):
    """The data server refused the call."""


class NotFound(Refused):
    """The resource is not there (any more)."""


class Rejected(Exception):
    """A command the receiver refuses: reported as REJECTED, naming the bound (FR-27)."""


# --- SWE Common helpers -----------------------------------------------------------------------
def time_field(name="time", label="Time"):
    return {"type": "Time", "name": name, "label": label, "definition": SAMPLING_TIME,
            "uom": {"href": "http://www.opengis.net/def/uom/ISO-8601/0/Gregorian"}}


def quantity(name, label=None, uom=None, definition=None, lo=None, hi=None):
    q = {"type": "Quantity", "name": name, "label": label or LABELS.get(name, name),
         "definition": definition or DEF + name, "uom": {"code": uom or UNITS.get(name, "1")}}
    if lo is not None:
        q["constraint"] = {"type": "AllowedValues", "intervals": [[lo, hi]]}
    return q


def count(name, label, lo=None, hi=None):
    c = {"type": "Count", "name": name, "label": label, "definition": DEF + name}
    if lo is not None:
        c["constraint"] = {"type": "AllowedValues", "intervals": [[lo, hi]]}
    return c


def category(name, label, tokens, definition=None):
    return {"type": "Category", "name": name, "label": label, "definition": definition or DEF + name,
            "codeSpace": DEF + name, "constraint": {"type": "AllowedTokens", "values": list(tokens)}}


def text(name, label, tokens=None):
    t = {"type": "Text", "name": name, "label": label, "definition": DEF + name}
    if tokens:
        t["constraint"] = {"type": "AllowedTokens", "values": list(tokens)}
    return t


def boolean(name, label):
    return {"type": "Boolean", "name": name, "label": label, "definition": DEF + name}


def record(label, fields):
    return {"type": "DataRecord", "name": "record", "label": label, "fields": fields}  # SWE Common 3: a bound component carries a name


def measurement_fields():
    """The seven quantities, with the definitions of the raw parameters they come from."""
    return [quantity(p, LABELS[p], UNITS[p]) for p in QUANTITIES]


# --- times --------------------------------------------------------------------------------------
def iso(u: float) -> str:
    """Unix seconds as ISO 8601 UTC (whole seconds, or milliseconds when there is a fraction)."""
    u = float(u)
    if u == int(u):
        return str(np.datetime64(int(u), "s")) + "Z"
    return str(np.datetime64(int(round(u * 1000)), "ms")) + "Z"


def from_iso(values) -> np.ndarray:
    """ISO 8601 UTC times as Unix seconds."""
    if not len(values):
        return np.empty(0)
    a = np.array([v[:-1] if isinstance(v, str) and v.endswith("Z") else v for v in values], dtype="datetime64[ms]")
    return a.astype("int64") / 1000.0


def dataset_id(file: str, sha256: str) -> str:
    """The dataset id the importer gives a file (§6): ``<slug>-<h8>``."""
    stem = file[:-4] if file.lower().endswith(".csv") else file
    return re.sub(r"[^a-z0-9]+", "-", stem.lower()).strip("-") + "-" + sha256[:8]


def _json_value(ty: str, v, to_iso):
    """One value as published: nan as "NaN" (§9.1)."""
    if isinstance(v, np.generic):
        v = v.item()
    if ty == "Quantity":
        return "NaN" if v is None or (isinstance(v, float) and v != v) else float(v)
    if ty == "Count":  # a Count has no missing value in OpenSensorHub (D-197)
        return 0 if v is None or (isinstance(v, float) and v != v) else int(v)
    if ty == "Boolean":
        return None if v is None or (isinstance(v, float) and v != v) else bool(v)
    if ty == "Time":
        return None if v is None or (isinstance(v, float) and v != v) else (v if isinstance(v, str) else to_iso(v))
    if isinstance(v, float) and v != v:
        return None
    return v


def _role_of(user: str):
    """The delivered user-to-role assignment (FR-112a, D-152)."""
    try:
        from barge.accounts import role_of
    except ImportError:  # a model copied out on its own: no assignment, no CO₂
        return None
    return role_of(user)


class Api:
    """What a model does with the data server (§10.1): Connected Systems requests with its service credentials.

    ``transport(method, path, headers, body)`` makes one request and returns ``(status, headers, body)``, or raises
    ``Unavailable`` when there is no answer. ``stream(path, headers, internal)`` opens a streamed answer and returns
    ``(status, chunks)``, ``chunks`` an async iterator of bytes; ``internal`` asks for the server's internal endpoint
    (``/api-internal``, D-223). A datastream or control stream is named by a key, ``"<system uniqueId>|<name>"``,
    that outlives restarts.
    """

    def __init__(self, model_id: str, transport, user: str, password: str, stream=None, real=None):
        self.model = model_id
        self.user = user
        self.quiet = False
        self._transport = transport
        self._stream = stream
        self._real = real or time.time  # real time, Unix seconds: the runs log is stamped with it (§10.2)
        self._last_real = 0.0
        self._auth = "Basic " + base64.b64encode(f"{user}:{password}".encode()).decode()
        self.role_of = _role_of
        self.retry_s = 1.0  # real seconds before resubscribing after the server went away
        self.reset()

    def reset(self) -> None:
        """Forget every identifier (after a server restart)."""
        self._systems: dict[str, str] = {}  # uniqueId -> id
        self._ids: dict[str, str] = {}  # key -> datastream or control stream id
        self._types: dict[str, dict] = {}  # datastream id -> {field: type}
        self._made: dict[str, tuple] = {}  # key -> (kind, system uid, body) of what this model created

    def real(self) -> float:
        """Real time, Unix seconds, strictly increasing (a millisecond apart at least): two entries of a runs log
        never share a time, which OpenSensorHub would take as one replacing the other (D-198)."""
        t = max(round(float(self._real()), 3), round(self._last_real + 0.001, 3))
        self._last_real = t
        return t

    def forget(self) -> None:
        """Drop every identifier found or made: they are looked up (or made) again on next use. After a restart
        they are the same; after Reset instance (FR-50a) they are gone, and new ones are made."""
        self._systems.clear()
        self._ids.clear()
        self._types.clear()

    def iso(self, t: float) -> str:
        return iso(float(t))

    def times(self, values) -> np.ndarray:
        return from_iso(values)

    def tap(self, dst: str, summary: str, content=None) -> None:
        """Capture a call into, or a result out of, the scientific libraries (set by the host)."""

    def _headers(self, extra=None) -> dict:
        h = {"authorization": self._auth, "x-tap-model": self.model}
        if self.quiet:
            h["x-tap-quiet"] = "1"
        return {**h, **(extra or {})}

    async def request(self, method: str, path: str, body=None, ctype: str = "application/json", ok=(200, 201)):
        headers = self._headers()
        raw = None
        if body is not None:
            raw = json.dumps(body, separators=(",", ":"), allow_nan=False).encode()
            headers["content-type"] = ctype
        status, rh, payload = await self._transport(method, path, headers, raw)
        if status not in ok:
            raise (NotFound if status == 404 else Refused)(f"{method} {path}: {status}")
        return status, {k.lower(): v for k, v in rh.items()}, payload

    async def _get(self, path: str):
        _, _, payload = await self.request("GET", path)
        return json.loads(payload)  # JSON whatever the Content-Type says (D-196)

    @staticmethod
    def _located(headers: dict) -> str:
        return headers["location"].rstrip("/").rsplit("/", 1)[-1]

    # --- discovery ----------------------------------------------------------------------------
    async def find_system(self, uid: str) -> str | None:
        if uid not in self._systems:
            # Every system, subsystems included (D-193); the listing carries no parent link.
            doc = await self._get("/systems?searchMembers=true&f=application%2Fsml%2Bjson&limit=100000")
            for s in doc["items"]:
                self._systems[s.get("uniqueId") or s.get("properties", {}).get("uid")] = s["id"]
        return self._systems.get(uid)

    async def find(self, system_uid: str, output_name: str) -> str | None:
        """The key of a datastream, or None while it is not there."""
        sid = await self.find_system(system_uid)
        if sid is None:
            return None
        doc = await self._get(f"/systems/{sid}/datastreams?limit=100000")
        d = next((x for x in doc["items"] if x["outputName"] == output_name), None)
        if d is None:
            return None
        key = f"{system_uid}|{output_name}"
        self._ids[key] = d["id"]
        return key

    async def find_controlstream(self, system_uid: str, input_name: str) -> str | None:
        sid = await self.find_system(system_uid)
        if sid is None:
            return None
        doc = await self._get(f"/systems/{sid}/controlstreams")
        c = next((x for x in doc["items"] if x["inputName"] == input_name), None)
        if c is None:
            return None
        key = f"{system_uid}|{input_name}"
        self._ids[key] = c["id"]
        return key

    # --- registering (FR-28): 201 with the existing Location is success ------------------------
    async def create_system(self, body: dict, parent_uid: str | None = None) -> str:
        path = "/systems"
        if parent_uid:
            pid = await self.find_system(parent_uid)
            if pid is None:
                raise NotFound(f"system {parent_uid} is not there")
            path = f"/systems/{pid}/subsystems"
        body = {"type": "SimpleProcess", **body}
        _, rh, _ = await self.request("POST", path, body, ctype=SML)  # SensorML (D-194)
        sid = self._located(rh)
        self._systems[body["uniqueId"]] = sid
        return sid

    def _uid_of(self, system_id: str) -> str:
        return next(u for u, i in self._systems.items() if i == system_id)

    async def create_datastream(self, system_id: str, body: dict) -> str:
        uid = self._uid_of(system_id)
        key = f"{uid}|{body['outputName']}"
        made = {"name": body.get("name", body["outputName"]), "outputName": body["outputName"],
                "schema": {"obsFormat": "application/swe+json", "recordSchema": body["schema"]}}
        self._made[key] = ("datastreams", uid, made)
        _, rh, _ = await self.request("POST", f"/systems/{system_id}/datastreams", made)
        self._ids[key] = self._located(rh)
        self._types[self._ids[key]] = {f["name"]: f["type"] for f in body["schema"]["fields"]}
        return key

    async def create_controlstream(self, system_id: str, body: dict) -> str:
        uid = self._uid_of(system_id)
        name = body.get("inputName") or "settings"
        key = f"{uid}|{name}"
        made = {"name": body.get("name", name), "inputName": name,
                "schema": {"commandFormat": "application/json", "parametersSchema": body["schema"]}}
        self._made[key] = ("controlstreams", uid, made)
        _, rh, _ = await self.request("POST", f"/systems/{system_id}/controlstreams", made)
        self._ids[key] = self._located(rh)
        return key

    async def _id(self, key: str) -> str:
        if key not in self._ids:
            if key in self._made:
                kind, uid, body = self._made[key]
                sid = await self.find_system(uid)
                if sid is None:
                    raise NotFound(f"system {uid} is not there")
                _, rh, _ = await self.request("POST", f"/systems/{sid}/{kind}", body)
                self._ids[key] = self._located(rh)
            else:
                uid, _, out = key.partition("|")
                if await self.find(uid, out) is None and await self.find_controlstream(uid, out) is None:
                    raise NotFound(f"{key} is not there")
        return self._ids[key]

    async def _on(self, key: str, call):
        """Run ``call(id)``; if the identifier has gone (a new schema, a new offering), look it up once more."""
        try:
            return await call(await self._id(key))
        except NotFound:
            self._ids.pop(key, None)
            self._systems.clear()
            return await call(await self._id(key))

    async def schema(self, key: str) -> dict:
        """{field: SWE type} of a datastream, as served."""
        async def go(ds):
            if ds not in self._types:
                doc = await self._get(f"/datastreams/{ds}/schema?obsFormat={SWE}")
                self._types[ds] = {f["name"]: f["type"] for f in doc["recordSchema"]["fields"]}
            return self._types[ds]
        return await self._on(key, go)

    # --- observations ------------------------------------------------------------------------------
    def _columns(self, rows: list, types: dict, fields=None) -> dict:
        cols = {"t": self.times([r["time"] for r in rows])}
        for n, ty in types.items():
            if n == "time" or (fields is not None and n not in fields):
                continue
            vals = [r.get(n) for r in rows]
            if ty in ("Quantity", "Count", "Boolean"):
                cols[n] = np.array([np.nan if v in (None, "NaN") else float(v) for v in vals], dtype=float)
            elif ty == "Time":
                cols[n] = np.array([np.nan if v in (None, "NaN") else self.times([v])[0] for v in vals], dtype=float)
            else:
                a = np.empty(len(vals), dtype=object)
                a[:] = vals
                cols[n] = a
        return cols

    async def read(self, key: str, t0: float, t1: float, fields=None) -> dict:
        """Observations with t0 <= time <= t1 as columns ``{"t": seconds, field: array}``; "NaN" becomes nan.
        ``f=application/swe+json``, paged by offset (§9.1)."""
        lo, hi = float(np.ceil(t0)), float(np.floor(t1))

        async def go(ds):
            types = await self.schema(key)
            if hi < lo:
                return self._columns([], types, fields)
            rows, offset = [], 0
            while True:
                page = json.loads((await self.request(
                    "GET", f"/datastreams/{ds}/observations?f={SWE}&phenomenonTime={self.iso(lo)}/{self.iso(hi)}"
                           f"&limit={PAGE}&offset={offset}"))[2])
                rows += page
                if len(page) < PAGE:
                    break
                offset += PAGE
            return self._columns(rows, types, fields)
        return await self._on(key, go)

    async def latest(self, key: str) -> dict | None:
        """The last observation inserted (``resultTime=latest``), as a record."""
        async def go(ds):
            rows = json.loads((await self.request("GET", f"/datastreams/{ds}/observations?f={SWE}&resultTime=latest"))[2])
            return rows[-1] if rows else None
        return await self._on(key, go)

    async def all(self, key: str) -> list:
        async def go(ds):
            rows, offset = [], 0
            while True:
                page = json.loads((await self.request(
                    "GET", f"/datastreams/{ds}/observations?f={SWE}&limit={PAGE}&offset={offset}"))[2])
                rows += page
                if len(page) < PAGE:
                    return rows
                offset += PAGE
        return await self._on(key, go)

    async def publish(self, key: str, row: dict) -> None:
        """ONE observation per POST (§9.1). ``row`` has ``t`` (seconds) or ``time`` (ISO)."""
        async def go(ds):
            types = await self.schema(key) if ds not in self._types else self._types[ds]
            t = row.get("time", row.get("t"))
            obs = {"time": t if isinstance(t, str) else self.iso(t)}
            # In the schema's order: OpenSensorHub reads a SWE JSON record field by field, in order, and refuses one
            # whose members come in another ("Expected field 'air_temperature' but was 'removed'", AT-32, D-346).
            for k, ty in types.items():
                if k in ("t", "time") or k not in row:
                    continue
                obs[k] = _json_value(ty, row[k], self.iso)
            await self.request("POST", f"/datastreams/{ds}/observations", obs, ctype="application/swe+json")
        return await self._on(key, go)

    async def publish_many(self, key: str, cols: dict) -> int:
        """Columns as observations, one POST each, a few in flight at once. Returns how many."""
        names = [k for k in cols if k != "t"]
        t = np.asarray(cols["t"], dtype=float)
        rows = [{"t": float(t[i]), **{k: cols[k][i] for k in names}} for i in range(len(t))]
        # A sliding window of IN_FLIGHT requests, each started in row order: the next starts as soon as one answers,
        # rather than after the slowest of a batch, so the server is never left idle between batches (D-342).
        gate = asyncio.Semaphore(IN_FLIGHT)

        async def one(r):
            async with gate:
                await self.publish(key, r)
        await asyncio.gather(*(one(r) for r in rows))
        return len(rows)

    # --- commands (FR-27): pushed, validated by the receiver ---------------------------------------------
    async def subscribe(self, cs_key: str, on_command, on_open=None) -> None:
        """Hold a push subscription on the internal endpoint (§9.2, D-223); resubscribe after any unreachability.
        ``on_open()`` is awaited when it opens and ``on_open(closed=True)`` when it ends. Never returns."""
        while True:
            try:
                cs = await self._id(cs_key)
                # Subscribing is part of registering: counted, not drawn (§2); the commands pushed on it are drawn.
                status, chunks = await self._stream(f"/controlstreams/{cs}/commands?subscribe=1",
                                                    self._headers({"x-tap-quiet": "1"}), True)
                if status != 200:
                    raise (NotFound if status == 404 else Refused)(f"subscribe: {status}")
                if on_open:
                    await on_open()
                buf = b""
                async for chunk in chunks:
                    buf += chunk
                    while b"\n" in buf:
                        line, buf = buf.split(b"\n", 1)
                        if line.strip():
                            await on_command(json.loads(line))
            except (Unavailable, Refused):
                pass
            if on_open:
                await on_open(closed=True)
            await asyncio.sleep(self.retry_s)

    async def command_status(self, cs_key: str, cmd_id: str, status: str, message: str = "") -> None:
        async def go(cs):
            await self.request("POST", f"/controlstreams/{cs}/status",
                               {"command@id": cmd_id, "statusCode": status, **({"message": message} if message else {})})
        await self._on(cs_key, go)

    async def command_outcome(self, cs_key: str, cmd_id: str) -> dict | None:
        """A command's outcome, as a sender reads it: its latest status report other than ``PENDING`` (D-199)."""
        async def go(cs):
            _, _, payload = await self.request("GET", f"/controlstreams/{cs}/status?limit=100000")
            return outcome(json.loads(payload).get("items", []), cmd_id)
        return await self._on(cs_key, go)

    # --- the importer's catalogue (§7) --------------------------------------------------------------
    async def catalogue(self) -> list[dict]:
        """The catalogue folded per file: the latest observation for each file is its current status (§7).
        Empty while there is no importer."""
        key = URN + "importer|catalogue"
        if key not in self._ids and await self.find(URN + "importer", "catalogue") is None:
            return []
        latest: dict[str, dict] = {}
        for r in await self.all(key):
            latest[r.get("file")] = r  # in insertion order of time: the last one is current
        return list(latest.values())

    async def datasets(self) -> list[dict]:
        """Every dataset to process (§10.2): those whose file status is ``imported``, ``changed`` or ``superseded``,
        in the order they were imported, as ``{id, file, sha256, start, end}`` (Unix seconds)."""
        key = URN + "importer|catalogue"
        if key not in self._ids and await self.find(URN + "importer", "catalogue") is None:
            return []
        order: list[str] = []
        current: dict[str, dict] = {}
        for r in await self.all(key):  # in the order written: a dataset first appears when it is imported
            d = r.get("dataset")
            if d and r.get("status") in DATASET_STATUSES and r.get("start") and r.get("end"):
                if d not in current:
                    order.append(d)
                current[d] = r
        out = []
        for d in order:
            r = current[d]
            start, end = (float(x) for x in from_iso([r["start"], r["end"]]))
            out.append({"id": d, "file": r.get("file"), "sha256": r.get("sha256"), "start": start, "end": end})
        return out

    # --- the demonstrator's referee (scaffolding; FR-37) ---------------------------------------------
    async def score(self, kind: str, payload: dict) -> dict:
        _, _, body = await self.request("POST", f"/demonstrator/referee/{kind}", payload)
        return json.loads(body)




# --- 4.7: models process each dataset on import (§10.2) ------------------------------------------
DATASET_STATUSES = ("imported", "changed", "superseded")  # a file status that names a dataset to process
SENSORS = ("bow", "stern")
DC = URN + "process:data-cleanse"
CO2_ROLES = {"owner", "viewer-emissions", "service"}  # the roles that include emissions (barge/accounts.py)
DECILE = 10  # a runs entry every 10 %


class NotReady(Exception):
    """A run's inputs are not there yet (Data cleanse's run on the dataset is not complete): tried again later."""


def _strip(x):
    if isinstance(x, dict):
        return {k: _strip(v) for k, v in x.items() if k != "description"}
    if isinstance(x, list):
        return [_strip(v) for v in x]
    return x


def master(name: str) -> dict:
    """A SWE Common master from ``contracts/swe`` (the masters are the one source of each schema, D-276), without
    its descriptions. In the browser the masters are unpacked beside the models; in CPython they are the repository's."""
    here = Path(__file__).resolve().parent
    for root in (here.parent / "contracts", here.parent.parent / "contracts"):
        p = root / "swe" / name
        if p.is_file():
            return _strip(json.loads(p.read_text()))
    raise FileNotFoundError(f"the master contracts/swe/{name} is not there")


# --- Data cleanse's output in blocks (D-280) ---------------------------------------------------------
def block_fields(names: list) -> list:
    """A cleaned block: one observation per window, each quantity's readings as a JSON array in a Text (D-280),
    as Analysis's correlation ``matrix`` is (§6). One observation per ``POST`` stays one observation."""
    fields = [time_field("time", "Start of the block"), text("run_id", "Run"),
              text("offsets", "Seconds from the start of the block, for each reading (JSON array)")]
    for n in names:
        fields.append({"type": "Text", "name": n, "definition": DEF + n,
                       "label": f"{LABELS.get(n, n)}, each reading (JSON array, {UNITS.get(n, '1')}; null where removed)"})
    fields.append(count("removed", "Readings removed in the block"))
    return fields


def _num(v) -> list:
    """Values as JSON numbers: whole numbers as integers, nan and infinities as null. Vectorised (D-342): a block is
    3,600 readings per field, and an element-wise loop was most of Data cleanse's time in Pyodide."""
    a = np.asarray(v, dtype=float).ravel()
    finite = np.isfinite(a)
    whole = np.zeros(a.shape, dtype=bool)
    whole[finite] = a[finite] == np.trunc(a[finite])
    if whole.all() and (a.size == 0 or np.abs(a).max() < 2.0 ** 53):
        return a.astype(np.int64).tolist()
    out = a.tolist()
    for i in np.flatnonzero(whole).tolist():
        out[i] = int(out[i])
    for i in np.flatnonzero(~finite).tolist():
        out[i] = None
    return out


def encode_block(t0: float, cols: dict, names: list, removed: int, run_id: str) -> dict:
    """Columns ``{"t": seconds, name: values}`` as one block observation (D-280)."""
    t = np.asarray(cols["t"], dtype=float)
    row = {"t": float(t0), "run_id": run_id, "offsets": json.dumps(_num(t - t0), separators=(",", ":")),
           "removed": int(removed)}
    for n in names:
        row[n] = json.dumps(_num(np.round(np.asarray(cols[n], dtype=float), 3)), separators=(",", ":"))
    return row


def decode_blocks(cols: dict, names: list, t0: float = -np.inf, t1: float = np.inf) -> dict:
    """Blocks as read (``Api.read``) back into columns ``{"t", name...}``, readings with t0 <= t < t1 only."""
    ts, out = [], {n: [] for n in names}
    for i, start in enumerate(np.asarray(cols.get("t", []), dtype=float)):
        off = np.asarray(json.loads(cols["offsets"][i] or "[]"), dtype=float)
        ts.append(start + off)
        for n in names:
            raw = cols.get(n)
            vals = json.loads(raw[i]) if raw is not None and raw[i] else [None] * len(off)
            out[n].append(np.array(vals, dtype=float))  # None becomes nan
    t = np.concatenate(ts) if ts else np.empty(0)
    keep = (t >= t0) & (t < t1)
    res = {"t": t[keep]}
    for n in names:
        res[n] = (np.concatenate(out[n]) if out[n] else np.empty(0))[keep]
    return res


class Run:
    """One run of a model on one dataset (§10.2): ``<model>-<dataset>-<n>``, with the settings it uses."""

    def __init__(self, model_id: str, ds: dict, n: int, settings: dict, restricted: bool = False,
                 start: float | None = None, end: float | None = None, command: str | None = None):
        self.ds = ds
        self.n = n
        self.id = f"{model_id}-{ds['id']}-{n}"
        self.settings = dict(settings)
        self.restricted = restricted  # its settings name CO₂: logged under the restricted subsystem (FR-112)
        self.start = ds["start"] if start is None else float(start)
        self.end = ds["end"] + 1.0 if end is None else float(end)  # exclusive
        self.command = command
        self.next: float | None = None  # the start of the next window; None until it starts
        self.logged = -1  # the last tenth logged
        self.source: str | None = None  # Data cleanse's run it reads (every other model, AT-15)
        self.state: dict = {}  # the model's own, for this run
        self.result: dict = {}  # fields the model adds to the complete entry
        self.renumber = False  # to be numbered again from the runs log (after a restart)

    @property
    def done_until(self) -> float:
        return self.start if self.next is None else min(self.next, self.end)

    @property
    def pct(self) -> int:
        span = max(self.end - self.start, 1.0)
        return int(min(100, max(0, (self.done_until - self.start) * 100 // span)))


def run_number(run_id) -> int:
    try:
        return int(str(run_id).rsplit("-", 1)[-1])
    except ValueError:
        return 0


def _same(a, b) -> bool:
    if isinstance(a, (int, float)) and isinstance(b, (int, float)) and not isinstance(a, bool):
        return abs(float(a) - float(b)) < 1e-9
    return a == b


class Model:
    """Subclass this (§10.1). A model declares its datastreams for a dataset in ``outputs`` and processes one
    window ``[t0, t1)`` of it in ``process``; the runner does everything else."""

    id = "model"
    label = "Model"
    description = ""
    window: float | None = 60.0  # seconds of data per window, aligned to the dataset's start; None: a run at once
    uses_co2 = False  # has a restricted subsystem for outputs derived from CO₂ (FR-112)
    restricted_runs = False  # some of its runs name CO₂ in their settings: a runs log under that subsystem too
    control = None  # (inputName, master file) or (inputName, label, fields): its control stream
    defaults: dict = {}  # the settings of a run
    runs_master: str | None = None  # the master of its runs__{ds} record; None: a generic one
    reads_cleanse = True  # waits for Data cleanse's run on a dataset to be complete, and reads only its output

    def __init__(self):
        self.settings = dict(self.defaults)
        self.system = self.restricted = self.control_key = None

    @property
    def uid(self) -> str:
        return f"{URN}process:{self.id}"

    def system_body(self, restricted: bool = False) -> dict:
        return {"type": "SimpleProcess", "uniqueId": self.uid + (":restricted" if restricted else ""),
                "label": f"{self.label}, restricted outputs" if restricted else self.label,
                "description": "Outputs derived from CO₂ (restricted, FR-112)." if restricted else self.description,
                "definition": SOSA + "System", "assetType": "Process"}

    def control_spec(self):
        if not self.control:
            return None
        if len(self.control) == 2:
            name, file = self.control
            rec = master(file)
            return name, rec.get("label", name), rec["fields"]
        return self.control

    async def setup(self, api: Api) -> None:
        """Register (FR-28): its process system under Models, its restricted subsystem, its control stream."""
        self.system = await api.create_system(self.system_body(), URN + "process:models")
        self.restricted = await api.create_system(self.system_body(True), self.uid) if self.uses_co2 else None
        self.control_key = None
        spec = self.control_spec()
        if spec:
            name, label, fields = spec
            self.control_key = await api.create_controlstream(self.system, {
                "name": label, "inputName": name, "schema": record(label, fields)})

    def runs_record(self) -> dict:
        if self.runs_master:
            return master(self.runs_master)
        fields = [time_field("time", "Time of the entry (real time)"), text("run_id", "Run"),
                  category("status", "Run status", ("processing", "complete")),
                  time_field("done_until", "Processed up to"), count("pct", "Progress, percent", 0, 100)]
        fields += [quantity(k, k.replace("_", " ").capitalize(), "1") for k, v in self.defaults.items()
                   if isinstance(v, (int, float)) and not isinstance(v, bool)]
        return record(f"{self.label} runs", fields)

    async def declare(self, api: Api, ds: dict) -> bool:
        """Create every datastream it may publish for dataset ``ds``, restricted ones included, and ``runs__{ds}``.
        False while its inputs are not there yet."""
        if not await self.outputs(api, ds):
            return False
        rec = self.runs_record()
        await api.create_datastream(self.system, {"name": f"{self.label} runs · {ds['id']}",
                                                  "outputName": f"runs__{ds['id']}", "schema": rec})
        if self.restricted is not None and self.restricted_runs:
            await api.create_datastream(self.restricted, {"name": f"{self.label} runs · {ds['id']} (restricted)",
                                                          "outputName": f"runs__{ds['id']}", "schema": rec})
        return True

    async def outputs(self, api: Api, ds: dict) -> bool:
        """Create its output datastreams for a dataset; False while its inputs are not there."""
        return True

    def runs_key(self, ds_id: str, restricted: bool = False) -> str:
        return f"{self.uid}{':restricted' if restricted else ''}|runs__{ds_id}"

    async def process(self, api: Api, ds: dict, t0: float, t1: float, run: Run) -> None:
        """One window ``[t0, t1)`` of dataset ``ds`` in run ``run`` (its ``id`` and ``settings``)."""

    async def finish(self, api: Api, ds: dict, run: Run) -> None:
        """After the last window: anything published once per run, and ``run.result`` for the complete entry."""

    def wanted(self, ds: dict, complete: list) -> dict | None:
        """The settings of a run this dataset still needs, given its complete runs' entries; None for none.
        A model wants a complete run with its current settings."""
        mine = {k: v for k, v in self.settings.items() if isinstance(v, (int, float, str)) and not isinstance(v, bool)}
        for e in complete:
            if all(_same(e.get(k), v) for k, v in mine.items() if k in e):
                return None
        return dict(self.settings)

    def validate(self, api: Api, cmd: dict) -> None:
        """Check every parameter against its control stream's bounds; raise Rejected naming the bound (FR-27)."""
        spec = self.control_spec()
        if not spec:
            raise Rejected("this model takes no commands")
        params = cmd.get("parameters", {})
        for f in spec[2]:
            n = f["name"]
            if n not in params:
                raise Rejected(f"{n} is missing: every parameter is sent on every command")
            v = params[n]
            con = f.get("constraint") or {}
            if f["type"] in ("Quantity", "Count"):
                if isinstance(v, bool) or not isinstance(v, (int, float)):
                    raise Rejected(f"{n} must be a number")
                if f["type"] == "Count" and int(v) != v:
                    raise Rejected(f"{n} must be a whole number")
                if con.get("intervals"):
                    lo, hi = con["intervals"][0]
                    if not lo <= v <= hi:
                        raise Rejected(f"{n}={v:g} is outside the schema's AllowedValues interval [{lo:g}, {hi:g}]")
            elif f["type"] in ("Category", "Text"):
                if not isinstance(v, str):
                    raise Rejected(f"{n} must be text")
                allowed = con.get("values")
                if allowed and v not in allowed:
                    raise Rejected(f"{n}={v!r} is not one of {', '.join(map(str, allowed))}")

    async def on_command(self, api: Api, cmd: dict) -> dict:
        """A validated command: the runs it asks for, as ``{"dataset": id, or None for every dataset, "settings",
        "restricted", "start", "end"}``. A settings command starts a new run over every dataset (§10.3)."""
        self.settings.update({k: v for k, v in cmd["parameters"].items() if k in self.settings})
        return {"dataset": None, "settings": dict(self.settings)}

    def entry(self, run: Run) -> dict:
        """What a runs entry carries besides its progress: the run's settings (FR-37)."""
        return dict(run.settings)

    # --- Data cleanse's output: what every model but Data cleanse reads (AT-15) ----------------------------
    async def cleanse_run(self, api: Api, ds_id: str) -> str | None:
        """Data cleanse's latest complete run on a dataset; None while it has none, or is processing one (§10.2)."""
        key = await api.find(DC, f"runs__{ds_id}")
        if key is None:
            return None
        rows = await api.all(key)
        if not rows or rows[-1].get("status") != "complete":
            return None
        return rows[-1]["run_id"]

    async def read_cleaned(self, api: Api, ds_id: str, source: str, t0: float, t1: float, run_id: str,
                           names: list | None = None) -> dict:
        """Data cleanse's readings of ``source`` (``bow``, ``stern``, ``co2-bow``, ``co2-stern``) with
        t0 <= time < t1, from run ``run_id``, as columns (D-280)."""
        co2 = source.startswith("co2-")
        key = await api.find(DC + (":restricted" if co2 else ""), f"cleaned-{source}__{ds_id}")
        if key is None:
            raise NotReady(f"cleaned-{source}__{ds_id} is not there")
        types = await api.schema(key)
        if names is None:
            names = [n for n, ty in types.items() if ty == "Text" and n not in ("run_id", "offsets")]
        width = BLOCK_MAX_S  # look back far enough for the block holding t0
        cols = await api.read(key, t0 - width, t1 - 0.001)
        keep = np.asarray([r == run_id for r in cols.get("run_id", [])], dtype=bool)
        cols = {k: np.asarray(v)[keep] for k, v in cols.items()}
        return decode_blocks(cols, [n for n in names if n in types], t0, t1)


BLOCK_MAX_S = 3600.0  # the longest cleaned block (Data cleanse's window)


class Runner:
    """Runs a model on every imported dataset (§10.2). ``step()`` is called again and again: it registers, finds
    datasets in the catalogue (once per real second), declares a new dataset's datastreams, and processes a few
    windows of the run in hand. Its commands are pushed to it (§9.2)."""

    MAX_WINDOWS = 6  # windows per step, so that commands and other models get through between steps

    def __init__(self, model: Model, api: Api):
        self.model, self.api = model, api
        self.phase = "starting"
        self.detail = ""
        self.errors = 0
        self.registered = False
        self.subscribed = asyncio.Event()
        self.sub_task = None
        self.handling = 0
        self.scan_s = 1.0  # how often the catalogue is read, in real seconds
        self._scanned = -1e18
        self.datasets: dict = {}  # id -> dataset, in import order
        self.declared: set = set()
        self.planned: set = set()
        self.numbers: dict = {}  # dataset -> the highest run number used
        self.queue: list = []
        self.current: Run | None = None
        self.completed: list = []  # run ids this runner completed, oldest first

    # --- registering and commands ----------------------------------------------------------------------
    async def register(self) -> None:
        api, m = self.api, self.model
        api.quiet = True  # registering: counted, not drawn (§2)
        try:
            api.forget()
            await m.setup(api)
        finally:
            api.quiet = False
        self.registered = True
        # Datastreams and results persist across a restart (D-228); what was in hand is planned again.
        self.declared.clear()
        self.planned.clear()
        if self.current is not None:
            self.queue.insert(0, self.current)  # a run cut short is restarted as a new run (§10.2)
            self.current = None
        self.numbers.clear()  # numbered again from the runs logs, which a Reset instance (FR-50a) empties
        for r in self.queue:
            r.next, r.logged, r.renumber = None, -1, True
        self._scanned = -1e18
        if m.control_key and self.sub_task is None:
            self.sub_task = asyncio.ensure_future(api.subscribe(m.control_key, self._on_command, self._on_open))
        elif not m.control_key:
            self.subscribed.set()

    async def _on_open(self, closed: bool = False) -> None:
        if closed:  # the server went away: register again once it answers, and resubscribe (AT-38)
            self.subscribed.clear()
            self.registered = False
            return
        self.subscribed.set()

    def _new_run(self, ds: dict, settings: dict, restricted: bool = False, start=None, end=None, command=None) -> Run:
        self.numbers[ds["id"]] = self.numbers.get(ds["id"], 0) + 1
        return Run(self.model.id, ds, self.numbers[ds["id"]], settings, restricted, start, end, command)

    async def _on_command(self, cmd: dict) -> None:
        api, m = self.api, self.model
        key = m.control_key
        self.handling += 1
        try:
            try:
                m.validate(api, cmd)
            except Rejected as e:
                await api.command_status(key, cmd["id"], "REJECTED", str(e))
                return
            await api.command_status(key, cmd["id"], "ACCEPTED")
            try:
                req = await m.on_command(api, cmd)
                every = req.get("dataset") is None
                if every:  # a new run over every dataset, newest first (§10.2)
                    targets = list(reversed(list(self.datasets.values())))
                elif req["dataset"] in self.datasets:
                    targets = [self.datasets[req["dataset"]]]
                else:
                    raise Rejected(f"dataset {req['dataset']} has not been imported")
                runs = []
                for ds in targets:
                    if every:  # a settings run not yet started gives way to the new one
                        self.queue = [x for x in self.queue if x.ds["id"] != ds["id"] or x.command is not None]
                    runs.append(self._new_run(ds, req["settings"], req.get("restricted", False), req.get("start"),
                                              req.get("end"), cmd["id"]))
                self.queue[0:0] = runs
                await api.command_status(key, cmd["id"], "COMPLETED",
                                         f"new run{'s' if len(runs) != 1 else ''}: {', '.join(r.id for r in runs) or 'none'}")
            except Rejected as e:
                await api.command_status(key, cmd["id"], "REJECTED", str(e))
            except (Unavailable, Refused):
                raise
            except Exception as e:  # noqa: BLE001 - reported as the command's status
                await api.command_status(key, cmd["id"], "FAILED", f"{type(e).__name__}: {e}")
        except (Unavailable, Refused) as e:
            self.detail = f"a command's status was not reported: {e}"
        finally:
            self.handling -= 1

    # --- datasets and runs ---------------------------------------------------------------------------------
    async def _log(self, run: Run, status: str) -> None:
        """Append to the run's log (FR-35b): ``processing`` at its start and every 10 %, ``complete`` at its end."""
        m = self.model
        rec = {**m.entry(run), "t": self.api.real(), "run_id": run.id, "status": status,
               "done_until": run.done_until, "pct": 100 if status == "complete" else run.pct}
        if status == "complete":
            rec.update(run.result)
        # A runs-log entry is drawn, though processing is not (D-321): the model's progress, a dozen per run.
        quiet, self.api.quiet = self.api.quiet, False
        try:
            await self.api.publish(m.runs_key(run.ds["id"], run.restricted), rec)
        finally:
            self.api.quiet = quiet

    async def _entries(self, ds_id: str) -> list:
        """Every entry of this model's runs logs on a dataset (the restricted one too, when it has one)."""
        m = self.model
        out = []
        for restricted in ((False, True) if m.restricted is not None and m.restricted_runs else (False,)):
            try:
                out += await self.api.all(m.runs_key(ds_id, restricted))
            except NotFound:
                pass
        return out

    async def _plan(self, ds: dict) -> None:
        """A dataset just declared: the runs it needs. Run numbers carry on from its runs logs."""
        entries = await self._entries(ds["id"])
        self.numbers[ds["id"]] = max([self.numbers.get(ds["id"], 0)] + [run_number(e.get("run_id")) for e in entries])
        for r in self.queue:
            if r.ds["id"] == ds["id"] and r.renumber:
                self.numbers[ds["id"]] += 1
                r.renumber, r.n = False, self.numbers[ds["id"]]
                r.id = f"{self.model.id}-{ds['id']}-{r.n}"
        if any(r.ds["id"] == ds["id"] for r in self.queue) or (self.current and self.current.ds["id"] == ds["id"]):
            return  # already wanted
        last: dict = {}
        for e in entries:
            last[e.get("run_id")] = e
        complete = [e for e in last.values() if e.get("status") == "complete"]
        settings = self.model.wanted(ds, complete)
        if settings is not None:
            self.queue.append(self._new_run(ds, settings))

    async def scan(self) -> None:
        """Read the catalogue (§10.2): declare each new dataset, then plan its runs."""
        found = await self.api.datasets()
        self.datasets = {ds["id"]: self.datasets.get(ds["id"], ds) for ds in found}
        # A dataset no longer in the catalogue (after Reset instance) is not processed any further.
        self.queue = [r for r in self.queue if r.ds["id"] in self.datasets]
        if self.current is not None and self.current.ds["id"] not in self.datasets:
            self.current = None
        self.declared &= set(self.datasets)
        self.planned &= set(self.datasets)
        for ds in found:
            if ds["id"] not in self.declared:
                if not await self.model.declare(self.api, ds):
                    self.detail = f"waiting for the inputs of {ds['id']}"
                    continue
                self.declared.add(ds["id"])
            if ds["id"] not in self.planned:
                await self._plan(ds)
                self.planned.add(ds["id"])

    async def _take(self) -> Run | None:
        """The next run whose inputs are ready, oldest wanted first."""
        m = self.model
        for r in list(self.queue):
            if r.ds["id"] not in self.declared or r.renumber:
                continue
            if m.reads_cleanse:
                src = await m.cleanse_run(self.api, r.ds["id"])
                if src is None:
                    self.detail = f"waiting for Data cleanse on {r.ds['id']}"
                    continue
                r.source = src
            self.queue.remove(r)
            return r
        return None

    async def _work(self) -> None:
        """A few windows of the run in hand, oldest first; the last, partial window at the dataset's end."""
        api, m = self.api, self.model
        if self.current is None:
            self.current = await self._take()
            if self.current is None:
                return
        run = self.current
        ds = run.ds
        width = m.window or (run.end - run.start)
        if run.next is None:
            # Whole windows aligned to the dataset's start (D-129); a run on part of it starts in its window.
            run.next = ds["start"] + np.floor((run.start - ds["start"]) / width) * width if m.window else run.start
            run.state.clear()
            run.result.clear()
            await self._log(run, "processing")
            run.logged = 0
        for _ in range(self.MAX_WINDOWS):
            if run.next >= run.end:
                break
            t0 = float(run.next)
            t1 = float(min(t0 + width, run.end))
            await m.process(api, ds, max(t0, run.start), t1, run)
            run.next = t1
            tenth = run.pct // DECILE
            if tenth > run.logged and run.next < run.end:
                run.logged = tenth
                await self._log(run, "processing")
        self.detail = f"{run.id}: {run.pct}%"
        if run.next >= run.end:
            await m.finish(api, ds, run)
            await self._log(run, "complete")
            self.completed.append(run.id)
            self.current = None
            self.detail = f"{run.id} complete"

    async def step(self) -> None:
        api, m = self.api, self.model
        try:
            if not self.registered:
                self.phase, self.detail = "starting", "registering"
                await self.register()
            if m.control_key and not self.subscribed.is_set():
                self.phase, self.detail = "subscribing", "subscribing to its commands"
                return  # ready only once its subscription is open (AT-38)
            api.quiet = True  # processing a dataset is counted, not drawn (D-283), but for its runs entries and calls (D-321)
            now = float(api._real())
            if now - self._scanned >= self.scan_s:
                self._scanned = now
                await self.scan()
            await self._work()
            if self.current is None and not self.queue:
                self.phase = "live"
                self.detail = "every dataset processed" if self.datasets else "no dataset imported yet"
            else:
                self.phase = "processing"
        except NotReady as e:
            self.phase, self.detail = "waiting", str(e)
        except Unavailable as e:
            # The server did not answer: it may have restarted. Register again once it answers.
            self.registered = False
            self.phase, self.detail = "waiting", str(e)
        except Refused as e:
            self.errors += 1
            self.phase, self.detail = "waiting", f"refused: {e}"
        finally:
            api.quiet = False

    async def tick(self, playing: bool = False) -> None:
        """A step, under the name the hosts call it: models follow no clock (4.7)."""
        await self.step()

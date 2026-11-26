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

``Model`` and ``Runner`` below are still Version 4.1's: a model steps on the simulation clock and
catches up a bounded backlog at startup (decision D-251). Plan Phase 6 replaces them with the runner
of §10.2 (process each dataset on import). Until then ``Api.epoch`` is the 4.1 simulation epoch, so
that times read and published are the simulation's seconds; in 4.7 it is 0 (Unix seconds).

The same model code runs in the browser, one model per worker (``web/src/workers/model.worker.ts``),
and in CPython in-process for the tests (``barge/local_models.py``): the same requests either way.
Models see only what the server serves: never the manifest (FR-37); scores come from the referee.
"""
from __future__ import annotations

import asyncio
import base64
import json
import re

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
SIM_EPOCH_UNIX = 1933286400  # the 4.1 simulation epoch (2031-04-07T00:00:00Z)
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

    def __init__(self, model_id: str, transport, user: str, password: str, stream=None, now=None, epoch: float = 0.0):
        self.model = model_id
        self.user = user
        self.quiet = False
        self.epoch = float(epoch)  # 0: Unix seconds (§10.1); the 4.1 models use the simulation epoch (D-251)
        self._transport = transport
        self._stream = stream
        self._now = now
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

    def now(self) -> float:
        return float(self._now()) if self._now else 0.0

    def forget(self) -> None:
        """Drop every identifier found or made: they are looked up (or made) again on next use. After a restart
        they are the same; after Reset instance (FR-50a) they are gone, and new ones are made."""
        self._systems.clear()
        self._ids.clear()
        self._types.clear()

    def iso(self, t: float) -> str:
        return iso(self.epoch + float(t))

    def times(self, values) -> np.ndarray:
        return from_iso(values) - self.epoch

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
            for k, v in row.items():
                if k in ("t", "time") or k not in types:
                    continue
                obs[k] = _json_value(types[k], v, self.iso)
            await self.request("POST", f"/datastreams/{ds}/observations", obs, ctype="application/swe+json")
        return await self._on(key, go)

    async def publish_many(self, key: str, cols: dict) -> int:
        """Columns as observations, one POST each, a few in flight at once. Returns how many."""
        names = [k for k in cols if k != "t"]
        t = np.asarray(cols["t"], dtype=float)
        rows = [{"t": float(t[i]), **{k: cols[k][i] for k in names}} for i in range(len(t))]
        for i in range(0, len(rows), IN_FLIGHT):
            await asyncio.gather(*(self.publish(key, r) for r in rows[i:i + IN_FLIGHT]))
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

    # --- the demonstrator's referee (scaffolding; FR-37) ---------------------------------------------
    async def score(self, kind: str, payload: dict) -> dict:
        _, _, body = await self.request("POST", f"/demonstrator/referee/{kind}", payload)
        return json.loads(body)


# --- models (Version 4.1: on the simulation clock, until plan Phase 6) ------------------------------
class Model:
    """Subclass this. ``interval`` is in simulated seconds."""

    id = "model"
    label = "Model"
    description = ""
    interval = 60.0
    catch_up_chunk = 6 * 3600.0  # how much history one step takes while catching up
    catch_up_margin = 120.0  # caught up once this close to now (never less than two intervals)
    start_from = "history"  # "history": process the backlog first; "now": only what arrives
    # How much history a model catches up at startup (D-251): one observation per POST makes the whole
    # day too slow to publish, so a model starts this far back. Plan Phase 6 processes whole datasets instead.
    backlog = 1800.0
    control_key = None

    @property
    def uid(self) -> str:
        return f"{URN}process:{self.id}"

    def system_body(self) -> dict:
        return {"type": "SimpleProcess", "uniqueId": self.uid, "label": self.label, "description": self.description,
                "definition": SOSA + "System", "assetType": "Process"}

    async def setup(self, api: Api) -> None:
        """Register (FR-28): its process system under Models."""
        self.system = await api.create_system(self.system_body(), URN + "process:models")

    async def step(self, api: Api, t0: float, t1: float) -> float:
        """Process data in (t0, t1]; return the time processed up to."""
        return t1

    def control_fields(self, api: Api) -> list:
        made = api._made.get(self.control_key) if self.control_key else None
        return made[2]["schema"]["parametersSchema"]["fields"] if made else []

    def validate(self, api: Api, cmd: dict) -> None:
        """Check every parameter against its control stream's bounds; raise Rejected naming the bound (FR-27)."""
        params = cmd.get("parameters", {})
        for f in self.control_fields(api):
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
                items = [x.strip() for x in v.split(",")] if f["type"] == "Text" else [v]
                if allowed:
                    bad = [x for x in items if x not in allowed]
                    if bad or not items or items == [""]:
                        raise Rejected(f"{n}={v!r}: {', '.join(bad) or 'nothing'} not in the schema's AllowedTokens")

    async def on_command(self, api: Api, cmd: dict) -> str:
        return "no settings to apply"

    async def initial(self, api: Api) -> bool:
        """For a model that starts from now: a first run once its inputs exist. True when done."""
        return True


class Runner:
    """Steps a 4.1 model on the simulation clock; its commands are pushed to it (§9.2). Nothing happens while the
    clock stands still, except catching up the backlog at startup (counted, not drawn) and commands."""

    def __init__(self, model: Model, api: Api):
        self.model, self.api = model, api
        self.ready = False
        self.last: float | None = None
        self.phase = "starting"
        self.detail = ""
        self.errors = 0
        self.initial_done = False
        self.retry_at = -1.0  # after a step that found nothing new, wait before trying again
        self.subscribed = asyncio.Event()
        self.sub_task = None
        self.handling = 0  # commands being handled now

    @property
    def caught_up(self) -> bool:
        return self.last is not None and self.api.now() - self.last < max(2 * self.model.interval, self.model.catch_up_margin)

    async def _on_open(self, closed: bool = False) -> None:
        if closed:  # the server went away: register again once it answers, and resubscribe (AT-38)
            self.subscribed.clear()
            self.ready = False
            self.api.forget()  # after Reset instance (FR-50a) every identifier it held has gone
            return
        self.subscribed.set()

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
                msg = await m.on_command(api, cmd)
                await api.command_status(key, cmd["id"], "COMPLETED", msg or "")
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

    async def tick(self, playing: bool, wake: bool = False) -> None:
        api, m = self.api, self.model
        now = api.now()
        try:
            if not self.ready:
                api.quiet = True
                await m.setup(api)
                self.ready = True
                if self.last is None:
                    self.last = max(0.0, now - m.backlog) if m.start_from == "history" else now
                self.phase = "catching up"
                if m.control_key and self.sub_task is None:
                    self.sub_task = asyncio.ensure_future(api.subscribe(m.control_key, self._on_command, self._on_open))
            if m.control_key and not self.subscribed.is_set():
                self.detail = "subscribing to its commands"
                return  # live only once its subscription is open (AT-38)
            if m.start_from == "now" and not self.initial_done:
                api.quiet = True
                self.initial_done = await m.initial(api)
                self.detail = "" if self.initial_done else "waiting for its inputs"
                self.phase = "live" if self.initial_done else "catching up"
                return
            if not self.caught_up:
                api.quiet = True
                upto = min(now, self.last + m.catch_up_chunk)
                done = await m.step(api, self.last, upto)
                self.last = max(self.last, done)
                span = max(now - (now - m.backlog), 1.0)
                self.detail = f"{min(100, max(0, round(100 * (1 - (now - self.last) / span))))}% of its backlog"
                if self.caught_up:
                    self.phase, self.detail = "live", ""
                return
            api.quiet = False
            self.phase, self.detail = "live", ""
            if playing and now - self.last >= m.interval and now >= self.retry_at:
                done = await m.step(api, self.last, now)
                if done <= self.last:  # its inputs are not there yet: try again a little later
                    self.retry_at = now + min(m.interval, 10.0)
                self.last = max(self.last, done)
        except Unavailable as e:
            self.ready = False  # the server may have restarted: register again once it answers
            self.detail = f"waiting: {e}"
        except Refused as e:
            self.errors += 1
            self.detail = f"refused: {e}"
        finally:
            api.quiet = False

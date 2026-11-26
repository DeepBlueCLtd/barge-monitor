"""What every model is written against (docs/v4-interfaces.md §10): the data server, over HTTP only.

A model is a class with ``setup`` (register its process system, its restricted subsystem and its
control stream: FR-28), ``datasets`` (create its datastreams for a dataset), ``process`` (one
window of a dataset under a replay run) and ``on_command`` (its settings, pushed to it: FR-27).
The ``Runner`` drives it from the replay controller's state, read once per real second.

The same model code runs:

* in the browser, one model per worker, its requests made with ``fetch`` through the relay and
  its push subscription as a streaming response (``web/src/workers/model.worker.ts``);
* in CPython, in-process, for the tests and the ASGI deployment: the same requests, made of the
  same application (``barge/local_models.py``).

Everything goes through the access gateway with the model's **service credentials**. Models see
only what the server serves: never the manifest (FR-37); scores come from the referee.

Behaving as OpenSensorHub requires (§9.1): ``201`` with the existing ``Location`` is success;
one observation per ``POST``; a missing value is ``"NaN"``; ``f=application/swe+json`` and paging
by offset; every parameter on every command; the receiver validates and answers ``REJECTED``.
"""
from __future__ import annotations

import asyncio
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
         "apparent_wind_direction": "deg", "solar_irradiance": "W/m2", "water_temperature": "Cel", "co2": "ppm"}
LABELS = {"air_temperature": "Air temperature", "apparent_wind_speed": "Wind speed", "relative_humidity": "Humidity",
          "pressure": "Pressure", "apparent_wind_direction": "Wind direction", "solar_irradiance": "Solar irradiance",
          "water_temperature": "Water temp", "co2": "CO₂"}
SENSORS = ("bow", "stern")
PAGE = 50_000  # observations asked for per request
SWE = "application%2Fswe%2Bjson"
CO2_ROLES = {"owner", "viewer-emissions", "service"}


class Unavailable(Exception):
    """The data server does not answer (starting, down, or not reachable): try again later."""


class Refused(Exception):
    """The data server refused the call."""


class NotFound(Refused):
    """The resource is not there (any more)."""


class Rejected(Exception):
    """A command the receiver refuses: reported as REJECTED, naming the bound (FR-27)."""


class NotReady(Exception):
    """A window's inputs are not all there yet: the runner tries the same window again."""


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


def text(name, label):
    return {"type": "Text", "name": name, "label": label, "definition": DEF + name}


def boolean(name, label):
    return {"type": "Boolean", "name": name, "label": label, "definition": DEF + name}


def record(label, fields):
    return {"type": "DataRecord", "name": "record", "label": label, "fields": fields}


def run_field():
    return text("run", "Replay run")


# --- times --------------------------------------------------------------------------------------
def iso(t: float) -> str:
    u = float(t)
    if u == int(u):
        return str(np.datetime64(int(u), "s")) + "Z"
    return str(np.datetime64(int(round(u * 1000)), "ms")) + "Z"


def from_iso(values) -> np.ndarray:
    if not len(values):
        return np.empty(0)
    a = np.array([v[:-1] if isinstance(v, str) and v.endswith("Z") else v for v in values], dtype="datetime64[ms]")
    return a.astype("int64") / 1000.0


def dataset_id(file: str, sha256: str) -> str:
    """The dataset id the importer gives a file (§6): ``<slug>-<h8>``."""
    stem = file[:-4] if file.lower().endswith(".csv") else file
    return re.sub(r"[^a-z0-9]+", "-", stem.lower()).strip("-") + "-" + sha256[:8]


def run_number(run: str) -> int:
    try:
        return int(str(run).rsplit("-", 1)[-1])
    except ValueError:
        return -1


def _json_value(ty: str, v):
    """One value as published: nan as "NaN" (§9.1)."""
    if isinstance(v, np.generic):
        v = v.item()
    if ty in ("Quantity", "Count"):
        if v is None or (isinstance(v, float) and v != v):
            return "NaN"
        return int(v) if ty == "Count" else float(v)
    if ty == "Boolean":
        return None if v is None or (isinstance(v, float) and v != v) else bool(v)
    if ty == "Time":
        return None if v is None or (isinstance(v, float) and v != v) else (v if isinstance(v, str) else iso(v))
    return v


def _role_of(user: str):
    """The delivered user-to-role assignment (FR-112a, D-152)."""
    try:
        from barge.accounts import role_of
    except ImportError:  # a model copied out on its own: no assignment, no CO₂
        return None
    return role_of(user)


class Api:
    """What a model does with the data server: OGC API – Connected Systems requests, through the gateway.

    ``transport(method, path, headers, body)`` makes one request and returns ``(status, headers, body)``,
    or raises ``Unavailable`` when there is no answer. ``stream(path, headers)`` opens a streamed answer
    and returns ``(status, chunks)`` where ``chunks`` is an async iterator of bytes. A datastream or
    control stream is named by a key, ``"<system uniqueId>|<outputName>"``, that outlives restarts.
    """

    def __init__(self, model_id: str, transport, user: str, password: str, stream=None):
        import base64

        self.model = model_id
        self.quiet = False
        self._transport = transport
        self._stream = stream
        self._auth = "Basic " + base64.b64encode(f"{user}:{password}".encode()).decode()
        self.role_of = _role_of
        self.retry_s = 1.0  # real seconds before resubscribing after the server went away
        self.reset()

    def reset(self) -> None:
        """Forget every identifier (after a server restart or Reset instance)."""
        self._systems: dict[str, str] = {}  # uniqueId -> id
        self._ids: dict[str, str] = {}  # key -> datastream or control stream id
        self._types: dict[str, dict] = {}  # datastream id -> {field: type}
        self._made: dict[str, tuple] = {}  # key -> (kind, system uid, body) of what this model created

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
        return json.loads(payload)

    @staticmethod
    def _located(headers: dict) -> str:
        return headers["location"].rstrip("/").rsplit("/", 1)[-1]

    # --- discovery ----------------------------------------------------------------------------
    async def find_system(self, uid: str) -> str | None:
        if uid not in self._systems:
            doc = await self._get("/collections/all_systems/items?f=application%2Fsml%2Bjson&limit=100000")
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
        _, rh, _ = await self.request("POST", path, body)
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
        key = f"{uid}|{body['inputName']}"
        made = {"name": body.get("name", body["inputName"]), "inputName": body["inputName"],
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
        try:
            return await call(await self._id(key))
        except NotFound:
            self._ids.pop(key, None)
            self._systems.clear()
            return await call(await self._id(key))

    async def schema(self, key: str) -> dict:
        """{field: SWE type} of a datastream."""
        async def go(ds):
            if ds not in self._types:
                doc = await self._get(f"/datastreams/{ds}/schema?obsFormat={SWE}")
                self._types[ds] = {f["name"]: f["type"] for f in doc["recordSchema"]["fields"]}
            return self._types[ds]
        return await self._on(key, go)

    async def schema_fields(self, key: str) -> list:
        async def go(ds):
            doc = await self._get(f"/datastreams/{ds}/schema?obsFormat={SWE}")
            return doc["recordSchema"]["fields"]
        return await self._on(key, go)

    # --- observations ------------------------------------------------------------------------------
    @staticmethod
    def _columns(rows: list, types: dict, fields=None) -> dict:
        cols = {"t": from_iso([r["time"] for r in rows])}
        for n, ty in types.items():
            if n == "time" or (fields is not None and n not in fields):
                continue
            vals = [r.get(n) for r in rows]
            if ty in ("Quantity", "Count", "Boolean"):
                cols[n] = np.array([np.nan if v in (None, "NaN") else float(v) for v in vals], dtype=float)
            elif ty == "Time":
                cols[n] = np.array([np.nan if v in (None, "NaN") else from_iso([v])[0] for v in vals], dtype=float)
            else:
                a = np.empty(len(vals), dtype=object)
                a[:] = vals
                cols[n] = a
        return cols

    async def read(self, key: str, t0: float, t1: float, fields=None) -> dict:
        """Observations with t0 <= time <= t1 as columns ``{"t": Unix seconds, field: array}``;
        "NaN" becomes nan. Paged by offset (§9.1)."""
        async def go(ds):
            types = await self.schema(key)
            rows, offset = [], 0
            while True:
                page = json.loads((await self.request(
                    "GET", f"/datastreams/{ds}/observations?f={SWE}&phenomenonTime={iso(t0)}/{iso(t1)}"
                           f"&limit={PAGE}&offset={offset}"))[2])
                rows += page
                if len(page) < PAGE:
                    break
                offset += PAGE
            return self._columns(rows, types, fields)
        return await self._on(key, go)

    async def latest(self, key: str) -> dict | None:
        async def go(ds):
            rows = json.loads((await self.request("GET", f"/datastreams/{ds}/observations?f={SWE}&resultTime=latest"))[2])
            return rows[-1] if rows else None
        return await self._on(key, go)

    async def all(self, key: str) -> list:
        async def go(ds):
            return json.loads((await self.request("GET", f"/datastreams/{ds}/observations?f={SWE}&limit=1000000"))[2])
        return await self._on(key, go)

    async def publish(self, key: str, row: dict) -> None:
        """ONE observation per POST (§9.1). ``row`` has ``t`` (Unix seconds) or ``time``."""
        async def go(ds):
            types = await self.schema(key)
            t = row.get("time", row.get("t"))
            obs = {"time": t if isinstance(t, str) else iso(t)}
            for k, v in row.items():
                if k in ("t", "time"):
                    continue
                obs[k] = _json_value(types.get(k, "Text"), v)
            await self.request("POST", f"/datastreams/{ds}/observations", obs, ctype="application/swe+json")
        return await self._on(key, go)

    async def publish_many(self, key: str, cols: dict) -> int:
        names = [k for k in cols if k != "t"]
        n = len(cols["t"])
        for i in range(n):
            await self.publish(key, {"t": float(cols["t"][i]), **{k: cols[k][i] for k in names}})
        return n

    # --- commands (FR-27): pushed, validated by the receiver -------------------------------------------
    async def subscribe(self, cs_key: str, on_command, on_open=None) -> None:
        """Hold a push subscription (§9.2); resubscribe after any unreachability. Never returns."""
        while True:
            try:
                cs = await self._id(cs_key)
                status, chunks = await self._stream(f"/controlstreams/{cs}/commands?subscribe=1", self._headers())
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

    # --- the replay controller ------------------------------------------------------------------------
    async def replay_state(self) -> dict | None:
        key = URN + "replay|state"
        if key not in self._ids and await self.find(URN + "replay", "state") is None:
            return None
        return await self.latest(key)

    async def run_start(self, run: str) -> float | None:
        """Where a replay run started: the position of its first entry in the replay log."""
        key = URN + "replay|log"
        if key not in self._ids and await self.find(URN + "replay", "log") is None:
            return None
        for r in await self.all(key):
            if r.get("run") == run and r.get("action") in ("load", "seek", "play"):
                return float(from_iso([r["position"]])[0])
        return None

    # --- the demonstrator's referee (scaffolding; FR-37) ---------------------------------------------
    async def score(self, kind: str, payload: dict) -> dict:
        _, _, body = await self.request("POST", f"/demonstrator/referee/{kind}", payload)
        return json.loads(body)


# --- models ------------------------------------------------------------------------------------
class Model:
    """Subclass this (§10.1)."""

    id = "model"
    label = "Model"
    description = ""
    max_rate = 100.0  # the highest replay rate it sustains (FR-37a)
    window = 60.0  # replay seconds per processing window, aligned to the dataset's start
    control = None  # (inputName, label, [fields]) of its control stream, if it takes settings

    @property
    def uid(self) -> str:
        return f"{URN}process:{self.id}"

    def system_body(self, restricted=False) -> dict:
        body = {"type": "SimpleProcess", "uniqueId": self.uid + (":restricted" if restricted else ""),
                "label": f"{self.label}, restricted outputs" if restricted else self.label,
                "description": "Outputs derived from CO₂ (restricted, FR-112)." if restricted else self.description,
                "definition": SOSA + "System", "assetType": "Process"}
        if not restricted:
            body["characteristics"] = [{"label": "Replay", "characteristics": [
                {"type": "Quantity", "name": "max_rate", "label": "Highest replay rate sustained",
                 "uom": {"code": "1"}, "value": self.max_rate}]}]
        return body

    async def setup(self, api: Api) -> None:
        """Register (FR-28): the process system under Models, its restricted subsystem, its control stream."""
        self.system = await api.create_system(self.system_body(), URN + "process:models")
        self.restricted = None
        if getattr(self, "uses_co2", False):
            self.restricted = await api.create_system(self.system_body(restricted=True), self.uid)
        self.control_key = None
        if self.control:
            name, label, fields = self.control
            self.control_key = await api.create_controlstream(self.system, {
                "name": label, "inputName": name, "schema": record(label, fields)})

    async def datasets(self, api: Api, ds: dict) -> bool:
        """Create this model's datastreams for a dataset; False while its inputs are not there."""
        return True

    async def process(self, api: Api, ds: dict, t0: float, t1: float, run: str) -> None:
        """One window [t0, t1) of dataset ``ds`` ({id, start, end}) under replay run ``run``."""

    def validate(self, api: Api, cmd: dict) -> None:
        """Check every parameter against the control stream's bounds; raise Rejected naming the bound."""
        if not self.control:
            raise Rejected("this model takes no commands")
        params = cmd.get("parameters", {})
        for f in self.control[2]:
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
                        raise Rejected(f"{n}={v:g} is outside [{lo:g}, {hi:g}]")
            elif con.get("values") and v not in con["values"]:
                raise Rejected(f"{n}={v!r} is not one of {', '.join(map(str, con['values']))}")

    async def on_command(self, api: Api, cmd: dict) -> str:
        return "applied"


class Runner:
    """Drives a model from the replay state, read once per real second (§10.2)."""

    MAX_WINDOWS = 120  # per step, so a long catch-up still lets other work through

    def __init__(self, model: Model, api: Api):
        self.model, self.api = model, api
        self.phase = "starting"
        self.detail = ""
        self.registered = False
        self.subscribed = asyncio.Event()
        self.sub_task = None
        self.made: dict[str, bool] = {}  # dataset -> its datastreams are created
        self.next: dict[tuple, float] = {}  # (dataset, run) -> start of the next window
        self.errors = 0

    async def register(self) -> None:
        api, m = self.api, self.model
        api.quiet = True  # registering at startup: counted, not drawn
        try:
            api.reset()
            await m.setup(api)
            self.made.clear()
        finally:
            api.quiet = False
        self.registered = True
        if m.control_key and self.sub_task is None:
            self.sub_task = asyncio.ensure_future(api.subscribe(m.control_key, self._on_command, self._on_open))
        elif not m.control_key:
            self.subscribed.set()

    async def _on_open(self, closed: bool = False) -> None:
        if closed:  # the server went away: register again and resubscribe once it answers (AT-38)
            self.subscribed.clear()
            self.registered = False
            self.phase, self.detail = "waiting", "the data server does not answer"
            return
        if not self.registered:
            try:
                await self.register()
            except (Unavailable, Refused):
                return
        self.subscribed.set()

    async def _on_command(self, cmd: dict) -> None:
        api, m = self.api, self.model
        try:
            m.validate(api, cmd)
        except Rejected as e:
            await api.command_status(m.control_key, cmd["id"], "REJECTED", str(e))
            return
        await api.command_status(m.control_key, cmd["id"], "ACCEPTED")
        try:
            msg = await m.on_command(api, cmd)
            await api.command_status(m.control_key, cmd["id"], "COMPLETED", msg or "")
        except Rejected as e:
            await api.command_status(m.control_key, cmd["id"], "REJECTED", str(e))
        except (Unavailable, Refused):
            raise
        except Exception as e:  # noqa: BLE001 - reported as the command's status
            await api.command_status(m.control_key, cmd["id"], "FAILED", f"{type(e).__name__}: {e}")

    async def step(self) -> None:
        """Once per real second: read the state, create datastreams for a new dataset, process whole windows."""
        api, m = self.api, self.model
        try:
            if not self.registered:
                await self.register()
            if not self.subscribed.is_set():
                self.phase, self.detail = "subscribing", ""
                return  # ready only once its subscription is open (AT-38)
            st = await api.replay_state()
            if not st or not st.get("dataset"):
                self.phase, self.detail = "ready", "no dataset loaded"
                return
            ds = {"id": st["dataset"], "start": float(from_iso([st["start"]])[0]), "end": float(from_iso([st["end"]])[0])}
            if not self.made.get(ds["id"]):
                api.quiet = not st.get("models_ready", False) and self.phase in ("starting", "subscribing")
                try:
                    self.made[ds["id"]] = await m.datasets(api, ds)
                finally:
                    api.quiet = False
                if not self.made[ds["id"]]:
                    self.phase, self.detail = "waiting", f"inputs for {ds['id']} are not there yet"
                    return
            run = st["run"]
            now = float(from_iso([st["time"]])[0])
            key = (ds["id"], run)
            if key not in self.next:
                pos = await api.run_start(run)
                pos = ds["start"] if pos is None else pos
                self.next[key] = ds["start"] + np.floor((pos - ds["start"]) / m.window) * m.window
            done = 0
            while done < self.MAX_WINDOWS:
                t0 = self.next[key]
                t1 = t0 + m.window
                last = t0 >= ds["end"] + 1
                if last or not (t1 <= now or (now >= ds["end"] and t0 <= ds["end"])):
                    break
                try:
                    await m.process(api, ds, t0, min(t1, ds["end"] + 1), run)
                except NotReady as e:
                    self.detail = f"waiting: {e}"
                    break
                self.next[key] = t1
                done += 1
            self.phase = "live"
            self.detail = f"{ds['id']}: up to {iso(min(self.next[key], ds['end'] + 1))}"
        except Unavailable as e:
            # The server did not answer: it may have restarted. Register again, and so declare this model's
            # datastreams again, once it answers (D-186), with or without a subscription to tell it so.
            self.registered = False
            self.phase, self.detail = "waiting", str(e)
        except Refused as e:
            self.errors += 1
            self.phase, self.detail = "waiting", f"refused: {e}"

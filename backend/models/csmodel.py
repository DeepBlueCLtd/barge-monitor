"""What every model is written against: the data server's Connected Systems interface (FR-35).

A model is a class with ``setup`` (register its process system, datastreams and
control stream: FR-28), ``step`` (process newly arrived data) and, optionally,
``on_command`` (take its settings as commands: FR-27). The ``Runner`` calls
them on the simulation clock (FR-13). The same model code runs:

* in the browser, one model per worker, its HTTP requests made with ``fetch``
  and carried by the relay like the display client's (``web/src/workers/model.worker.ts``);
* in CPython, in-process, for the tests and the ASGI deployment: the same
  requests, made of the same ASGI application (``barge/local_models.py``).

Models see only what the server serves: never the manifest or the position
(FR-37). Scores come from the demonstrator's referee through ``api.score``.
"""
from __future__ import annotations

import json

import numpy as np

SOSA = "http://www.w3.org/ns/sosa/"
DEF = "https://deepbluecltd.github.io/barge-monitor/def/"
SAMPLING_TIME = "http://www.opengis.net/def/property/OGC/0/SamplingTime"
QUANTITIES = ["air_temperature", "apparent_wind_speed", "relative_humidity", "pressure",
              "apparent_wind_direction", "solar_irradiance", "water_temperature"]
UNITS = {"air_temperature": "Cel", "apparent_wind_speed": "m/s", "relative_humidity": "%", "pressure": "hPa",
         "apparent_wind_direction": "deg", "solar_irradiance": "W/m2", "water_temperature": "Cel"}
LABELS = {"air_temperature": "Air temperature", "apparent_wind_speed": "Wind speed", "relative_humidity": "Humidity",
          "pressure": "Pressure", "apparent_wind_direction": "Wind direction", "solar_irradiance": "Solar irradiance",
          "water_temperature": "Water temp"}
PRECIP = ["none", "drizzle", "rain", "showers"]
SIM_EPOCH_UNIX = 1933286400  # the simulation epoch (2031-04-07T00:00:00Z): simulated seconds count from here
PAGE = 100_000  # observations asked for per request: the server's declared maximum


class Unavailable(Exception):
    """The data server is waiting or down: try again on the next step."""


class Refused(Exception):
    """The data server refused the call."""


class NotFound(Refused):
    """The resource is not there (any more)."""


# --- SWE Common helpers for model schemas ----------------------------------------------
def time_field(name="time", label="Time"):
    return {"type": "Time", "name": name, "label": label, "definition": SAMPLING_TIME,
            "uom": {"href": "http://www.opengis.net/def/uom/ISO-8601/0/Gregorian"}}


def quantity(name, label, uom, definition=None, lo=None, hi=None):
    q = {"type": "Quantity", "name": name, "label": label, "definition": definition or DEF + name, "uom": {"code": uom}}
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


# --- the interface: Connected Systems over HTTP -------------------------------------------
def iso(t: float) -> str:
    return str(np.datetime64(int(round(SIM_EPOCH_UNIX + float(t))), "s")) + "Z"


def from_iso(values) -> np.ndarray:
    if not len(values):
        return np.empty(0)
    a = np.array([v[:-1] if isinstance(v, str) and v.endswith("Z") else v for v in values], dtype="datetime64[ms]")
    return a.astype("int64") / 1000.0 - SIM_EPOCH_UNIX


def _plain(v):
    """A column's values as JSON: no NaN, no numpy scalars."""
    if isinstance(v, np.ndarray) and v.dtype.kind in "fiub":
        f = v.astype(float)
        return [None if x != x else x for x in f.tolist()]
    out = v.tolist() if isinstance(v, np.ndarray) else list(v)
    return [None if isinstance(x, float) and x != x else (x.item() if isinstance(x, np.generic) else x) for x in out]


class Api:
    """What a model does with the data server, as OGC API – Connected Systems requests (docs/v4-interfaces.md §7).

    ``transport`` makes one HTTP request: ``await transport(method, path, headers, body)`` returns
    ``(status, headers, body)`` or raises ``Unavailable`` when there is no answer. A model names a
    datastream by a key, ``system:outputName``, which outlives server restarts; the public
    identifier behind it is looked up again whenever the server says it no longer exists (a schema
    that changes gives a new identifier) or a new server instance answers.
    """

    def __init__(self, model_id: str, transport, now=None):
        self.model = model_id
        self.quiet = False
        self.clock = {"t": 0.0, "playing": False}
        self._transport = transport
        self._now = now
        self._instance = None
        self._ids: dict[str, str] = {}  # key -> current public identifier
        self._made: dict[str, tuple] = {}  # key -> (path, body) of what this model created
        self._types: dict[str, dict] = {}  # public identifier -> {field: SWE type}
        self._systems: dict[str, str] = {}  # uniqueId -> system id

    def now(self) -> float:
        return float(self._now()) if self._now else float(self.clock["t"])

    def tap(self, dst: str, summary: str, content=None) -> None:
        """Capture a call into, or a result out of, the scientific libraries."""

    # --- one request ------------------------------------------------------------------
    async def request(self, method: str, path: str, body=None, ctype: str = "application/json", ok=(200, 201)):
        headers = {"accept": "application/json, application/swe+json", "x-tap-model": self.model}
        if self.quiet:
            headers["x-tap-quiet"] = "1"
        raw = None
        if body is not None:
            raw = json.dumps(body, separators=(",", ":"), allow_nan=False).encode()
            headers["content-type"] = ctype
        status, rh, payload = await self._transport(method, path, headers, raw)
        inst = rh.get("x-server-instance")
        if inst and inst != self._instance:
            if self._instance is not None:  # a new server instance: identifiers may have changed
                self._ids.clear()
                self._types.clear()
            self._instance = inst
        if status == 503:
            raise Unavailable("the data server is waiting")
        if status not in ok:
            try:
                why = json.loads(payload or b"{}").get("description", "")
            except ValueError:
                why = ""
            raise (NotFound if status == 404 else Refused)(f"{method} {path}: {status} {why}".strip())
        return status, rh, payload

    @staticmethod
    def _located(headers: dict) -> str:
        return headers["location"].rstrip("/").rsplit("/", 1)[-1]

    async def _create(self, path: str, body: dict) -> str:
        """POST a resource; an identical one already there answers 409 with its Location."""
        _, rh, _ = await self.request("POST", path, body, ok=(201, 409))
        return self._located(rh)

    # --- registering (FR-28) -------------------------------------------------------------
    async def create_system(self, body: dict) -> str:
        return await self._create("/systems/models/subsystems", body)

    async def create_datastream(self, system_id: str, body: dict) -> str:
        key = f"{system_id}:{body['outputName']}"
        made = {"name": body.get("name", body["outputName"]), "outputName": body["outputName"],
                "schema": {"obsFormat": "application/swe+json", "recordSchema": body["schema"]}}
        self._made[key] = (f"/systems/{system_id}/datastreams", made)
        self._ids[key] = await self._create(*self._made[key])
        return key

    async def create_controlstream(self, system_id: str, body: dict) -> str:
        name = body.get("inputName") or "settings"
        key = f"{system_id}:{name}"
        made = {"name": body.get("name", name), "inputName": name,
                "schema": {"commandFormat": "application/json", "parametersSchema": body["schema"]}}
        self._made[key] = (f"/systems/{system_id}/controlstreams", made)
        self._ids[key] = await self._create(*self._made[key])
        return key

    # --- finding other systems' datastreams ----------------------------------------------
    async def _system_id(self, uid: str):
        if uid not in self._systems:
            for parent in ("models", "barge"):
                _, _, payload = await self.request("GET", f"/systems/{parent}/subsystems?limit=1000")
                for s in json.loads(payload)["items"]:
                    self._systems[s["uniqueId"]] = s["id"]
        return self._systems.get(uid)

    async def _lookup(self, key: str):
        system_id, _, output = key.partition(":")
        _, _, payload = await self.request("GET", f"/systems/{system_id}/datastreams?limit=1000")
        return next((d["id"] for d in json.loads(payload)["items"] if d["outputName"] == output), None)

    async def find(self, system_uid: str, output_name: str, since=None):
        """The key of another system's datastream, or None while it is not there."""
        system_id = await self._system_id(system_uid)
        if system_id is None:
            return None
        key = f"{system_id}:{output_name}"
        ds = await self._lookup(key)
        if ds is None:
            return None
        self._ids[key] = ds
        return key

    async def _id(self, key: str) -> str:
        if key not in self._ids:
            ds = await self._create(*self._made[key]) if key in self._made else await self._lookup(key)
            if ds is None:
                raise Refused(f"datastream {key} is not published")
            self._ids[key] = ds
        return self._ids[key]

    async def _on(self, key: str, call):
        """Run ``call(public id)``; if the identifier has gone (a new schema, a new offering), look it up once more."""
        try:
            return await call(await self._id(key))
        except NotFound:
            self._ids.pop(key, None)
            return await call(await self._id(key))

    # --- observations --------------------------------------------------------------------
    async def _field_types(self, ds: str) -> dict:
        if ds not in self._types:
            _, _, payload = await self.request("GET", f"/datastreams/{ds}/schema?obsFormat=application%2Fswe%2Bjson")
            self._types[ds] = {f["name"]: f["type"] for f in json.loads(payload)["recordSchema"]["fields"]}
        return self._types[ds]

    async def read(self, key: str, t0: float, t1: float, fields=None) -> dict:
        """Observations with t0 <= time <= t1 as columns: ``{"t": seconds, field: array}``.
        Numbers arrive as float arrays (NaN where missing), everything else as object arrays."""
        async def go(ds):
            types = await self._field_types(ds)
            names = [n for n in types if n != "time" and (fields is None or n in fields)]
            lo, hi = np.ceil(max(float(t0), -SIM_EPOCH_UNIX)), np.floor(float(t1))
            if hi < lo:
                rows = []
            else:
                rows, path = [], f"/datastreams/{ds}/observations?phenomenonTime={iso(lo)}/{iso(hi)}&limit={PAGE}"
                while path:
                    _, rh, payload = await self.request("GET", path)
                    rows += json.loads(payload)
                    nxt = rh.get("link", "")
                    path = nxt[nxt.index("/datastreams/"):nxt.index(">")] if 'rel="next"' in nxt else None
            cols = {"t": from_iso([r["time"] for r in rows])}
            for n in names:
                vals = [r.get(n) for r in rows]
                if types[n] == "Time":
                    cols[n] = np.array([np.nan if v is None else from_iso([v])[0] for v in vals], dtype=float)
                elif types[n] in ("Quantity", "Count", "Boolean"):
                    cols[n] = np.array([np.nan if v is None else v for v in vals], dtype=float)
                else:
                    a = np.empty(len(vals), dtype=object)
                    a[:] = vals
                    cols[n] = a
            return cols
        return await self._on(key, go)

    async def publish(self, key: str, cols: dict, replace: bool = False) -> int:
        """Publish columns as observations. ``replace`` puts them in place of everything published before
        (plain HTTP PUT on the collection: Connected Systems has no such operation)."""
        t = np.asarray(cols["t"], dtype=float)
        names = [k for k in cols if k != "t"]
        times = [iso(x) for x in t.tolist()]
        made = self._made.get(key)
        times_too = {f["name"] for f in made[1]["schema"]["recordSchema"]["fields"] if f["type"] == "Time"} if made else set()
        columns = [[None if x is None or x != x else iso(x) for x in np.asarray(cols[k], dtype=float).tolist()]
                   if k in times_too else _plain(cols[k]) for k in names]
        rows = [dict(zip(["time"] + names, vals)) for vals in zip(times, *columns)] if names else [{"time": x} for x in times]
        if not rows and not replace:
            return 0

        async def go(ds):
            _, _, payload = await self.request("PUT" if replace else "POST", f"/datastreams/{ds}/observations", rows,
                                               ctype="application/swe+json")
            return int(json.loads(payload).get("created", 0))
        return await self._on(key, go)

    # --- commands (FR-27) -------------------------------------------------------------------
    async def commands(self, key: str) -> list:
        """Commands waiting on this model's control stream."""
        async def go(cs):
            _, _, payload = await self.request("GET", f"/controlstreams/{cs}/commands?statusCode=PENDING")
            return [{"id": c["id"], "issueTime": c["issueTime"], "parameters": c["parameters"]} for c in json.loads(payload)["items"]]
        return await self._on(key, go)

    async def command_status(self, cmd_id: str, status: str, message: str = "") -> None:
        await self.request("POST", f"/commands/{cmd_id}/status", {"statusCode": status, **({"message": message} if message else {})})

    # --- the demonstrator's referee (scaffolding; FR-37) --------------------------------------
    async def score(self, kind: str, payload: dict) -> dict:
        _, _, body = await self.request("POST", f"/demonstrator/referee/{kind}", payload)
        return json.loads(body)


# --- models ----------------------------------------------------------------------------------
class Model:
    """Subclass this. ``interval`` is in simulated seconds."""

    id = "model"
    label = "Model"
    description = ""
    interval = 60.0
    command_interval = None  # simulated seconds between looks at its control stream; None: at each step
    catch_up_chunk = 6 * 3600.0  # how much history one step takes while catching up
    start_from = "history"  # "history": process the history from its start; "now": only what arrives

    def system_body(self) -> dict:
        return {"uniqueId": f"urn:x-barge:process:{self.id}", "label": self.label, "description": self.description,
                "systemType": SOSA + "System", "assetType": "Process"}

    async def setup(self, api: Api) -> None:
        self.system = await api.create_system(self.system_body())

    async def step(self, api: Api, t0: float, t1: float) -> float:
        """Process data in (t0, t1]; return the time processed up to."""
        return t1

    async def on_command(self, api: Api, cmd: dict) -> str:
        return "no settings to apply"

    async def initial(self, api: Api) -> bool:
        """For a model that starts from now: a first run once its inputs exist. True when done."""
        return True


class Runner:
    """Steps a model on the simulation clock. Nothing happens while the clock stands still,
    except catching up on history at startup (counted, not drawn)."""

    def __init__(self, model: Model, api: Api):
        self.model, self.api = model, api
        self.ready = False
        self.last: float | None = None
        self.control_key: str | None = None
        self.phase = "starting"
        self.detail = ""
        self.errors = 0
        self.asked: float = -1.0  # when it last looked at its control stream
        self.initial_done = False
        self.retry_at = -1.0  # after a step that found nothing new, wait before trying again

    @property
    def caught_up(self) -> bool:
        return self.last is not None and self.api.now() - self.last < max(2 * self.model.interval, 120.0)

    async def commands_due(self, playing: bool, wake: bool) -> list:
        """Commands waiting on the model's control stream. Connected Systems publish/subscribe (Part 3) is
        unpublished, so a model polls, on the simulation clock. ``wake``: the demonstrator shell says a
        viewer's click is waiting while the clock stands still, and lets it through."""
        m, now = self.model, self.api.now()
        if not self.control_key:
            return []
        every = m.command_interval if m.command_interval is not None else m.interval
        if not (wake or (playing and (self.asked < 0 or now - self.asked >= every))):
            return []
        self.asked = now
        return await self.api.commands(self.control_key)

    async def tick(self, playing: bool, wake: bool = False) -> None:
        api, m = self.api, self.model
        now = api.now()
        try:
            if not self.ready:
                api.quiet = True
                await m.setup(api)
                self.control_key = getattr(m, "control_key", None)
                self.ready = True
                self.last = 0.0 if m.start_from == "history" else now
                self.phase = "catching up"
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
                if done <= self.last and upto >= now:
                    pass  # waiting for another model's output
                self.last = max(self.last, done)
                total = max(now, 1.0)
                self.detail = f"{min(100, round(100 * self.last / total))}% of history"
                if self.caught_up:
                    self.phase, self.detail = "live", ""
                return
            api.quiet = False
            self.phase, self.detail = "live", ""
            for cmd in await self.commands_due(playing, wake):
                await api.command_status(cmd["id"], "ACCEPTED")
                try:
                    msg = await m.on_command(api, cmd)
                    await api.command_status(cmd["id"], "COMPLETED", msg or "")
                except (Unavailable, Refused):
                    raise
                except Exception as e:  # noqa: BLE001 - reported as the command's status
                    await api.command_status(cmd["id"], "FAILED", f"{type(e).__name__}: {e}")
            if playing and now - self.last >= m.interval and now >= self.retry_at:
                done = await m.step(api, self.last, now)
                if done <= self.last:  # its inputs are not there yet: try again a little later
                    self.retry_at = now + min(m.interval, 10.0)
                self.last = max(self.last, done)
        except Unavailable as e:
            self.detail = f"waiting: {e}"
        except Refused as e:
            self.errors += 1
            self.detail = f"refused: {e}"
        finally:
            api.quiet = False

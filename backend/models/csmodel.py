"""What every model is written against: the data server's internal interface (FR-35).

A model is a class with ``setup`` (register its process system, datastreams and
control stream: FR-28), ``step`` (process newly arrived data) and, optionally,
``on_command`` (take its settings as commands: FR-27). The ``Runner`` calls
them on the simulation clock (FR-13). The same model code runs:

* in the browser, one model per worker, its calls carried over a MessagePort
  to the back-end worker (``PortApi``, used by ``web/src/workers/model.worker.ts``);
* in CPython, in-process, for the tests and the ASGI deployment (``LocalApi``).

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


class Unavailable(Exception):
    """The data server is waiting or down: try again on the next step."""


class Refused(Exception):
    """The data server refused the call."""


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
    return {"type": "DataRecord", "label": label, "fields": fields}


def measurement_fields():
    """The seven quantities, with the definitions of the raw parameters they come from."""
    return [quantity(p, LABELS[p], UNITS[p]) for p in QUANTITIES]


# --- the wire format between a model worker and the back-end worker ----------------------
def pack_cols(cols: dict) -> dict:
    out = {}
    for k, v in cols.items():
        a = np.asarray(v)
        if a.dtype.kind in "fiub":
            out[k] = ["f8", np.ascontiguousarray(a, dtype=np.float64).tobytes()]
        else:
            out[k] = ["s", [None if x is None or (isinstance(x, float) and x != x) else x for x in a.tolist()]]
    return out


def unpack_cols(d: dict) -> dict:
    out = {}
    for k, (kind, v) in d.items():
        if kind == "f8":
            if hasattr(v, "to_bytes"):  # a JavaScript Uint8Array, in Pyodide
                v = v.to_bytes()
            out[k] = np.frombuffer(bytes(v), dtype=np.float64).copy()
        else:
            out[k] = np.array(list(v), dtype=object)
    return out


def pack(value):
    """Arguments and results: column dicts packed, everything else JSON-able."""
    if isinstance(value, dict) and "t" in value and isinstance(value.get("t"), (np.ndarray, list)):
        return {"__cols__": pack_cols(value)}
    if isinstance(value, dict):
        return {k: pack(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [pack(v) for v in value]
    if isinstance(value, np.generic):
        return value.item()
    return value


def unpack(value):
    if isinstance(value, dict) and "__cols__" in value:
        return unpack_cols(value["__cols__"])
    if isinstance(value, dict):
        return {k: unpack(v) for k, v in value.items()}
    if isinstance(value, list):
        return [unpack(v) for v in value]
    return value


# --- the interface ------------------------------------------------------------------------
class Api:
    """Async calls to the data server's internal interface (docs/v4-interfaces.md §7)."""

    def __init__(self, model_id: str):
        self.model = model_id
        self.quiet = False
        self.clock = {"t": 0.0, "playing": False}

    async def _call(self, op, **args):
        raise NotImplementedError

    async def call(self, op, **args):
        r = await self._call(op, **args)
        if r.get("ok"):
            return r.get("result")
        if r.get("status") in ("waiting", "down"):
            raise Unavailable(r.get("error", r.get("status")))
        raise Refused(r.get("error", "refused"))

    def now(self) -> float:
        return float(self.clock["t"])

    def tap(self, dst: str, summary: str, content=None) -> None:
        """Capture a call into, or a result out of, the scientific libraries."""

    async def create_system(self, body):
        return await self.call("create_system", body=body)

    async def create_datastream(self, system_id, body):
        return await self.call("create_datastream", system_id=system_id, body=body)

    async def create_controlstream(self, system_id, body):
        return await self.call("create_controlstream", system_id=system_id, body=body)

    async def find(self, system_uid, output_name, since=None):
        """A datastream's key. ``since``: the earliest time this model will read (retention keeps it)."""
        return await self.call("find", system_uid=system_uid, output_name=output_name, since=since)

    async def read(self, key, t0, t1, fields=None):
        return await self.call("read", key=key, t0=float(t0), t1=float(t1), fields=fields)

    async def publish(self, key, cols, replace=False):
        return await self.call("publish", key=key, cols=cols, replace=replace)

    async def commands(self, key):
        return await self.call("commands", key=key)

    async def command_status(self, cmd_id, status, message=""):
        return await self.call("command_status", cmd_id=cmd_id, status=status, message=message)

    async def score(self, kind, payload):
        return await self.call("score", kind=kind, payload=payload)


class LocalApi(Api):
    """In-process: CPython tests and the ASGI deployment. Columns pass through the same packing."""

    def __init__(self, model_id, host, runtime):
        super().__init__(model_id)
        self.host = host
        self.rt = runtime

    async def _call(self, op, **args):
        r = self.host.call(self.model, op, unpack(pack(args)), quiet=self.quiet)
        return unpack(pack(r))

    def now(self):
        return self.rt.now()

    def tap(self, dst, summary, content=None):
        src, to = ("models", "scilibs") if dst == "scilibs" else ("scilibs", "models")
        self.rt.tap.emit(src, to, "I", f"{self.model}: {summary}", content, model=self.model, quiet=self.quiet)


class PortApi(Api):
    """In a model worker: calls travel to the back-end worker; ``rpc`` and ``post_tap`` are JS functions."""

    def __init__(self, model_id, rpc, post_tap):
        super().__init__(model_id)
        self._rpc = rpc
        self._post_tap = post_tap

    async def _call(self, op, **args):
        from pyodide.ffi import to_js
        from js import Object

        payload = to_js(pack(args), dict_converter=Object.fromEntries)
        reply = await self._rpc(op, payload, self.quiet)
        return unpack(reply.to_py())

    def tap(self, dst, summary, content=None):
        src, to = ("models", "scilibs") if dst == "scilibs" else ("scilibs", "models")
        self._post_tap(src, to, f"{self.model}: {summary}", json.dumps(content, default=str)[:4000], self.quiet)


# --- models ----------------------------------------------------------------------------------
class Model:
    """Subclass this. ``interval`` is in simulated seconds."""

    id = "model"
    label = "Model"
    description = ""
    interval = 60.0
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
        self.inbox: list[dict] = []  # commands the data server has passed on (server → models)
        self.initial_done = False
        self.retry_at = -1.0  # after a step that found nothing new, wait before trying again

    def notify(self, message: dict) -> None:
        if message.get("type") == "command":
            self.inbox.append(message["command"])

    @property
    def caught_up(self) -> bool:
        return self.last is not None and self.api.now() - self.last < max(2 * self.model.interval, 120.0)

    async def tick(self, playing: bool) -> None:
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
            while self.inbox:
                cmd = self.inbox.pop(0)
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

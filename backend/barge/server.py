"""The data server (C-04): one start of the stand-in for OpenSensorHub.

An instance is created at each server start. It freezes the field offering
(FR-51) and drops the store adapter's index so the adapter rebuilds it; then its
modules start: the CSV importer registers, lists the data folder and, at the first
start of a page load, imports Mission A silently (FR-15). Until then the server
answers nothing (4.7, §9.1: no 503 and no instance identifier).
The store of created resources (``store.py``: systems, datastreams, control
streams, commands and observations) outlives it, as OpenSensorHub's database does.

The server holds no client sessions (FR-06). It serves:

* the collection platform and its bow and stern sensors, whose observations
  it reads from the store through the store adapter (store queries, S);
* the Models system, under which each model creates its own process system,
  datastreams and control stream (FR-28), and the observations they publish.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from . import config as C
from . import swe
from .adapter import StoreAdapter
from .accounts import USERS
from .fields import RAW, Offering
from .store import URN, Store
from .tap import Tap

SOSA = "http://www.w3.org/ns/sosa/"
# The profile the 4.1 display client is built against. The 4.7 template (contracts/profile.json) is served
# from plan Phase 7, with the client that reads it (decision D-252).
INTERIM_PROFILE = "interim/profile-v4.1.json"
SENSORS = ("bow", "stern")
QC_RANGE = {
    "air_temperature": (-30.0, 50.0), "relative_humidity": (0.0, 100.0), "pressure": (900.0, 1100.0),
    "apparent_wind_speed": (0.0, 60.0), "apparent_wind_direction": (0.0, 360.0),
    "solar_irradiance": (0.0, 1500.0), "water_temperature": (-2.0, 35.0),
}
# A reading further than this from the mean of its two neighbours is suspect (QARTOD spike test).
QC_SPIKE = {"air_temperature": 0.8, "relative_humidity": 6.0, "pressure": 0.5, "apparent_wind_speed": 3.5,
            "solar_irradiance": 150.0, "water_temperature": 0.4}


def contracts_dir() -> Path:
    here = Path(__file__).resolve().parent
    for cand in (here.parent / "contracts", here.parent.parent / "contracts"):
        if cand.is_dir():
            return cand
    raise FileNotFoundError("contracts directory not found")


def iso(t) -> str:
    return str(np.datetime64(int(round(C.SIM_EPOCH_UNIX + float(t))), "s")) + "Z"


def iso_many(t) -> list[str]:
    secs = (C.SIM_EPOCH_UNIX + np.round(np.asarray(t, dtype=float))).astype("int64").astype("datetime64[s]")
    return [s + "Z" for s in secs.astype(str).tolist()]


def iso_real(u: float) -> str:
    """Real time (Unix seconds) as ISO 8601 UTC, to the millisecond: command and status report times."""
    return str(np.datetime64(int(round(float(u) * 1000)), "ms")) + "Z"


def parse_iso(s: str) -> float:
    s = s.strip()
    if s.endswith("Z"):
        s = s[:-1]
    if "+" in s[10:]:
        raise ValueError("only UTC (Z) times are supported")
    return float(np.datetime64(s, "ms").astype("int64") / 1000.0 - C.SIM_EPOCH_UNIX)


def qc_flags(name: str, v: np.ndarray, wd_variable: np.ndarray | None = None) -> np.ndarray:
    """QARTOD flags, computed on the way out; stored records are never altered (FR-32)."""
    flag = np.full(len(v), 1.0)
    lo, hi = QC_RANGE[name]
    with np.errstate(invalid="ignore"):
        flag[(v < lo) | (v > hi)] = 4.0
        if name in QC_SPIKE and len(v) >= 3:
            mid = 0.5 * (v[:-2] + v[2:])
            spike = np.abs(v[1:-1] - mid) > QC_SPIKE[name]
            core = flag[1:-1]
            core[spike & (core == 1.0)] = 3.0
    if wd_variable is not None:
        flag[wd_variable == 1] = 2.0
    flag[np.isnan(v) & (flag != 2.0)] = 9.0
    return flag


class Server:
    def __init__(self, runtime, number: int, offering: Offering, tap: Tap):
        self.rt = runtime
        self.offering = offering.copy()
        self.tap = tap
        self.number = number  # internal only: the server serves no instance identifier (4.7, §9.1)
        self.adapter = (getattr(runtime, "adapter_class", None) or StoreAdapter)(runtime.logger, tap)
        self.indexed = False  # the adapter's index is rebuilt
        self.starting = False  # its modules are starting (the CSV importer)
        self.ready = False  # answering requests
        self.store: Store = runtime.store
        self.lie_about_profile = runtime.lie_about_profile
        self.profile = json.loads((contracts_dir() / INTERIM_PROFILE).read_text())
        raw = self.offering.raw()
        fields = [swe.time_field()]
        for f in raw:
            fields.append(swe.component(f, quality=f.swe_type == "Quantity"))
            if f.swe_type == "Quantity":
                fields.append(swe.qc_field(f))
        self.sensor_schema = {s: swe.record(fields, f"{s.capitalize()} sensor record") for s in SENSORS}
        self.ids = self._configure()

    # --- the server's configuration: its systems, and the sensors' datastreams for this offering ---------
    def _configure(self) -> dict:
        """What OpenSensorHub's configuration creates at start (docs/v4-interfaces.md §6): the platform, its
        sensors and their CO₂ analysers (restricted), Models, and a workspace per user. Each sensor's
        ``weather`` datastream is read from the 4.1 logger store through the adapter, for the 4.1 display client
        and models (D-271); its schema is this start's offering, so a new offering is a new datastream (FR-51).
        The CSV importer registers itself, at each start, once the index is rebuilt (``importer.py``)."""
        st = self.store
        add = st.add_system
        barge, _ = add(URN + "platform:barge", "Collection platform", "The uncrewed electric cargo barge. It records no position.",
                       SOSA + "Platform", "Platform")
        ids = {"barge": barge["id"]}
        for s in SENSORS:
            sensor, _ = add(f"{URN}sensor:{s}", f"{s.capitalize()} sensor", "Seven parameters at 1 Hz.", SOSA + "Sensor",
                            "Equipment", parent=barge["id"])
            ids[s] = sensor["id"]
            co2, _ = add(f"{URN}sensor:{s}:co2", f"{s.capitalize()} CO₂ analyser",
                         "Carbon dioxide at the sensor, in parts per million. Restricted (FR-93).", SOSA + "Sensor",
                         "Equipment", parent=sensor["id"])
            ids[f"{s}:co2"] = co2["id"]
            d, _ = st.add_datastream(sensor["id"], "weather", f"{s.capitalize()} sensor record", self.sensor_schema[s],
                                     kind="sensor", sensor=s)
            ids[f"{s}:weather"] = d["id"]
        models, _ = add(URN + "process:models", "Models",
                        "A home for models that turn sensor data into insight. Each model is a process system of its own, "
                        "created by the model itself.", SOSA + "System", "Process")
        ids["models"] = models["id"]
        for u in USERS:
            w, _ = add(f"{URN}workspace:{u}", f"Workspace of {u}", "Data of interest saved by this user (FR-94).",
                       SOSA + "System", "Other", owner=u)
            ids[f"workspace:{u}"] = w["id"]
        return ids

    # --- start-up: no answer while the index is rebuilt and the modules start (FR-47) --------
    def index_step(self) -> bool:
        """One step of rebuilding the adapter's index; True once it is rebuilt. The runtime then starts the
        server's modules, and the server answers once they have started."""
        if not self.indexed:
            self.indexed = self.adapter.index_step()
        return self.indexed

    def phase(self) -> str:
        return "ready" if self.ready else ("import" if self.indexed else "index")

    def progress(self) -> dict:
        return {"indexed": self.adapter.indexed_records(), "stored": self.adapter.store_records()}

    # --- datastreams: the offering applied to every schema (FR-50..52) ------------
    def visible(self, rec: dict) -> dict:
        return dict(rec, fields=[f for f in rec["fields"] if f["name"] == "time" or self.offering.keep(f["name"])])

    def served(self, d: dict) -> bool:
        """Listed and served: not replaced by a newer schema, and with at least one output published (FR-52).
        A datastream with every output switched off still takes its model's observations (AT-12)."""
        return not d["replaced"] and len(self.visible(d["schema"])["fields"]) > 1

    def time_range(self, d: dict):
        if d["kind"] == "sensor":
            return self.adapter.time_range(d["sensor"])
        return d["series"].span()

    # --- profile (FR-40, FR-41) ------------------------------------------------------
    def satisfies_profile(self) -> list[dict]:
        """Essential sources this offering does not satisfy (empty when it does)."""
        problems = []
        for e in self.profile["essentials"]:
            ds = self.store.datastream(e["system"], e["datastream"])
            rec = self.visible(ds["schema"]) if ds and self.served(ds) else None
            fld = rec and next((f for f in rec["fields"] if f["name"] == e["field"]), None)
            if not fld:
                problems.append({"id": e["id"], "reason": "missing"})
            elif fld["type"] != e["type"]:
                problems.append({"id": e["id"], "reason": "wrong type"})
            elif (fld.get("uom") or {}).get("code") != e.get("uom"):
                problems.append({"id": e["id"], "reason": "wrong unit"})
        return problems

    def claims_profile(self) -> bool:
        return self.lie_about_profile or not self.satisfies_profile()

    # --- reading the store through the adapter (FR-21) ------------------------------
    def sensor_records(self, sensor, t0, t1, limit=None, offset=0, fields=None, why="observation request",
                       quiet=False) -> dict:
        """Records from the store, with QARTOD flags computed on the way out (FR-32)."""
        names = [f.name for f in RAW] if fields is None else [n for n in fields if n in {f.name for f in RAW}]
        self.tap.emit("server", "adapter", "S", f"store query: {sensor}, {len(names)} fields", {
            "op": "read", "sensors": [sensor], "fields": names,
            "period": [iso(max(t0, 0)) if np.isfinite(t0) else "..", iso(t1) if np.isfinite(t1) else ".."],
            "limit": limit, "offset": offset, "source": "raw records", "for": why}, quiet=quiet)
        pad = 1
        lo_off = max(0, offset - pad)
        lead = offset - lo_off
        r = self.adapter.read(sensor, t0, t1, None if limit is None else limit + lead + pad, lo_off, quiet=quiet)
        n = max(0, min(len(r["t"]) - lead, limit if limit is not None else len(r["t"])))
        out = {"t": r["t"][lead:lead + n]}
        for name in names:
            v = r[name]
            out[name] = v[lead:lead + n]
            if name == "precipitation_type":
                continue
            flags = qc_flags(name, v, r["wd_variable"] if name == "apparent_wind_direction" else None)
            out[f"{name}_qc"] = flags[lead:lead + n]
        self.tap.emit("adapter", "server", "I", f"{n} {sensor} records as columns",
                      {"columns": list(out), "records": int(n)}, quiet=quiet)
        return out

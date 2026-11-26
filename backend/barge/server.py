"""The data server (C-04): one running instance of the Connected Systems server.

An instance is created at each server start. It freezes the field offering
(FR-51), drops the store adapter's index so the adapter rebuilds it while the
server waits (FR-47), and carries a fresh instance identifier. The store and
the registry of created resources (the models' systems, datastreams and
observations) outlive it.

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
from .fields import RAW, Offering, schema_id
from .registry import Registry
from .tap import Tap

SOSA = "http://www.w3.org/ns/sosa/"
URN = "urn:x-barge:"
PROFILE_URI = "https://deepbluecltd.github.io/barge-monitor/profile/v4"
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
        self.instance = f"{runtime.seed}-{number}"
        self.adapter = (getattr(runtime, "adapter_class", None) or StoreAdapter)(runtime.logger, tap)
        self.ready = False
        self.registry: Registry = runtime.registry
        self.lie_about_profile = runtime.lie_about_profile
        self.profile = json.loads((contracts_dir() / "profile.json").read_text())
        raw = self.offering.raw()
        fields = [swe.time_field()]
        for f in raw:
            fields.append(swe.component(f, quality=f.swe_type == "Quantity"))
            if f.swe_type == "Quantity":
                fields.append(swe.qc_field(f))
        self.sensor_schema = {s: swe.record(fields, f"{s.capitalize()} sensor record") for s in SENSORS}
        self.systems = {
            "barge": self._system("barge", "Platform", "Collection platform", "PhysicalSystem",
                                  "The uncrewed electric cargo barge. It records no position."),
            "bow": self._system("bow", "Sensor", "Bow sensor", "PhysicalSystem", "Seven parameters at 1 Hz.", parent="barge"),
            "stern": self._system("stern", "Sensor", "Stern sensor", "PhysicalSystem", "Seven parameters at 1 Hz.", parent="barge"),
            "models": self._system("models", "System", "Models", "AggregateProcess",
                                   "A home for models that turn sensor data into insight. Each model is a process "
                                   "system of its own, created by the model itself.", asset="Process"),
        }

    # --- start-up: waiting mode while the index is rebuilt (FR-47) ----------------
    def index_step(self) -> bool:
        done = self.adapter.index_step()
        if done:
            self.ready = True
        return done

    def progress(self) -> dict:
        return {"indexed": self.adapter.indexed_records(), "stored": self.adapter.store_records()}

    # --- systems ------------------------------------------------------------------
    @staticmethod
    def _system(sid, stype, label, sml_type, desc, parent=None, asset=None):
        s = {"type": sml_type, "id": sid, "uniqueId": f"{URN}{'process' if asset else stype.lower()}:{sid}",
             "label": label, "description": desc, "definition": SOSA + stype, "systemType": SOSA + stype,
             "assetType": asset or "Equipment"}
        if parent:
            s["parent"] = parent
        return s

    def all_systems(self) -> dict:
        return {**self.systems, **self.registry.systems}

    # --- datastreams: the offering applied to every schema (FR-50..52) ------------
    def _visible(self, rec: dict) -> dict:
        return dict(rec, fields=[f for f in rec["fields"] if f["name"] == "time" or self.offering.keep(f["name"])])

    def datastreams(self, hidden: bool = False) -> dict:
        """Public id -> datastream, for this instance's offering. ``hidden`` adds those with every output switched
        off: they are not served, but their model goes on publishing to them (FR-52, AT-12)."""
        out = {}
        for s in SENSORS:
            rec = self._visible(self.sensor_schema[s])
            ds_id = schema_id(f"{s}-weather", [f["name"] for f in rec["fields"]])
            out[ds_id] = {"id": ds_id, "key": f"{s}:weather", "name": f"{s.capitalize()} sensor record",
                          "outputName": "weather", "system": s, "kind": "sensor", "sensor": s, "schema": rec}
        for key, d in self.registry.datastreams.items():
            if d["system"] not in self.registry.systems:
                continue
            rec = self._visible(d["schema"])
            if len(rec["fields"]) < 2 and not hidden:
                continue  # every output switched off: nothing to publish (FR-52)
            ds_id = schema_id(f"{d['system']}-{d['outputName']}", [f["name"] for f in rec["fields"]])
            out[ds_id] = {"id": ds_id, "key": key, "name": d["name"], "outputName": d["outputName"],
                          "system": d["system"], "kind": "model", "schema": rec, "series": d["series"]}
        return out

    def ds_by_key(self, key: str) -> dict | None:
        return next((d for d in self.datastreams().values() if d["key"] == key), None)

    def controlstreams(self) -> dict:
        out = {}
        for key, c in self.registry.controlstreams.items():
            if c["system"] not in self.registry.systems:
                continue
            cs_id = schema_id(f"{c['system']}-{c['inputName']}", [f["name"] for f in c["schema"]["fields"]])
            out[cs_id] = dict(c, id=cs_id)
        return out

    def time_range(self, d: dict):
        if d["kind"] == "sensor":
            return self.adapter.time_range(d["sensor"])
        s = d["series"]
        return (float(s.t[0]), float(s.t[-1])) if len(s) else None

    # --- profile (FR-40, FR-41) ------------------------------------------------------
    def satisfies_profile(self) -> list[dict]:
        """Essential sources this offering does not satisfy (empty when it does)."""
        problems = []
        systems = self.all_systems()
        dss = list(self.datastreams().values())
        for e in self.profile["essentials"]:
            sysm = next((s for s in systems.values() if s["uniqueId"] == e["system"]), None)
            ds = sysm and next((d for d in dss if d["system"] == sysm["id"] and d["outputName"] == e["datastream"]), None)
            fld = ds and next((f for f in ds["schema"]["fields"] if f["name"] == e["field"]), None)
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

    # --- commands (FR-27) --------------------------------------------------------------
    def validate_command(self, cs: dict, params: dict) -> None:
        """Check a command against its control stream's schema. Raise ValueError('name|message')."""
        fields = {f["name"]: f for f in cs["schema"]["fields"]}
        for k, v in params.items():
            if k not in fields:
                raise ValueError(f"{k}|unknown parameter {k}; the control stream's schema accepts {', '.join(fields)}")
            f = fields[k]
            con = f.get("constraint") or {}
            t = f["type"]
            if t == "Boolean":
                if not isinstance(v, bool):
                    raise ValueError(f"{k}|{k} must be true or false")
            elif t in ("Quantity", "Count"):
                if isinstance(v, bool) or not isinstance(v, (int, float)):
                    raise ValueError(f"{k}|{k} must be a number")
                if t == "Count" and int(v) != v:
                    raise ValueError(f"{k}|{k} must be a whole number")
                if con.get("intervals"):
                    lo, hi = con["intervals"][0]
                    if not lo <= v <= hi:
                        raise ValueError(f"{k}|{k}={v} is outside the schema's AllowedValues interval [{lo}, {hi}]")
            elif t in ("Category", "Text"):
                if not isinstance(v, str):
                    raise ValueError(f"{k}|{k} must be text")
                allowed = con.get("values")
                items = [x.strip() for x in v.split(",")] if t == "Text" else [v]
                if allowed:
                    bad = [x for x in items if x not in allowed]
                    if bad or not items or items == [""]:
                        raise ValueError(f"{k}|{k}={v!r}: {', '.join(bad) or 'nothing'} not in the schema's "
                                         f"AllowedTokens {allowed}")

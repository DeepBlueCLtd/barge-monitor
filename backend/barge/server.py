"""Connected Systems server (B-C07): one running instance and its data.

An instance is created at each server start. It freezes the field offering
(FR-46d), drops and rebuilds its index from the store (FR-29) while in
waiting mode (FR-44), and carries a fresh instance identifier (FR-45). The
registry of created resources (promoted products) and the store outlive it.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from . import analysis as A
from . import config as C
from . import scoring as S
from . import swe
from .adapter import StoreAdapter
from .fields import CATALOGUE, MEASURED, Offering, QUANTITIES, schema_id
from .tap import Tap

SOSA = "http://www.w3.org/ns/sosa/"
URN = "urn:x-barge:"
PROFILE_URI = "https://deepbluecltd.github.io/barge-monitor/profile/v3"
SENSORS = ("bow", "stern")
QC_RANGE = {
    "air_temperature": (-30.0, 50.0), "relative_humidity": (0.0, 100.0), "pressure": (900.0, 1100.0),
    "apparent_wind_speed": (0.0, 60.0), "apparent_wind_direction": (0.0, 360.0),
    "solar_irradiance": (0.0, 1500.0), "water_temperature": (-2.0, 35.0),
}
QC_SPIKE = {"air_temperature": 1.0, "relative_humidity": 8.0, "pressure": 0.6, "apparent_wind_speed": 4.0,
            "solar_irradiance": 150.0, "water_temperature": 0.5}
ANALYSIS_OUTPUTS = ("derived", "changes", "correlation", "clusters", "runs")


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


class Registry:
    """Resources created by clients (promotion, FR-36). Outlives server instances."""

    def __init__(self):
        self.systems: dict[str, dict] = {}
        self.datastreams: dict[str, dict] = {}
        self.observations: dict[str, list] = {}
        self.counter = 0

    def new_id(self, prefix: str) -> str:
        self.counter += 1
        return f"{prefix}-{self.counter}"


class Server:
    def __init__(self, runtime, number: int, offering: Offering, tap: Tap):
        self.rt = runtime
        self.offering = offering.copy()
        self.tap = tap
        self.instance = f"{runtime.seed}-{number}"
        self.adapter = StoreAdapter(runtime.logger, tap)
        self.ready = False
        self.registry: Registry = runtime.registry
        self.commands: dict[str, dict] = {}
        self.command_seq = 0
        self.run = None
        self.lie_about_profile = runtime.lie_about_profile
        self.profile = json.loads((contracts_dir() / "profile.json").read_text())
        self._build_resources()

    # --- start-up -----------------------------------------------------------
    def index_step(self) -> bool:
        done = self.adapter.index_step()
        if done and not self.ready:
            self.ready = True
            self.run_analysis(self.default_settings(), command_id=None)
        return done

    def progress(self) -> dict:
        return {"indexed": self.adapter.indexed_records(), "stored": self.adapter.store_records()}

    # --- resources ------------------------------------------------------------
    def _build_resources(self):
        off = self.offering
        meas = off.measured()
        self.sensor_fields = meas
        sensor_rec_fields = [swe.time_field()]
        for f in meas:
            sensor_rec_fields.append(swe.component(f, quality=f.swe_type == "Quantity"))
            if f.swe_type == "Quantity":
                sensor_rec_fields.append(swe.qc_field(f))
        names = [f["name"] for f in sensor_rec_fields]
        self.datastreams = {}
        for s in SENSORS:
            ds_id = schema_id(f"{s}-weather", names)
            self.datastreams[ds_id] = {
                "id": ds_id, "name": f"{s.capitalize()} sensor weather record", "outputName": "weather",
                "system": s, "kind": "sensor", "sensor": s,
                "schema": swe.record(sensor_rec_fields, f"{s.capitalize()} weather record"),
            }
        calc = off.calculated()
        self.calc_fields = calc
        derived_fields = [swe.time_field()] + [swe.component(f) for f in calc]
        params = [f.name for f in meas if f.swe_type == "Quantity"]
        self.analysis_params = params
        recs = {
            "derived": swe.record(derived_fields, "Derived values"),
            "changes": swe.record([swe.time_field(), swe.text("run_id", "Analysis run"),
                                   swe.category("scale", "Scale of the change", ["minutes", "hours"]),
                                   swe.quantity("strength", "Strength of the change", "1")], "Detected changes"),
            "correlation": swe.record([swe.time_field(), swe.text("run_id", "Analysis run"),
                                       swe.text("parameters", "Parameters, in matrix order"),
                                       swe.matrix("matrix", "Pearson correlation matrix")], "Correlation matrix"),
            "clusters": swe.record([swe.time_field(), swe.text("run_id", "Analysis run"),
                                    swe.category("regime", "Regime", [f"r{i}" for i in range(C.ANALYSIS_BOUNDS['clusters']['max'])])],
                                   "Clustering into regimes"),
            "runs": swe.record([swe.time_field("time", "Time the run completed"), swe.text("run_id", "Analysis run"),
                                swe.text("command_id", "Command that asked for it"),
                                swe.time_field("window_start", "Data range: start"), swe.time_field("window_end", "Data range: end"),
                                swe.count("records", "Records used"), swe.quantity("window_hours", "Window", "h"),
                                swe.count("clusters", "Clusters"), swe.quantity("sensitivity", "Detector sensitivity", "1"),
                                swe.text("parameters", "Parameters"),
                                swe.quantity("score_boundary_recall", "Score: reach boundaries found", "1"),
                                swe.quantity("score_boundary_precision", "Score: minute-scale changes at a boundary", "1"),
                                swe.quantity("score_front_recall", "Score: fronts found", "1"),
                                swe.quantity("score_ari_air_mass", "Score: clusters against air masses (ARI)", "1"),
                                swe.quantity("score_ari_reach_kind", "Score: clusters against reach kinds (ARI)", "1")],
                               "Analysis runs: settings, data range and scores"),
        }
        for out in ANALYSIS_OUTPUTS:
            rec = recs[out]
            ds_id = schema_id(f"analysis-{out}", [f["name"] for f in rec["fields"]])
            self.datastreams[ds_id] = {"id": ds_id, "name": rec["label"], "outputName": out, "system": "analysis",
                                       "kind": "analysis", "output": out, "schema": rec}
        b = C.ANALYSIS_BOUNDS
        self.control_schema = swe.record(
            [swe.quantity("window_hours", "Window, ending now", "h", b["window_hours"]["min"], b["window_hours"]["max"]),
             swe.count("clusters", "Number of clusters", b["clusters"]["min"], b["clusters"]["max"]),
             swe.quantity("sensitivity", "Detector sensitivity", "1", b["sensitivity"]["min"], b["sensitivity"]["max"])]
            + [swe.boolean(f"include_{p}", f"Include {CATALOGUE[p].label.lower()}") for p in params],
            "Analysis settings")
        self.controlstream_id = schema_id("analysis-settings", [f["name"] for f in self.control_schema["fields"]])
        self.systems = {
            "barge": self._system("barge", "Platform", "Cargo barge", "PhysicalSystem",
                                  "The uncrewed electric cargo barge. It records no position."),
            "bow": self._system("bow", "Sensor", "Bow weather sensor", "PhysicalSystem", "Seven parameters at 1 Hz.", parent="barge"),
            "stern": self._system("stern", "Sensor", "Stern weather sensor", "PhysicalSystem", "Seven parameters at 1 Hz.", parent="barge"),
            "analysis": self._system("analysis", "System", "Analysis service", "SimpleProcess",
                                     "Derived values, change detection, correlation and clustering.", asset="Process"),
        }

    @staticmethod
    def _system(sid, stype, label, sml_type, desc, parent=None, asset=None):
        s = {"type": sml_type, "id": sid, "uniqueId": f"{URN}{'process' if asset else stype.lower()}:{sid}",
             "label": label, "description": desc, "definition": SOSA + stype, "systemType": SOSA + stype}
        if asset:
            s["assetType"] = asset
        if parent:
            s["parent"] = parent
        return s

    def all_systems(self) -> dict:
        return {**self.systems, **self.registry.systems}

    def all_datastreams(self) -> dict:
        return {**self.datastreams, **self.registry.datastreams}

    # --- profile (FR-38, FR-39) -------------------------------------------------
    def satisfies_profile(self) -> list[dict]:
        """Essential sources this offering does not satisfy (empty when it does)."""
        problems = []
        for e in self.profile["essentials"]:
            sysm = next((s for s in self.all_systems().values() if s["uniqueId"] == e["system"]), None)
            ds = sysm and next((d for d in self.all_datastreams().values()
                                if d["system"] == sysm["id"] and d["outputName"] == e["datastream"]), None)
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

    # --- sensor observations ----------------------------------------------------
    def time_range(self):
        r = [self.adapter.time_range(s) for s in SENSORS]
        r = [x for x in r if x]
        return (min(a for a, _ in r), max(b for _, b in r)) if r else None

    def sensor_count(self, sensor, t0, t1):
        return self.adapter.count(sensor, t0, t1)

    def sensor_records(self, sensor, t0, t1, limit=None, offset=0) -> dict:
        """Records with server-side QARTOD flags (FR-31)."""
        self.tap.emit("server", "adapter", "I", f"{sensor} records {iso(max(t0, 0)) if np.isfinite(t0) else '..'} to {iso(t1)}",
                      {"sensor": sensor, "limit": limit, "offset": offset})
        pad = 2
        lo_off = max(0, offset - pad)
        lead = offset - lo_off
        r = self.adapter.read(sensor, t0, t1, None if limit is None else limit + lead + pad, lo_off)
        out = {"t": r["t"][lead:lead + (limit if limit is not None else len(r["t"]))]}
        n = len(out["t"])
        for f in MEASURED:
            v = r[f.name]
            out[f.name] = v[lead:lead + n]
            if f.swe_type != "Quantity":
                continue
            flag = np.full(len(v), "1", dtype=object)
            lo, hi = QC_RANGE[f.name]
            flag[(v < lo) | (v > hi)] = "4"
            if f.name in QC_SPIKE and len(v) >= 5:
                w = np.lib.stride_tricks.sliding_window_view(np.nan_to_num(v, nan=np.nanmean(v) if np.isfinite(v).any() else 0), 5)
                med = np.median(w, axis=1)
                core = np.abs(v[2:-2] - med) > QC_SPIKE[f.name]
                f2 = flag[2:-2]
                f2[core & (f2 == "1")] = "3"
            if f.name == "apparent_wind_direction":
                flag[r["wd_variable"] == 1] = "2"
            flag[np.isnan(v) & (flag != "2")] = "9"
            out[f"{f.name}_qc"] = flag[lead:lead + n]
        self.tap.emit("adapter", "server", "I", f"{n} {sensor} records as columns",
                      {"columns": list(out), "records": n})
        return out

    # --- derived values ----------------------------------------------------------
    def derived_records(self, t0, t1, limit=None, offset=0) -> dict:
        calc = {f.name for f in self.calc_fields}
        back = 3 * 3600 + 900 if "pressure_tendency_3h" in calc else 0
        if "spikes_last_hour" in calc:
            back = max(back, 3600)
        self.tap.emit("server", "analysis", "I", "derived values requested", {"from": t0, "to": t1})
        bow = self.sensor_records("bow", t0 - back, t1)
        stern = self.sensor_records("stern", t0 - back, t1)
        t, ib, is_ = np.intersect1d(np.round(bow["t"]), np.round(stern["t"]), return_indices=True)
        self.tap.emit("analysis", "scilibs", "I", "numpy: vectorised derived values", {"records": int(len(t))})
        out = {"t": t}
        b = {k: v[ib] for k, v in bow.items() if k == "t" or not k.endswith("_qc")}
        s = {k: v[is_] for k, v in stern.items() if not k.endswith("_qc")}
        for f in self.calc_fields:
            if f.name == "dew_point":
                out[f.name] = A.dew_point(b["air_temperature"], b["relative_humidity"])
            elif f.name == "air_minus_water":
                out[f.name] = b["air_temperature"] - b["water_temperature"]
            elif f.name.startswith("bow_minus_stern_"):
                p = f.name[len("bow_minus_stern_"):]
                d = b[p] - s[p]
                if p == "apparent_wind_direction":
                    d = (d + 180.0) % 360.0 - 180.0
                out[f.name] = d
            elif f.name == "pressure_tendency_3h":
                out[f.name] = A.tendency(t, b["pressure"])
            elif f.name == "spikes_last_hour":
                flags = (bow["air_temperature_qc"][ib] == "3").astype(float) + (stern["air_temperature_qc"][is_] == "3").astype(float)
                c = np.concatenate([[0.0], np.cumsum(flags)])
                lo = np.searchsorted(t, t - 3600, "left")
                out[f.name] = (c[np.arange(len(t)) + 1] - c[lo]).astype(int)
        self.tap.emit("scilibs", "analysis", "I", "numpy arrays", {"fields": [f.name for f in self.calc_fields]})
        keep = (t >= t0) & (t <= t1)
        idx = np.flatnonzero(keep)[offset:]
        if limit is not None:
            idx = idx[:limit]
        res = {k: v[idx] for k, v in out.items()}
        self.tap.emit("analysis", "server", "I", f"{len(idx)} derived records", {"records": int(len(idx))})
        return res

    def derived_count(self, t0, t1):
        return min(self.adapter.count("bow", t0, t1), self.adapter.count("stern", t0, t1))

    # --- analysis runs (FR-26, FR-32..FR-34) -----------------------------------
    def default_settings(self) -> dict:
        b = C.ANALYSIS_BOUNDS
        s = {"window_hours": b["window_hours"]["default"], "clusters": b["clusters"]["default"],
             "sensitivity": b["sensitivity"]["default"]}
        for p in self.analysis_params:
            s[f"include_{p}"] = p in ("air_temperature", "relative_humidity", "pressure", "water_temperature",
                                      "solar_irradiance", "apparent_wind_speed")
        return s

    def validate_command(self, params: dict) -> dict:
        """Check a command against the control stream's schema. Raise naming the bound."""
        fields = {f["name"]: f for f in self.control_schema["fields"]}
        out = self.default_settings()
        for k, v in params.items():
            if k not in fields:
                raise ValueError(f"{k}|unknown parameter {k}; the control stream's schema accepts {', '.join(fields)}")
            f = fields[k]
            if f["type"] == "Boolean":
                if not isinstance(v, bool):
                    raise ValueError(f"{k}|{k} must be true or false")
            else:
                if isinstance(v, bool) or not isinstance(v, (int, float)):
                    raise ValueError(f"{k}|{k} must be a number")
                if f["type"] == "Count" and int(v) != v:
                    raise ValueError(f"{k}|{k} must be a whole number")
                lo, hi = f["constraint"]["intervals"][0]
                if not lo <= v <= hi:
                    raise ValueError(f"{k}|{k}={v} is outside the schema's AllowedValues interval [{lo}, {hi}]")
            out[k] = v
        return out

    def run_analysis(self, settings: dict, command_id):
        now = self.rt.now()
        t1 = now
        t0 = max(0.0, now - settings["window_hours"] * 3600.0)
        self.tap.emit("server", "analysis", "I", "run with settings", settings)
        bow = self.sensor_records("bow", t0, t1)
        clean = {"t": bow["t"]}
        for f in self.sensor_fields:
            if f.swe_type == "Quantity":
                v = bow[f.name].astype(float).copy()
                v[bow[f"{f.name}_qc"] != "1"] = np.nan
                clean[f.name] = v
        if "air_temperature" in clean and "relative_humidity" in clean:
            clean["dew_point"] = A.dew_point(clean["air_temperature"], clean["relative_humidity"])
        params = [p for p in self.analysis_params if settings.get(f"include_{p}")]
        self.tap.emit("analysis", "scilibs", "I", "numpy: step statistics, k-means, correlation",
                      {"records": int(len(clean["t"])), "parameters": params})
        det = A.detect_changes(clean, settings["sensitivity"])
        names = params if len(params) >= 2 else [p for p in self.analysis_params][:2]
        R, rows = A.correlation(clean, names) if len(names) >= 2 else (np.zeros((0, 0)), 0)
        idx, labels = A.cluster(clean, names, int(settings["clusters"])) if len(names) >= 1 else (np.array([], int), np.array([], int))
        self.tap.emit("scilibs", "analysis", "I", "numpy results", {"detections": int(len(det["t"])), "clusters": int(settings["clusters"])})
        world = self.rt.world
        sc = S.score_changes(world, det, t0, t1) if len(clean["t"]) else {}
        cs = S.score_clusters(world, clean["t"][idx], labels) if len(idx) > 1 else {}
        self.command_seq += 1
        run_id = f"run-{self.instance}-{self.command_seq}"
        self.run = {
            "run_id": run_id, "command_id": command_id or "", "time": now, "settings": settings,
            "window_start": float(clean["t"][0]) if len(clean["t"]) else t0,
            "window_end": float(clean["t"][-1]) if len(clean["t"]) else t1,
            "records": int(len(clean["t"])), "parameters": names,
            "changes": det, "correlation": R, "cluster_t": clean["t"][idx], "cluster_labels": labels,
            "scores": {"score_boundary_recall": sc.get("boundary_recall"), "score_boundary_precision": sc.get("boundary_precision"),
                       "score_front_recall": sc.get("front_recall"), "score_ari_air_mass": cs.get("ari_air_mass"),
                       "score_ari_reach_kind": cs.get("ari_reach_kind")},
        }
        self.tap.emit("analysis", "server", "I", f"{run_id} complete", {"run_id": run_id, "scores": self.run["scores"]})
        return self.run

    def analysis_records(self, output: str, t0, t1) -> dict:
        r = self.run
        if r is None:
            return {"t": np.empty(0)}
        if output == "changes":
            d = r["changes"]
            rec = {"t": d["t"], "run_id": np.array([r["run_id"]] * len(d["t"]), dtype=object),
                   "scale": np.array(["minutes", "hours"], dtype=object)[d["scale"].astype(int)] if len(d["t"]) else np.empty(0, dtype=object),
                   "strength": d["strength"]}
        elif output == "clusters":
            n = len(r["cluster_t"])
            rec = {"t": r["cluster_t"], "run_id": np.array([r["run_id"]] * n, dtype=object),
                   "regime": np.array([f"r{x}" for x in r["cluster_labels"]], dtype=object)}
        elif output == "correlation":
            rec = {"t": np.array([r["time"]]), "run_id": np.array([r["run_id"]], dtype=object),
                   "parameters": np.array([",".join(r["parameters"])], dtype=object),
                   "matrix": np.empty(1, dtype=object)}
            rec["matrix"][0] = [[None if not np.isfinite(x) else round(float(x), 4) for x in row] for row in r["correlation"]]
        elif output == "runs":
            st = r["settings"]
            rec = {"t": np.array([r["time"]]), "run_id": np.array([r["run_id"]], dtype=object),
                   "command_id": np.array([r["command_id"]], dtype=object),
                   "window_start": np.array([r["window_start"]]), "window_end": np.array([r["window_end"]]),
                   "records": np.array([r["records"]]), "window_hours": np.array([float(st["window_hours"])]),
                   "clusters": np.array([int(st["clusters"])]), "sensitivity": np.array([float(st["sensitivity"])]),
                   "parameters": np.array([",".join(r["parameters"])], dtype=object)}
            for k, v in r["scores"].items():
                rec[k] = np.array([np.nan if v is None else v])
        else:
            raise KeyError(output)
        keep = (rec["t"] >= t0) & (rec["t"] <= t1)
        return {k: v[keep] for k, v in rec.items()}

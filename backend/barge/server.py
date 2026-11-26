"""The data server (C-04): one start of the stand-in for OpenSensorHub.

An instance is created at each server start. It freezes the field offering (FR-51); then its
modules start: the CSV importer registers, lists the data folder and, at the first start of a page
load, imports Mission A silently (FR-15). Until then the server answers nothing (4.7, §9.1: no 503
and no instance identifier). The store of created resources (``store.py``: systems, datastreams,
control streams, commands and observations) outlives it, as OpenSensorHub's database does.

The server holds no client sessions (FR-06). Its configuration makes the collection platform, its
bow and stern sensors and their CO₂ analysers, the Models system and a workspace per user; the
importer makes each dataset's datastreams under the sensors (FR-25), and each model its own process
system and outputs (FR-28). The 4.1 logger's ``weather`` datastreams and the store adapter are
retired (plan Phase 8, D-320).
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from . import config as C
from .accounts import USERS
from .fields import Offering
from .store import URN, Store
from .tap import Tap

SOSA = "http://www.w3.org/ns/sosa/"
# The declared profile, the 4.7 template (FR-40, FR-40a), served beside the API (FR-41). The interim 4.1 profile
# of D-252 is retired with the 4.1 display client (D-301).
PROFILE = "profile.json"
SENSORS = ("bow", "stern")
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


class Server:
    def __init__(self, runtime, number: int, offering: Offering, tap: Tap):
        self.rt = runtime
        self.offering = offering.copy()
        self.tap = tap
        self.number = number  # internal only: the server serves no instance identifier (4.7, §9.1)
        self.starting = False  # its modules are starting (the CSV importer)
        self.ready = False  # answering requests
        self.store: Store = runtime.store
        self.lie_about_profile = runtime.lie_about_profile
        self.profile = json.loads((contracts_dir() / PROFILE).read_text())
        self.ids = self._configure()

    # --- the server's configuration: its systems -------------------------------------------------------
    def _configure(self) -> dict:
        """What OpenSensorHub's configuration creates at start (docs/v4-interfaces.md §6): the platform, its
        sensors and their CO₂ analysers (restricted), Models, and a workspace per user. The CSV importer
        registers itself, at each start (``importer.py``), and makes each dataset's datastreams."""
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
        models, _ = add(URN + "process:models", "Models",
                        "A home for models that turn sensor data into insight. Each model is a process system of its own, "
                        "created by the model itself.", SOSA + "System", "Process")
        ids["models"] = models["id"]
        for u in USERS:
            w, _ = add(f"{URN}workspace:{u}", f"Workspace of {u}", "Data of interest saved by this user (FR-94).",
                       SOSA + "System", "Other", owner=u)
            ids[f"workspace:{u}"] = w["id"]
        return ids

    def phase(self) -> str:
        return "ready" if self.ready else "import"

    # --- datastreams: the offering applied to every schema (FR-50..52) ------------
    def visible(self, d: dict) -> dict:
        """A datastream's schema as this start serves it: fields switched off are left out. A misconfigured
        server (FR-79a, D-210) serves the importer's catalogue without ``status``, a fixed essential, while it
        still claims the profile: the display client refuses it at the handshake."""
        rec = d["schema"]
        broken = "status" if self.lie_about_profile and d["outputName"] == "catalogue" else None
        return dict(rec, fields=[f for f in rec["fields"] if f["name"] == "time"
                                 or (self.offering.keep(f["name"]) and f["name"] != broken)])

    def served(self, d: dict) -> bool:
        """Listed and served: not replaced by a newer schema, and with at least one output published (FR-52).
        A datastream with every output switched off still takes its model's observations (AT-12)."""
        return not d["replaced"] and len(self.visible(d)["fields"]) > 1

    def time_range(self, d: dict):
        return d["series"].span()

    # --- profile (FR-40, FR-41) ------------------------------------------------------
    def satisfies_profile(self) -> list[dict]:
        """Essential sources this offering does not satisfy (empty when it does)."""
        problems = []
        for e in self.profile["essentials"]:
            if e.get("kind") == "controlstream":
                if self.store.controlstream(e["system"], e["datastream"]) is None:
                    problems.append({"id": e["id"], "reason": "missing"})
                continue
            found = self._per_dataset(e["system"], e["datastream"])
            if found is None:
                ds = self.store.datastream(e["system"], e["datastream"])
                found = [ds] if ds and self.served(ds) else []
            reasons = []
            for ds in found:
                fld = next((f for f in self.visible(ds)["fields"] if f["name"] == e["field"]), None)
                reasons.append("missing" if not fld else "wrong type" if fld["type"] != e["type"]
                               else "wrong unit" if (fld.get("uom") or {}).get("code") != e.get("uom") else "")
            if "" not in reasons:
                problems.append({"id": e["id"], "reason": reasons[-1] if reasons else "missing"})
        return problems

    def _per_dataset(self, system_uid: str, template: str) -> dict | None:
        """A template essential (``weather__{dataset}``, FR-40a) is met for the claim when some dataset's datastream
        carries it (D-301): the client checks each dataset itself when it opens it, and a dataset missing one is
        degraded (FR-45), not the server. The datastream returned is the newest dataset's that carries the field."""
        if "{dataset}" not in template:
            return None
        s = self.store.system_by_uid(system_uid)
        if s is None:
            return None
        prefix = template.replace("{dataset}", "")
        return [d for d in self.store.datastreams.values()
                if d["system"] == s["id"] and d["outputName"].startswith(prefix) and self.served(d)]

    def claims_profile(self) -> bool:
        return self.lie_about_profile or not self.satisfies_profile()

"""The data server's internal interface for models (FR-28, FR-35).

Models reach the data server directly, not through FastAPI (SRD §3.1): each
model, in its own worker, calls these operations over a MessagePort (in the
browser) or directly (CPython tests). They are the same operations a client
would perform with ordinary resource creation (create a system, then a
datastream under it, then publish observations), so a model written against
this interface could be moved behind HTTP unchanged.

Every call and its answer is captured as an I message between ``models`` and
``server``. While the server is waiting or down, calls are refused with that
status and the model tries again on its next step: a model never stops the
server, and the server never stops a model (FR-33).
"""
from __future__ import annotations

import itertools

import numpy as np

from . import scoring
from .server import SOSA, iso
from .tap import Tap

_calls = itertools.count(1)
SWE_TYPES = {"Quantity", "Count", "Category", "Boolean", "Text", "Time", "Matrix", "DataArray"}


class ModelError(Exception):
    pass


def _brief(args: dict) -> dict:
    """What a captured message shows of a call's arguments: never whole columns."""
    out = {}
    for k, v in args.items():
        if k == "cols" and isinstance(v, dict):
            n = len(v.get("t", []))
            out["cols"] = {"fields": [c for c in v if c != "t"], "rows": int(n)}
        elif k in ("t0", "t1") and isinstance(v, (int, float)) and np.isfinite(v):
            out[k] = iso(v)
        else:
            out[k] = v
    return out


class ModelHost:
    def __init__(self, runtime):
        self.rt = runtime
        self.tap: Tap = runtime.tap
        self.phase: dict[str, dict] = {}  # model -> {phase, detail}
        self.listeners: dict = {}  # model -> callable(message): how the server reaches a model

    def notify(self, model: str, message: dict) -> None:
        """The data server passes something to a model (server → models): a command."""
        self.tap.emit("server", "models", "I", f"{model}: {message['type']} {message.get('command', {}).get('id', '')}",
                      message, model=model)
        fn = self.listeners.get(model)
        if fn:
            fn(message)

    def call(self, model: str, op: str, args: dict, quiet: bool = False) -> dict:
        """One operation. Returns {"ok": True, "result": …} or {"ok": False, "status": …, "error": …}."""
        rt = self.rt
        token = Tap.begin_chain(f"m{next(_calls)}", 0)
        try:
            srv = rt.server
            failed = srv is None or not srv.ready
            self.tap.emit("models", "server", "I", f"{model}: {op}", {"op": op, **_brief(args)},
                          failed=srv is None, model=model, quiet=quiet)
            if failed:
                status = "down" if srv is None else "waiting"
                if srv is not None:
                    self.tap.emit("server", "models", "I", f"{model}: {op} refused, server waiting",
                                  {"status": 503, "detail": "waiting mode: rebuilding the index"}, model=model, quiet=quiet)
                return {"ok": False, "status": status, "error": f"the data server is {status}"}
            try:
                result = getattr(self, "op_" + op)(srv, model, quiet=quiet, **args)
            except (ModelError, KeyError, ValueError, TypeError) as e:
                self.tap.emit("server", "models", "I", f"{model}: {op} refused", {"error": str(e)}, model=model, quiet=quiet)
                return {"ok": False, "status": "refused", "error": str(e)}
            self.tap.emit("server", "models", "I", f"{model}: {op} done", _brief({"result": result}) if not isinstance(result, dict) or "t" not in result
                          else {"cols": {"fields": [c for c in result if c != "t"], "rows": int(len(result["t"]))}},
                          model=model, quiet=quiet)
            return {"ok": True, "result": result}
        finally:
            Tap.end_chain(token)

    def set_phase(self, model: str, phase: str, detail: str = "", label: str | None = None) -> None:
        cur = self.phase.setdefault(model, {"label": label or model})
        cur.update(phase=phase, detail=detail)
        if label:
            cur["label"] = label

    # --- creating resources (FR-28) -------------------------------------------------
    def op_create_system(self, srv, model, body: dict, quiet=False) -> str:
        reg = srv.registry
        uid = body.get("uniqueId")
        if not isinstance(uid, str) or not uid or not isinstance(body.get("label"), str):
            raise ModelError("a system needs a uniqueId and a label")
        for sid, s in srv.all_systems().items():
            if s["uniqueId"] == uid:
                return sid  # already registered: a restarted model finds its system again
        sid = reg.system_id_for(uid)
        reg.systems[sid] = {"type": "SimpleProcess", "id": sid, "uniqueId": uid, "label": body["label"],
                            "description": body.get("description", ""), "definition": SOSA + "System",
                            "systemType": SOSA + "System", "assetType": "Process", "parent": "models",
                            "createdBy": model}
        self.set_phase(model, "registered", label=body["label"])
        return sid

    def _own_system(self, srv, model, system_id):
        s = srv.registry.systems.get(system_id)
        if s is None:
            raise ModelError(f"system {system_id} does not exist")
        if s.get("createdBy") != model:
            raise ModelError(f"system {system_id} belongs to {s.get('createdBy')}, not {model}")
        return s

    @staticmethod
    def _check_record(rec):
        if not isinstance(rec, dict) or rec.get("type") != "DataRecord" or not rec.get("fields"):
            raise ModelError("schema must be a SWE Common DataRecord with fields")
        if rec["fields"][0].get("type") != "Time" or rec["fields"][0].get("name") != "time":
            raise ModelError("the first field must be a Time named time")
        for f in rec["fields"]:
            if f.get("type") not in SWE_TYPES or not isinstance(f.get("name"), str):
                raise ModelError(f"field {f.get('name')}: SWE Common type {f.get('type')} is not supported")

    def op_create_datastream(self, srv, model, system_id: str, body: dict, quiet=False) -> str:
        from .registry import Series

        self._own_system(srv, model, system_id)
        rec = body.get("schema")
        self._check_record(rec)
        out = body.get("outputName")
        if not isinstance(out, str) or not out:
            raise ModelError("a datastream needs an outputName")
        key = f"{system_id}:{out}"
        reg = srv.registry
        old = reg.datastreams.get(key)
        names = [f["name"] for f in rec["fields"]]
        if old and [f["name"] for f in old["schema"]["fields"]] == names:
            return key
        reg.datastreams[key] = {"key": key, "system": system_id, "outputName": out, "name": body.get("name", out),
                                "schema": rec, "series": Series(rec["fields"], body.get("retention"))}
        return key

    def op_create_controlstream(self, srv, model, system_id: str, body: dict, quiet=False) -> str:
        self._own_system(srv, model, system_id)
        rec = body.get("schema")
        if not isinstance(rec, dict) or rec.get("type") != "DataRecord":
            raise ModelError("a control stream's schema must be a SWE Common DataRecord")
        name = body.get("inputName") or "settings"
        key = f"{system_id}:{name}"
        srv.registry.controlstreams[key] = {"key": key, "system": system_id, "inputName": name,
                                            "name": body.get("name", name), "schema": rec}
        return key

    def op_find(self, srv, model, system_uid: str, output_name: str, since=None, quiet=False):
        sysm = next((s for s in srv.all_systems().values() if s["uniqueId"] == system_uid), None)
        if sysm is None:
            return None
        if sysm["id"] in ("bow", "stern") and output_name == "weather":
            return f"{sysm['id']}:weather"
        key = f"{sysm['id']}:{output_name}"
        d = srv.registry.datastreams.get(key)
        if d is None:
            return None
        d["series"].readers.setdefault(model, -np.inf if since is None else float(since))  # retention keeps what it has not read
        return key

    # --- reading and publishing observations ----------------------------------------
    def op_read(self, srv, model, key: str, t0: float, t1: float, fields=None, quiet=False) -> dict:
        sensor, _, out = key.partition(":")
        if out == "weather" and sensor in ("bow", "stern"):
            names = [n for n in (fields or [f["name"] for f in srv.sensor_schema[sensor]["fields"]])
                     if n != "time" and not n.endswith("_qc") and srv.offering.keep(n)]
            return srv.sensor_records(sensor, t0, t1, fields=names, why=f"{model} read", quiet=quiet)
        d = srv.registry.datastreams.get(key)
        if d is None:
            raise ModelError(f"datastream {key} does not exist")
        s = d["series"]
        i0, i1 = s.range(t0, t1)
        names = [n for n in (fields or list(s.cols)) if srv.offering.keep(n)]
        cols = s.slice(i0, i1, names)
        if len(cols["t"]):
            s.readers[model] = float(cols["t"][-1])
        return cols

    def op_publish(self, srv, model, key: str, cols: dict, replace: bool = False, quiet=False) -> int:
        d = srv.registry.datastreams.get(key)
        if d is None:
            raise ModelError(f"datastream {key} does not exist")
        if d["system"] not in srv.registry.systems or srv.registry.systems[d["system"]].get("createdBy") != model:
            raise ModelError(f"{model} cannot publish to {key}")
        s = d["series"]
        if replace:
            s.clear()
        n = s.append(cols)
        s.prune(self.rt.now())
        return n

    # --- commands (FR-27) ------------------------------------------------------------
    def op_commands(self, srv, model, key: str, quiet=False) -> list:
        return [c for c in srv.registry.commands.values() if c["cs_key"] == key and c["status"][-1]["statusCode"] == "PENDING"]

    def op_command_status(self, srv, model, cmd_id: str, status: str, message: str = "", quiet=False) -> str:
        c = srv.registry.commands.get(cmd_id)
        if c is None:
            raise ModelError(f"command {cmd_id} does not exist")
        if status not in ("ACCEPTED", "EXECUTING", "COMPLETED", "FAILED", "REJECTED"):
            raise ModelError(f"unknown status {status}")
        c["status"].append({"statusCode": status, "reportTime": iso(self.rt.now()), **({"message": message} if message else {})})
        return status

    # --- the demonstrator's referee: scores against the manifest (FR-37) ------------
    def op_score(self, srv, model, kind: str, payload: dict, quiet=False) -> dict:
        """Scored here, outside the model: the model never sees the manifest or the position."""
        w = self.rt.world
        if kind == "changes":
            det = {"t": np.asarray(payload["t"], dtype=float), "scale": np.asarray(payload["scale"], dtype=int)}
            r = scoring.score_changes(w, det, float(np.ravel(payload["t0"])[0]), float(np.ravel(payload["t1"])[0]))
            return {k: (None if v is None else float(v)) for k, v in r.items()}
        if kind == "clusters":
            t = np.asarray(payload["t"], dtype=float)
            labels = np.asarray(payload["labels"])
            if len(t) < 2:
                return {"ari_air_mass": None, "ari_reach_kind": None}
            r = scoring.score_clusters(w, t, labels)
            return {k: (None if not np.isfinite(v) else float(v)) for k, v in r.items()}
        raise ModelError(f"unknown score kind {kind}")

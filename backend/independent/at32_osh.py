#!/usr/bin/env python3
"""AT-32: the server-neutral contract suite against a stock OpenSensorHub, with credentials.

What runs, all on this machine:

* **OpenSensorHub** ``osh-core`` 2.0.4, unmodified, configured with the delivered accounts
  (``osh_server.py``), over an empty store;
* the **access gateway** in front of it (``osh_gateway.py``: ``barge.gateway.Gateway``, §9.5);
* the **installation**: the platform, sensors, CO₂ analysers, Models and one workspace per user,
  created as the stand-ins create them at start (§6); each workspace by its own user;
* the **CSV importer** and the **replay controller**, as clients of OpenSensorHub under their service
  accounts (direct, not through the gateway: they are modules of the data server, §7, §8). The
  importer writes one observation per ``POST``; it imports the first ``--rows`` rows of Mission A
  (the bulk path is the Java module of S-IMPORT, which reads another CSV layout);
* the **core models**, the same Python code as in the stand-ins (``models/``), through the gateway;
* then the **contract suite**, ``contract_suite/suite.py``, unchanged, through the gateway.

It prints pass or fail for every check. ``need`` checks are AT-32; ``standin`` checks are what the
stand-ins do to stay faithful to OpenSensorHub, shown for information. With ``--proposed`` a second
run applies, in the gateway's upstream layer, the client changes the AT-32 finding proposes
(D-193, D-194), to show what lies beneath them; that run is **not** AT-32 as specified.

Usage::

    python backend/independent/at32_osh.py --osh <osh-core>/build/install/osh-core [--proposed] [--json out.json]

Needs Java 17+, and ``websockets`` beside ``backend/requirements-dev.txt``. Exit status 0 only if
every ``need`` check passes in the run as specified.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import json
import sys
import tempfile
import time
import traceback
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE.parent / "models"))
sys.path.insert(0, str(HERE))

import httpx  # noqa: E402
import numpy as np  # noqa: E402
import uvicorn  # noqa: E402

import analysis  # noqa: E402
import csmodel  # noqa: E402
import data_cleanse  # noqa: E402
import summaries  # noqa: E402
from barge import accounts as A  # noqa: E402
from barge import config as C  # noqa: E402
from barge import dialect  # noqa: E402
from barge import swe  # noqa: E402
from barge.fields import QUANTITIES  # noqa: E402
from barge.folder import DirFolder  # noqa: E402
from barge.importer import SENSORS, Importer, catalogue_schema, dataset_id, import_schema  # noqa: E402
from barge.replay import ACTIONS, control_schema, log_schema, state_schema  # noqa: E402
from barge.times import iso  # noqa: E402
from contract_suite import suite  # noqa: E402
from osh_gateway import OshGateway, OshUpstream  # noqa: E402
from osh_server import Osh, find_home, free_port  # noqa: E402

ROOT = HERE.parents[1]
URN = "urn:x-barge:"
SOSA = "http://www.w3.org/ns/sosa/"
SML = "application/sml+json"
SWE = "application/swe+json"


def basic(user: str) -> str:
    return "Basic " + base64.b64encode(f"{user}:{A.Accounts().by_user[user].password}".encode()).decode()


class Direct:
    """One account's requests straight to OpenSensorHub's API (a module of the server: no gateway)."""

    def __init__(self, osh: Osh, user: str):
        self.osh, self.user = osh, user
        self.c = httpx.AsyncClient(base_url=osh.root + "/api", headers={"Authorization": basic(user)},
                                   timeout=90, trust_env=False)
        self.systems: dict[str, str] = {}

    async def system(self, uid, label, desc, definition, asset, parent_uid=None, kind="PhysicalSystem", extra=None):
        path = f"/systems/{self.systems[parent_uid]}/subsystems" if parent_uid else "/systems"
        body = {"type": kind, "uniqueId": uid, "label": label, "description": desc, "definition": definition,
                "assetType": asset, **(extra or {})}
        r = await self.c.post(path, content=json.dumps(body), headers={"content-type": SML})
        assert r.status_code == 201, (uid, r.status_code, r.text[:300])
        self.systems[uid] = r.headers["location"].rsplit("/", 1)[-1]
        return self.systems[uid]

    async def find_systems(self):
        r = await self.c.get("/systems", params={"searchMembers": "true", "limit": "10000"})
        for s in r.json()["items"]:
            self.systems[s["properties"]["uid"]] = s["id"]

    async def datastream(self, sid, output, label, rec) -> str:
        r = await self.c.post(f"/systems/{sid}/datastreams", json={"name": label, "outputName": output,
                                                                   "schema": {"obsFormat": SWE, "recordSchema": rec}})
        assert r.status_code == 201, (output, r.status_code, r.text[:300])
        return r.headers["location"].rsplit("/", 1)[-1]

    async def controlstream(self, sid, name, label, rec) -> str:
        r = await self.c.post(f"/systems/{sid}/controlstreams", json={
            "name": label, "inputName": name, "schema": {"commandFormat": "application/json", "parametersSchema": rec}})
        assert r.status_code == 201, (name, r.status_code, r.text[:300])
        return r.headers["location"].rsplit("/", 1)[-1]

    async def obs(self, ds, row) -> int:
        r = await self.c.post(f"/datastreams/{ds}/observations", content=json.dumps(row, allow_nan=False),
                              headers={"content-type": SWE})
        return r.status_code

    async def status(self, cs, cmd_id, code, message=""):
        await self.c.post(f"/controlstreams/{cs}/status",
                          json={"command@id": cmd_id, "statusCode": code, **({"message": message} if message else {})})

    async def receive(self, cs, on_command, opened: asyncio.Event):
        """A receiver's subscription on the internal endpoint (OpenSensorHub pushes over WebSocket only)."""
        import websockets

        url = self.osh.root.replace("http", "ws", 1) + f"/api-internal/controlstreams/{cs}/commands"
        while True:
            try:
                async with websockets.connect(url, additional_headers={"Authorization": basic(self.user)},
                                              proxy=None) as ws:
                    opened.set()
                    async for msg in ws:
                        asyncio.ensure_future(on_command(json.loads(msg)))
            except (OSError, websockets.exceptions.WebSocketException):
                pass
            await asyncio.sleep(1)


def _value(ty: str, v):
    if isinstance(v, np.generic):
        v = v.item()
    if ty in ("Quantity", "Count"):
        if v is None or (isinstance(v, float) and v != v):
            return "NaN"
        return int(v) if ty == "Count" else float(v)
    if ty == "Time":
        return v if isinstance(v, str) else iso(v)
    return v


# --- the installation (§6): what the stand-ins create at start --------------------------------------
async def install(osh: Osh) -> None:
    own = Direct(osh, "owner")
    await own.system(URN + "platform:barge", "Collection platform", "The uncrewed electric cargo barge. It records no "
                     "position.", SOSA + "Platform", "Platform")
    for s in SENSORS:
        await own.system(f"{URN}sensor:{s}", f"{s.capitalize()} sensor", "Seven parameters at 1 Hz.", SOSA + "Sensor",
                         "Equipment", URN + "platform:barge")
        await own.system(f"{URN}sensor:{s}:co2", f"{s.capitalize()} CO₂ analyser", "CO₂ in ppm at 1 Hz. Restricted.",
                         SOSA + "Sensor", "Equipment", f"{URN}sensor:{s}")
    await own.system(URN + "process:models", "Models", "A home for models that turn sensor data into insight.",
                     SOSA + "System", "Process", kind="SimpleProcess")
    for user in A.USERS:
        me = Direct(osh, user)
        sid = await me.system(f"{URN}workspace:{user}", f"Workspace of {user}", "Data of interest, kept per analyst "
                              "(FR-95).", SOSA + "System", "Other", kind="SimpleProcess")
        await me.datastream(sid, "data-of-interest", "Data of interest", swe.record([
            swe.time_field("time", "Saved at"), swe.text("doi_id", "Data of interest"),
            swe.category("action", "Action", ["save", "remove"]), swe.text("record", "Record (JSON)")],
            "Data of interest"))


# --- the CSV importer, as a client (§7) -----------------------------------------------------------------
class ImporterClient:
    def __init__(self, osh: Osh, folder: Path, rows: int):
        self.d = Direct(osh, "svc-importer")
        self.folder = DirFolder(folder)
        self.rows = rows
        self.datasets: dict[str, dict] = {}
        self.listing: list[dict] = []
        self.opened = asyncio.Event()
        self.rate = None
        self.unit_substitutions: list[str] = []
        self.catalogue_refusals = 0

    async def start(self) -> None:
        d = self.d
        sid = await d.system(URN + "importer", "CSV importer", "Lists the data folder and imports its CSV files.",
                             SOSA + "System", "Equipment", kind="SimpleProcess")
        self.catalogue = await d.datastream(sid, "catalogue", "Archive catalogue", catalogue_schema())
        self.cat_types = {f["name"]: f["type"] for f in catalogue_schema()["fields"]}
        self.cs = await d.controlstream(sid, "import", "Import a file", import_schema())
        await d.find_systems()
        self.task = asyncio.ensure_future(d.receive(self.cs, self._handle, self.opened))
        await asyncio.wait_for(self.opened.wait(), 15)  # subscribed before it is ready (FR-27)
        self.listing = await self.folder.list()
        for f in self.listing:
            await self._publish(f, "not-imported")
        a = next((f for f in self.listing if f["file"].startswith("MISSION_A_")), None)
        if a is not None:
            await self.import_file(a)

    async def _publish(self, f, status, ds=None, pct=None):
        now = time.time()
        row = {"time": iso(round(now, 3)), "file": f["file"], "size": f["size"], "modified": f["modified"],
               "sha256": f["sha256"], "dataset": ds["id"] if ds else "", "start": ds["start"] if ds else None,
               "end": ds["end"] if ds else None, "records": ds["records"] if ds else None, "status": status,
               "pct": pct if pct is not None else (100 if status == "imported" else 0)}
        # A Time or Count with no value yet is "NaN", as the stand-ins write it. OpenSensorHub refuses a Count
        # without an integer ("NaN" and null alike): the fallback writes 0 for it and null for a Time (D-197).
        out = {k: ("NaN" if v is None else _value(self.cat_types[k], v)) for k, v in row.items()}
        st = await self.d.obs(self.catalogue, out)
        if st not in (200, 201):
            self.catalogue_refusals += 1
            out = {k: (v if v != "NaN" else 0 if self.cat_types[k] == "Count" else None) for k, v in out.items()}
            st = await self.d.obs(self.catalogue, out)
            assert st in (200, 201), f"catalogue observation refused even with the fallback: {st}"

    async def _handle(self, cmd):
        p, cid = cmd.get("parameters", {}), cmd["id"]
        if p.get("action") == "rescan":
            await self.d.status(self.cs, cid, "ACCEPTED")
            self.listing = await self.folder.list()
            await self.d.status(self.cs, cid, "COMPLETED", f"{len(self.listing)} files")
            return
        entry = next((f for f in self.listing if f["file"] == p.get("file")), None)
        if p.get("action") != "import" or entry is None:
            await self.d.status(self.cs, cid, "REJECTED", f"unknown file {p.get('file')!r}: not in the data folder")
            return
        await self.d.status(self.cs, cid, "ACCEPTED")
        ds = await self.import_file(entry)
        await self.d.status(self.cs, cid, "COMPLETED", f"imported as {ds['id']}")

    async def import_file(self, entry) -> dict:
        d = self.d
        t0 = time.monotonic()
        await self._publish(entry, "importing", pct=0)
        parsed = dialect.parse(await self.folder.read(entry["file"]))
        dsid = dataset_id(entry["file"], entry["sha256"])
        n = min(len(parsed.t), self.rows) if self.rows else len(parsed.t)
        outs = []
        for s in SENSORS:
            names = [f for f in QUANTITIES if (s, f) in parsed.values]
            if names:
                ds = await d.datastream(d.systems[f"{URN}sensor:{s}"], f"weather__{dsid}",
                                        f"{s.capitalize()} sensor record · {dsid}",
                                        swe.measurement_record(names, f"{s.capitalize()} sensor record"))
                outs.append((ds, Importer._columns(parsed, s, names), names))
            if (s, "co2") in parsed.values:
                rec = swe.measurement_record(["co2"], f"{s.capitalize()} CO₂")
                at = (d.systems[f"{URN}sensor:{s}:co2"], f"co2__{dsid}", f"{s.capitalize()} CO₂ · {dsid}")
                try:
                    ds = await d.datastream(*at, rec)
                except AssertionError as e:  # OpenSensorHub refuses the UCUM code "ppm"; UCUM's is "[ppm]" (D-195)
                    if "UCUM" not in str(e):
                        raise
                    self.unit_substitutions.append(f"co2__{dsid} under sensor:{s}:co2: ppm refused, written as [ppm]")
                    rec["fields"][1]["uom"] = {"code": "[ppm]"}
                    ds = await d.datastream(*at, rec)
                outs.append((ds, Importer._columns(parsed, s, ["co2"]), ["co2"]))
        rows = []
        for ds, cols, names in outs:
            for i in range(n):
                row = {"time": iso(float(cols["t"][i]))}
                for f in names:
                    row[f] = _value("Quantity", cols[f][i])
                    row[f"{f}_qc"] = str(cols[f"{f}_qc"][i])
                rows.append((ds, row))
        sem = asyncio.Semaphore(8)
        refused = []

        async def one(ds, row):
            async with sem:
                st = await d.obs(ds, row)
                if st not in (200, 201):
                    refused.append(st)
        await asyncio.gather(*(one(ds, row) for ds, row in rows))
        assert not refused, f"{len(refused)} observations refused: {sorted(set(refused))}"
        ds = {"id": dsid, "file": entry["file"], "start": float(parsed.t[0]), "end": float(parsed.t[n - 1]), "records": n}
        self.datasets[dsid] = ds
        await self._publish(entry, "imported", ds)
        self.rate = round(len(rows) / max(time.monotonic() - t0, 1e-6))
        self.written = len(rows)
        return ds


# --- the replay controller, as a client (§8) -------------------------------------------------------------
class ReplayClient:
    def __init__(self, osh: Osh, importer: ImporterClient):
        self.d = Direct(osh, "svc-replay")
        self.importer = importer
        self.opened = asyncio.Event()
        self.ds = None
        self.time = None
        self.rate, self.playing, self.at_end, self.models_ready = 1.0, False, False, False
        self.runs: dict[str, int] = {}
        self.run = ""

    async def start(self) -> None:
        d = self.d
        sid = await d.system(URN + "replay", "Replay controller", "Holds the current dataset and the replay clock; "
                             "takes load, play, pause and seek as commands.", SOSA + "System", "Simulation",
                             kind="SimpleProcess")
        self.state_ds = await d.datastream(sid, "state", "Replay state", state_schema())
        self.state_types = {f["name"]: f["type"] for f in state_schema()["fields"]}
        self.log_ds = await d.datastream(sid, "log", "Replay log", log_schema())
        self.log_types = {f["name"]: f["type"] for f in log_schema()["fields"]}
        self.cs = await d.controlstream(sid, "replay", "Replay", control_schema())
        await d.find_systems()
        self.task = asyncio.ensure_future(d.receive(self.cs, self._handle, self.opened))
        await asyncio.wait_for(self.opened.wait(), 15)
        a = next((x for x in self.importer.datasets.values() if x["file"].startswith("MISSION_A_")), None)
        if a is not None:
            await self._load(a)
            await self._log("", "load", "svc-replay")
        self.ticker = asyncio.ensure_future(self._tick())

    async def bound(self):
        """The slowest model's max_rate, from its SensorML characteristics (FR-86)."""
        r = await self.d.c.get(f"/systems/{self.d.systems[URN + 'process:models']}/subsystems", params={"f": SML})
        rates = []
        for s in r.json().get("items", []) if r.status_code == 200 else []:
            for grp in s.get("characteristics", []):
                for ch in grp.get("characteristics", []):
                    if ch.get("name") == "max_rate":
                        rates.append((float(ch["value"]), s.get("label", "")))
        return min(rates) if rates else (max(C.RATES), "")

    async def publish(self):
        bound, model = await self.bound()
        row = {"time": self.time, "dataset": self.ds["id"], "start": self.ds["start"], "end": self.ds["end"],
               "position": self.time, "rate": self.rate, "max_rate": bound, "max_rate_model": model,
               "playing": self.playing, "at_end": self.at_end, "run": self.run, "models_ready": self.models_ready}
        await self.d.obs(self.state_ds, {k: _value(self.state_types[k], v) for k, v in row.items()})

    async def _log(self, cid, action, sender, note=""):
        row = {"time": self.time, "command_id": cid, "action": action, "dataset": self.ds["id"] if self.ds else "",
               "rate": self.rate, "position": self.time, "run": self.run, "sender": sender, "note": note}
        await self.d.obs(self.log_ds, {k: _value(self.log_types[k], v) for k, v in row.items()})

    async def _load(self, ds):
        self.ds, self.time, self.playing, self.at_end, self.models_ready = ds, ds["start"], False, False, False
        self.runs[ds["id"]] = self.runs.get(ds["id"], 0) + 1
        self.run = f"r-{ds['id']}-{self.runs[ds['id']]}"
        self.loaded_at = time.monotonic()
        await self.publish()

    async def _handle(self, cmd):
        p, cid, d = cmd.get("parameters", {}), cmd["id"], self.d
        action = p.get("action")
        try:
            rate = float(p.get("rate"))
        except (TypeError, ValueError):
            rate = None
        bound, model = await self.bound()
        why = (f"action {action!r} is not one of {', '.join(ACTIONS)}" if action not in ACTIONS else
               f"rate {p.get('rate')!r} is not one of {', '.join(f'{r:g}' for r in C.RATES)}" if rate not in C.RATES else
               f"rate {rate:g} exceeds {bound:g}, the highest {model} sustains" if rate > bound + 1e-9 else
               f"dataset {p.get('dataset')!r} is not imported" if action == "load" and p.get("dataset") not in self.importer.datasets
               else "no dataset is loaded" if action != "load" and self.ds is None else "")
        if why:
            await d.status(self.cs, cid, "REJECTED", why)
            return
        await d.status(self.cs, cid, "ACCEPTED")
        self.rate = rate
        if action == "load":
            await self._load(self.importer.datasets[p["dataset"]])
        elif action in ("play", "pause"):
            self.playing = action == "play"
        else:
            from barge.times import parse_iso
            self.time = parse_iso(str(p.get("position")))
            self.runs[self.ds["id"]] += 1
            self.run = f"r-{self.ds['id']}-{self.runs[self.ds['id']]}"
        await self._log(cid, action, cmd.get("sender", ""))
        await self.publish()
        await d.status(self.cs, cid, "COMPLETED", f"{action}: {self.ds['id']} at {iso(self.time)}, run {self.run}")

    async def _tick(self):
        last = time.monotonic()
        while True:
            await asyncio.sleep(1.0)
            now = time.monotonic()
            if self.ds is None:
                continue
            if self.playing:
                self.time = min(self.ds["end"], self.time + self.rate * (now - last))
                self.at_end = self.time >= self.ds["end"]
                self.playing = not self.at_end
                await self.publish()
            last = now
            if not self.models_ready:
                await self._check_models()

    async def _check_models(self):
        """Models ready (§8): every model under Models has a datastream ending ``__<dataset>``."""
        c, models = self.d.c, self.d.systems[URN + "process:models"]
        subs = (await c.get(f"/systems/{models}/subsystems", params={"limit": "10000"})).json().get("items", [])
        dss = (await c.get("/datastreams", params={"limit": "10000"})).json().get("items", [])
        waiting = []
        for m in subs:
            own = {m["id"]} | {s["id"] for s in (await c.get(f"/systems/{m['id']}/subsystems")).json().get("items", [])}
            if not any(x["system@id"] in own and x["outputName"].endswith("__" + self.ds["id"]) for x in dss):
                waiting.append(m["id"])
        timed_out = time.monotonic() - self.loaded_at >= C.MODEL_READY_TIMEOUT_S
        if (subs and not waiting) or timed_out:
            self.models_ready = True
            if waiting:
                await self._log("", "models-ready", "svc-replay", note=f"skipped {len(waiting)} not ready after "
                                f"{C.MODEL_READY_TIMEOUT_S:g} s")
            await self.publish()


# --- the core models, through the gateway (§10) -------------------------------------------------------------
class Models:
    def __init__(self, base: str):
        self.http = httpx.AsyncClient(base_url=base, timeout=90, trust_env=False)
        self.runners = []
        for cls in (data_cleanse.DataCleanse, summaries.Summaries, analysis.Analysis):
            m = cls()
            api = csmodel.Api(m.id, self.transport, f"svc-{m.id}", A.SERVICE_PASSWORD, stream=self.stream)
            api.role_of = A.role_of
            self.runners.append(csmodel.Runner(m, api))

    async def transport(self, method, path, headers, body):
        try:
            r = await self.http.request(method, path, headers=headers, content=body)
        except httpx.HTTPError as e:
            raise csmodel.Unavailable(str(e))
        return r.status_code, {k.lower(): v for k, v in r.headers.items()}, r.content

    async def stream(self, path, headers):
        cm = self.http.stream("GET", path, headers=headers, timeout=httpx.Timeout(90, read=None))
        try:
            resp = await cm.__aenter__()
        except httpx.HTTPError as e:
            raise csmodel.Unavailable(str(e))

        async def chunks():
            try:
                async for c in resp.aiter_bytes():
                    yield c
            finally:
                await cm.__aexit__(None, None, None)
        if resp.status_code != 200:
            await cm.__aexit__(None, None, None)
            return resp.status_code, _empty()
        return resp.status_code, chunks()

    async def run(self):
        while True:
            for r in self.runners:
                try:
                    await r.step()
                except Exception as e:  # noqa: BLE001 - a broken model never stops the others
                    r.phase, r.detail = "failed", f"{type(e).__name__}: {e}"
            await asyncio.sleep(1.0)


async def _empty():
    return
    yield  # noqa


# --- the suite's client (as in tests/test_contract_uvicorn.py) ----------------------------------------------
class Stream:
    def __init__(self, client, cm, resp):
        self.client, self.cm, self.resp = client, cm, resp
        self.status = resp.status_code
        self.lines = resp.aiter_lines()

    async def next_line(self, timeout=10.0):
        try:
            return await asyncio.wait_for(self.lines.__anext__(), timeout)
        except (StopAsyncIteration, asyncio.TimeoutError):
            return None

    async def close(self):
        await self.cm.__aexit__(None, None, None)
        await self.client.aclose()


class Client:
    def __init__(self, base):
        self.base = base

    async def request(self, method, path, params=None, body=None, headers=None):
        async with httpx.AsyncClient(base_url=self.base, timeout=90, trust_env=False) as c:
            r = await c.request(method, path, params=params, json=body, headers=headers)
            ctype = r.headers.get("content-type", "")
            data = r.json() if ("json" in ctype and r.content) else r.text
            return r.status_code, dict(r.headers), data

    async def open_stream(self, path, params=None, headers=None):
        c = httpx.AsyncClient(base_url=self.base, timeout=httpx.Timeout(90, read=None), trust_env=False)
        cm = c.stream("GET", path, params=params, headers=headers)
        resp = await cm.__aenter__()
        return Stream(c, cm, resp)


# --- one run --------------------------------------------------------------------------------------------------
async def run_once(home: Path, rundir: Path, folder: Path, rows: int, proposed: bool, log) -> dict:
    osh = Osh(home, rundir)
    tasks = []
    out = {"proposed": proposed, "setup": {}}
    try:
        out["setup"]["osh_start_s"] = round(await asyncio.to_thread(osh.start), 2)
        log(f"OpenSensorHub started in {out['setup']['osh_start_s']} s on port {osh.port}")
        upstream = OshUpstream(osh.root, proposed=proposed)
        gw = OshGateway(upstream)
        gport = free_port()
        srv = uvicorn.Server(uvicorn.Config(gw, host="127.0.0.1", port=gport, log_level="warning", lifespan="off"))
        tasks.append(asyncio.ensure_future(srv.serve()))
        while not srv.started:
            await asyncio.sleep(0.05)
        base = f"http://127.0.0.1:{gport}/"
        log(f"gateway on {base}")
        await install(osh)
        log("installed: platform, sensors, CO₂ analysers, Models, workspaces")
        imp = ImporterClient(osh, folder, rows)
        t = time.monotonic()
        await imp.start()
        out["setup"]["import"] = {"datasets": list(imp.datasets), "observations": imp.written,
                                  "seconds": round(time.monotonic() - t, 1), "observations_per_s": imp.rate,
                                  "catalogue_refusals": imp.catalogue_refusals,
                                  "unit_substitutions": imp.unit_substitutions}
        log(f"importer: {out['setup']['import']}")
        rep = ReplayClient(osh, imp)
        await rep.start()
        log(f"replay: loaded {rep.ds['id'] if rep.ds else None}, run {rep.run}")
        models = Models(base)
        tasks.append(asyncio.ensure_future(models.run()))
        t = time.monotonic()
        while not rep.models_ready and time.monotonic() - t < C.MODEL_READY_TIMEOUT_S + 20:
            await asyncio.sleep(0.5)
        out["setup"]["models"] = {r.model.id: f"{r.phase}: {r.detail}" for r in models.runners}
        out["setup"]["models_ready_after_s"] = round(time.monotonic() - t, 1) if rep.models_ready else None
        log(f"models: {out['setup']['models']}")
        tasks += [imp.task, rep.task, rep.ticker]
        results = await suite.run(Client(base))
        out["results"] = results
        out["setup"]["proposed_rewrites"] = dict(upstream.rewrites)
    except Exception as e:  # noqa: BLE001 - reported
        out["error"] = f"{type(e).__name__}: {e}\n{traceback.format_exc(limit=4)}"
    finally:
        for t in tasks:
            t.cancel()
        await asyncio.to_thread(osh.stop)
    return out


def report(out: dict) -> tuple[int, int]:
    title = "with the proposed changes (NOT AT-32 as specified)" if out["proposed"] else "AT-32 as specified"
    print(f"\n=== Contract suite against stock OpenSensorHub 2.0.4: {title} ===")
    if "error" in out:
        print("SET-UP FAILED:", out["error"])
    passed = total = 0
    for r in out.get("results", []):
        mark = {"passed": "PASS", "failed": "FAIL", "skipped": "SKIP"}[r["outcome"]]
        why = ""
        if r["outcome"] != "passed":
            why = " -- " + r["detail"].splitlines()[0][:180]
        print(f"  {mark}  {r['group']:<7} {r['name']}{why}")
        if r["group"] == "need":
            total += 1
            passed += r["outcome"] == "passed"
    print(f"  need: {passed} of {total} passed")
    return passed, total


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--osh", help="osh-core's installed distribution (or the osh-core checkout); else $OSH_HOME")
    ap.add_argument("--folder", default=str(ROOT / "web" / "public" / "data" / "folder"))
    ap.add_argument("--rows", type=int, default=900, help="rows of Mission A imported over HTTP (0: all)")
    ap.add_argument("--proposed", action="store_true", help="also run with the finding's proposed changes")
    ap.add_argument("--json", help="write every result to this file")
    ap.add_argument("--rundir", help="where OpenSensorHub keeps its store (default: a temporary directory)")
    a = ap.parse_args()
    home = find_home(a.osh)
    folder = Path(a.folder)
    if not (folder / "index.json").exists():
        raise SystemExit(f"no data folder at {folder}: python scripts/build_data_folder.py")
    base = Path(a.rundir) if a.rundir else Path(tempfile.mkdtemp(prefix="at32-osh-"))
    log = lambda m: print(f"[{time.strftime('%H:%M:%S')}] {m}", flush=True)  # noqa: E731
    runs = [asyncio.run(run_once(home, base / "as-specified", folder, a.rows, False, log))]
    if a.proposed:
        runs.append(asyncio.run(run_once(home, base / "proposed", folder, a.rows, True, log)))
    scores = [report(r) for r in runs]
    if a.json:  # the record: each check's first line of detail, without tracebacks (no local paths)
        for r in runs:
            for x in r.get("results", []):
                x["detail"] = x["detail"].splitlines()[0][:400] if x["detail"] else ""
            if "error" in r:
                r["error"] = r["error"].splitlines()[0][:400]
        Path(a.json).write_text(json.dumps({"server": "OpenSensorHub osh-core 2.0.4 (75bb094), unmodified",
                                            "date": time.strftime("%Y-%m-%d"), "rows_imported": a.rows, "runs": runs},
                                           indent=1, default=str) + "\n")
    ok = "error" not in runs[0] and scores[0][0] == scores[0][1] and scores[0][1] > 0
    print(f"\nAT-32: {'PASSED' if ok else 'NOT PASSED'} ({scores[0][0]} of {scores[0][1]} need checks)")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

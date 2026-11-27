#!/usr/bin/env python3
"""AT-32: the server-neutral contract suite against a stock OpenSensorHub, with credentials, talking to it directly.

4.7 (ADR 0010, D-221): there is no access gateway. Restriction is OpenSensorHub's own: a restricted resource is
listed and described, and its contents refused with 403 (D-351), by OpenSensorHub's permissions (``osh_server``).
What runs, all on this machine:

* **OpenSensorHub** ``osh-core`` 2.0.4, unmodified, configured as interfaces §14 allows (``osh_server.py``);
* the **installation**: the platform, sensors, CO₂ analysers and Models (by the owner), and one workspace per
  user, made by that user (§6);
* the **CSV importer** as a client of OpenSensorHub under ``svc-importer`` (D-201): one observation per ``POST``,
  the first ``--rows`` rows of Mission A (the bulk path is a Java module, S-IMPORT); its receiver subscribes on
  ``/api-internal`` (D-223);
* the **core models**, the same Python as everywhere (``models/``), each processing Mission A on import (§10.2),
  their receivers on ``/api-internal``;
* then the **allow-list** written for what now exists and OpenSensorHub restarted to read it (D-222): the
  receivers resubscribe (AT-38);
* then the **contract suite**, ``contract_suite/suite.py``, unchanged, straight to OpenSensorHub. Its push
  subscriptions are OpenSensorHub's WebSocket, each message one line (§9.2's ``PushChannel`` does the same).

It prints pass or fail for every check and the differences found. ``need`` checks are AT-32; ``standin`` checks
are what the stand-ins do to behave as the configured server is expected to (§9.1, §14), for information.

Usage::

    python backend/independent/at32_osh.py --osh <osh-core>/build/install/osh-core [--json out.json]

Needs Java 17+, and ``websockets`` beside ``backend/requirements-dev.txt``. Exit status 0 only if every ``need``
check passes.
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

import csmodel  # noqa: E402
from barge import accounts as A  # noqa: E402
from barge import config as C  # noqa: E402
from barge import dialect  # noqa: E402
from barge import scoring  # noqa: E402
from barge.fields import QUANTITIES  # noqa: E402
from barge.folder import DirFolder  # noqa: E402
from barge.importer import SENSORS, Importer, dataset_id, master, weather_schema  # noqa: E402
from barge.local_models import CORE  # noqa: E402
from barge.server import iso  # noqa: E402
from contract_suite import suite  # noqa: E402
from osh_server import Osh, Resources, find_home  # noqa: E402

ROOT = HERE.parents[1]
URN = "urn:x-barge:"
SOSA = "http://www.w3.org/ns/sosa/"
SML = "application/sml+json"
SWE = "application/swe+json"


def basic(user: str) -> str:
    return "Basic " + base64.b64encode(f"{user}:{A.Accounts().by_user[user].password}".encode()).decode()


class Direct:
    """One account's requests straight to OpenSensorHub's API."""

    def __init__(self, osh: Osh, user: str):
        self.osh, self.user = osh, user
        self.c = httpx.AsyncClient(base_url=osh.root + "/api", headers={"Authorization": basic(user)},
                                   timeout=90, trust_env=False)
        self.systems: dict[str, str] = {}

    async def system(self, uid, label, desc, definition, asset, parent_uid=None, kind="PhysicalSystem"):
        path = f"/systems/{self.systems[parent_uid]}/subsystems" if parent_uid else "/systems"
        body = {"type": kind, "uniqueId": uid, "label": label, "description": desc, "definition": definition,
                "assetType": asset}
        r = await self.c.post(path, content=json.dumps(body), headers={"content-type": SML})
        assert r.status_code == 201, (uid, r.status_code, r.text[:300])
        self.systems[uid] = r.headers["location"].rsplit("/", 1)[-1]
        return self.systems[uid]

    async def find_systems(self):
        r = await self.c.get("/systems", params={"searchMembers": "true", "limit": "10000", "f": SML})
        for s in r.json()["items"]:
            self.systems[s["uniqueId"]] = s["id"]

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


class WsStream:
    """A push subscription (§9.2) on OpenSensorHub's WebSocket: each message is one command, one line.

    ``status``: 200 once the subscription holds; the handshake's own status if refused; 403 if OpenSensorHub
    accepts the upgrade and then closes it at once, as it closes receivers with access control on (S-AUTH)."""

    def __init__(self):
        self.status, self.ws, self.queue = None, None, asyncio.Queue()
        self.task = None

    @classmethod
    async def open(cls, url: str, headers: dict) -> "WsStream":
        import websockets

        s = cls()
        try:
            s.ws = await websockets.connect(url, additional_headers=headers, proxy=None, open_timeout=10)
        except websockets.exceptions.InvalidStatus as e:
            s.status = e.response.status_code
            return s
        except (OSError, websockets.exceptions.WebSocketException, asyncio.TimeoutError):
            s.status = 0
            return s

        async def pump():
            try:
                async for msg in s.ws:
                    await s.queue.put(msg if isinstance(msg, str) else msg.decode())
            except websockets.exceptions.WebSocketException:
                pass
            await s.queue.put(None)
        s.task = asyncio.ensure_future(pump())
        await asyncio.sleep(0.5)
        s.status = 403 if s.task.done() or s.ws.close_code is not None else 200
        return s

    async def next_line(self, timeout=10.0):
        try:
            return await asyncio.wait_for(self.queue.get(), timeout)
        except asyncio.TimeoutError:
            return None

    async def chunks(self):
        while True:
            line = await self.queue.get()
            if line is None:
                return
            yield (line.strip() + "\n").encode()

    async def close(self):
        if self.ws is not None:
            await self.ws.close()
        if self.task is not None:
            self.task.cancel()


def ws_url(osh: Osh, path: str, internal: bool) -> str:
    return osh.root.replace("http", "ws", 1) + ("/api-internal" if internal else "/api") + "/" + path.lstrip("/")


def _value(ty: str, v):
    if isinstance(v, np.generic):
        v = v.item()
    if ty in ("Quantity", "Count"):
        if v is None or (isinstance(v, float) and v != v):
            return "NaN" if ty == "Quantity" else 0
        return int(v) if ty == "Count" else float(v)
    if ty == "Time":
        return None if v is None or (isinstance(v, float) and v != v) else (v if isinstance(v, str) else iso(v))
    return v


# --- the installation (§6): what the stand-ins' server configuration creates -------------------------------
async def install(osh: Osh) -> None:
    own = Direct(osh, "owner")
    await own.system(URN + "platform:barge", "Collection platform", "The uncrewed electric cargo barge. It records no "
                     "position.", SOSA + "Platform", "Platform")
    for s in SENSORS:
        await own.system(f"{URN}sensor:{s}", f"{s.capitalize()} sensor", "Seven parameters at 1 Hz.", SOSA + "Sensor",
                         "Equipment", URN + "platform:barge")
        await own.system(f"{URN}sensor:{s}:co2", f"{s.capitalize()} CO₂ analyser", "Carbon dioxide at the sensor, in "
                         "parts per million. Restricted (FR-93).", SOSA + "Sensor", "Equipment", f"{URN}sensor:{s}")
    await own.system(URN + "process:models", "Models", "A home for models that turn sensor data into insight.",
                     SOSA + "System", "Process", kind="SimpleProcess")
    for user in A.USERS:
        await Direct(osh, user).system(f"{URN}workspace:{user}", f"Workspace of {user}", "Data of interest saved by "
                                       "this user (FR-94).", SOSA + "System", "Other", kind="SimpleProcess")


# --- the CSV importer, as a client (§7, D-201) -----------------------------------------------------------------
class ImporterClient:
    def __init__(self, osh: Osh, folder: Path, rows: int):
        self.osh = osh
        self.d = Direct(osh, "svc-importer")
        self.folder = DirFolder(folder)
        self.rows = rows
        self.datasets: dict[str, dict] = {}
        self.subscribed = asyncio.Event()
        self.subscriptions = 0
        self.rate = None
        self.written = 0
        self.refusals: list[str] = []

    async def start(self) -> None:
        d = self.d
        sid = await d.system(URN + "importer", "CSV importer", "Lists the data folder and imports its CSV files.",
                             "http://www.w3.org/ns/sosa/System", "Equipment", kind="SimpleProcess")
        self.catalogue = await d.datastream(sid, "catalogue", "Archive catalogue", master("catalogue-record.json"))
        self.types = {f["name"]: f["type"] for f in master("catalogue-record.json")["fields"]}
        self.cs = await d.controlstream(sid, "import", "Import a file", master("controlstreams/import.json"))
        await d.find_systems()
        self.task = asyncio.ensure_future(self.receive())
        await asyncio.wait_for(self.subscribed.wait(), 15)  # subscribed before it is ready (AT-38)
        self.listing = await self.folder.list()
        for f in self.listing:
            await self._publish(f, "not-imported")
        a = next((f for f in self.listing if f["file"].startswith("MISSION_A_")), None)
        if a is not None:
            await self.import_file(a)

    async def receive(self):
        """Its receiver on the internal endpoint; it resubscribes whenever the server goes away (AT-38)."""
        while True:
            s = await WsStream.open(ws_url(self.osh, f"controlstreams/{self.cs}/commands", True),
                                    {"Authorization": basic("svc-importer")})
            if s.status == 200:
                self.subscriptions += 1
                self.subscribed.set()
                while (line := await s.next_line(timeout=3600)) is not None:
                    asyncio.ensure_future(self._handle(json.loads(line)))
            await s.close()
            await asyncio.sleep(1.0)

    async def _publish(self, f, status, ds=None, pct=None):
        named = ds is not None
        row = {"time": iso(time.time() - C.SIM_EPOCH_UNIX), "file": f["file"], "size": f["size"], "modified": f["modified"],
               "sha256": f["sha256"], "dataset": ds["id"] if named else "", "start": ds["start"] if named else None,
               "end": ds["end"] if named else None, "records": ds["records"] if named else 0, "status": status,
               "pct": pct if pct is not None else (100 if named else 0)}
        out = {k: _value(self.types[k], v) for k, v in row.items()}
        st = await self.d.obs(self.catalogue, out)
        if st not in (200, 201):
            self.refusals.append(f"catalogue {status}: {st}")

    async def _handle(self, cmd):
        p, cid = cmd.get("parameters", {}), cmd["id"]
        entry = next((f for f in self.listing if f["file"] == p.get("file")), None)
        if p.get("action") == "rescan":
            await self.d.status(self.cs, cid, "ACCEPTED")
            self.listing = await self.folder.list()
            await self.d.status(self.cs, cid, "COMPLETED", f"{len(self.listing)} files")
        elif p.get("action") != "import" or entry is None:
            await self.d.status(self.cs, cid, "REJECTED", f"unknown file {p.get('file')!r}: not in the data folder")
        else:
            await self.d.status(self.cs, cid, "ACCEPTED")
            ds = await self.import_file(entry)
            await self.d.status(self.cs, cid, "COMPLETED", f"imported as {ds['id']}")

    async def import_file(self, entry) -> dict:
        d = self.d
        t0 = time.monotonic()
        await self._publish(entry, "importing", pct=0)
        parsed = dialect.parse(await self.folder.read(entry["file"]))
        t = parsed.t - C.SIM_EPOCH_UNIX  # Unix seconds to the server's (iso), as the importer does
        dsid = dataset_id(entry["file"], entry["sha256"])
        n = min(len(parsed.t), self.rows) if self.rows else len(parsed.t)
        outs = []
        for s in SENSORS:
            names = [f for f in QUANTITIES if (s, f) in parsed.values]
            if names:
                ds = await d.datastream(d.systems[f"{URN}sensor:{s}"], f"weather__{dsid}",
                                        f"{s.capitalize()} weather · {dsid}", weather_schema(names, s))
                outs.append((ds, Importer._columns(parsed, s, names), names))
            if (s, "co2") in parsed.values:
                ds = await d.datastream(d.systems[f"{URN}sensor:{s}:co2"], f"co2__{dsid}", f"{s.capitalize()} CO₂ · {dsid}",
                                        dict(master("co2-record.json"), label=f"{s.capitalize()} CO₂ record"))
                outs.append((ds, Importer._columns(parsed, s, ["co2"]), ["co2"]))
        rows = []
        for ds, cols, names in outs:
            for i in range(n):
                row = {"time": iso(float(t[i]))}
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
        ds = {"id": dsid, "file": entry["file"], "start": float(t[0]), "end": float(t[n - 1]), "records": n}
        self.datasets[dsid] = ds
        await self._publish(entry, "imported", ds)
        self.rate = round(len(rows) / max(time.monotonic() - t0, 1e-6))
        self.written += len(rows)
        return ds


# --- the core models, straight to OpenSensorHub (§10) -----------------------------------------------------------
class Models:
    def __init__(self, osh: Osh):
        self.osh = osh
        self.http = httpx.AsyncClient(base_url=osh.root + "/api", timeout=90, trust_env=False)
        self.runners = []
        self.subscriptions = 0
        for cls in CORE:
            m = cls()
            api = csmodel.Api(m.id, self.transport, f"svc-{m.id}", A.SERVICE_PASSWORD, stream=self.stream)
            api.role_of = A.role_of
            self.runners.append(csmodel.Runner(m, api))

    async def transport(self, method, path, headers, body):
        if path.startswith("/demonstrator/referee/"):
            # The referee is the demonstrator's scaffolding (FR-37), not the data server's: beside OpenSensorHub it is
            # answered here, as the demonstrator's server answers it (D-347).
            try:
                out = scoring.referee(path.rsplit("/", 1)[-1], json.loads(body or b"{}"))
                return 200, {"content-type": "application/json"}, json.dumps(out).encode()
            except (KeyError, TypeError, ValueError):  # KeyError first: it is a LookupError too
                return 400, {}, b""
            except LookupError:
                return 404, {}, b""
        try:
            r = await self.http.request(method, path, headers=headers, content=body)
        except httpx.HTTPError as e:
            raise csmodel.Unavailable(str(e))
        return r.status_code, {k.lower(): v for k, v in r.headers.items()}, r.content

    async def stream(self, path, headers, internal=False):
        """§9.2's subscription, on OpenSensorHub's WebSocket: (status, chunks), one line per command."""
        path = path.split("?", 1)[0]
        s = await WsStream.open(ws_url(self.osh, path, internal), {k: v for k, v in headers.items()
                                                                   if k.lower() == "authorization"})
        if s.status == 0:
            raise csmodel.Unavailable("the data server does not answer")
        if s.status == 200:
            self.subscriptions += 1
        return s.status, s.chunks()

    def phases(self) -> dict:
        return {r.model.id: f"{r.phase}: {r.detail}" for r in self.runners}

    def live(self) -> bool:
        return all(r.phase == "live" for r in self.runners)

    async def run(self):
        while True:
            for r in self.runners:
                try:
                    await r.step()
                except Exception as e:  # noqa: BLE001 - a broken model never stops the others
                    r.phase, r.detail = "failed", f"{type(e).__name__}: {e}"
            await asyncio.sleep(0.2)


# --- the allow-list's input: what the server holds (read where access control is off, as its tooling would) ------
async def resources(osh: Osh) -> Resources:
    res = Resources()
    async with httpx.AsyncClient(base_url=osh.root + "/api-internal", headers={"Authorization": basic("owner")},
                                 timeout=90, trust_env=False) as c:
        items = (await c.get("/systems", params={"searchMembers": "true", "limit": "100000", "f": SML})).json()["items"]
        for s in items:
            res.systems[s["id"]] = {"uid": s["uniqueId"], "parent": None}
        for sid in list(res.systems):
            for s in (await c.get(f"/systems/{sid}/subsystems", params={"limit": "100000"})).json().get("items", []):
                if s["id"] in res.systems:
                    res.systems[s["id"]]["parent"] = sid
        for d in (await c.get("/datastreams", params={"limit": "100000"})).json()["items"]:
            res.datastreams[d["id"]] = d["system@id"]
        for cs in (await c.get("/controlstreams", params={"limit": "100000"})).json()["items"]:
            res.controlstreams[cs["id"]] = cs["system@id"]
    return res


async def leaks(osh: Osh, res: Resources) -> dict:
    """Every datastream, read as the friend (weather only): a restricted one's description and schema should
    answer 200 and its observations 403 (D-351, AT-55); an open one's observations 200. Each departure is listed."""
    from osh_server import readable

    out = {"restricted": 0, "open": 0, "restricted_contents_read": [], "restricted_described": 0,
           "open_contents_refused": []}
    async with httpx.AsyncClient(base_url=osh.root + "/api", headers={"Authorization": basic("friend")}, timeout=90,
                                 trust_env=False) as c:
        for did, sid in res.datastreams.items():
            obs = (await c.get(f"/datastreams/{did}/observations", params={"f": SWE, "limit": "1"})).status_code
            if readable(res, sid, A.WEATHER, "friend"):
                out["open"] += 1
                if obs != 200:
                    out["open_contents_refused"].append(f"{did} ({res.uid(sid)}): {obs}")
                continue
            out["restricted"] += 1
            if obs == 200:
                out["restricted_contents_read"].append(f"{did} ({res.uid(sid)})")
            meta = [(await c.get(p, params=q)).status_code for p, q in
                    ((f"/datastreams/{did}", None), (f"/datastreams/{did}/schema", {"obsFormat": SWE}))]
            out["restricted_described"] += meta == [200, 200]
    return out


# --- the suite's client: straight to OpenSensorHub ---------------------------------------------------------------
class Client:
    def __init__(self, osh: Osh):
        self.osh = osh
        self.base = osh.root + "/api/"

    async def request(self, method, path, params=None, body=None, headers=None):
        if path == "profile.json":  # beside the API, where a stock server can serve it (osh_server, D-345)
            path = "../profile.json"
        async with httpx.AsyncClient(base_url=self.base, timeout=90, trust_env=False) as c:
            r = await c.request(method, path, params=params, json=body, headers=headers)
            return r.status_code, dict(r.headers), suite.read_body(r.content)  # JSON whatever the type (D-196)

    async def open_stream(self, path, params=None, headers=None, internal=False):
        return await WsStream.open(ws_url(self.osh, path, internal), dict(headers or {}))


async def wait_for(cond, timeout: float, step: float = 0.25) -> float | None:
    t = time.monotonic()
    while time.monotonic() - t < timeout:
        if cond():
            return round(time.monotonic() - t, 1)
        await asyncio.sleep(step)
    return None


# --- one run -------------------------------------------------------------------------------------------------------
async def run_once(home: Path, rundir: Path, folder: Path, rows: int, log) -> dict:
    osh = Osh(home, rundir, ROOT / "contracts" / "profile.json")
    tasks = []
    out = {"setup": {}}
    try:
        out["setup"]["osh_start_s"] = round(await asyncio.to_thread(osh.start), 2)
        log(f"OpenSensorHub started in {out['setup']['osh_start_s']} s on port {osh.port}, with the installation's roles")
        await install(osh)
        log("installed: platform, sensors, CO₂ analysers, Models; each workspace by its user")
        imp = ImporterClient(osh, folder, rows)
        t = time.monotonic()
        await imp.start()
        tasks.append(imp.task)
        out["setup"]["import"] = {"datasets": list(imp.datasets), "observations": imp.written,
                                  "seconds": round(time.monotonic() - t, 1), "observations_per_s": imp.rate,
                                  "refusals": imp.refusals}
        log(f"importer: {out['setup']['import']}")
        models = Models(osh)
        tasks.append(asyncio.ensure_future(models.run()))
        out["setup"]["models_live_after_s"] = await wait_for(models.live, 600)
        out["setup"]["models"] = models.phases()
        log(f"models: {out['setup']['models']}")
        # The allow-list for what now exists, and OpenSensorHub restarted to read it (D-222).
        res = await resources(osh)
        before = (imp.subscriptions, models.subscriptions)
        out["setup"]["restart_s"] = round(await asyncio.to_thread(osh.restart, res), 2)
        out["setup"]["allow_list"] = {"systems": len(res.systems), "datastreams": len(res.datastreams),
                                      "controlstreams": len(res.controlstreams), "open_but_refused": osh.refused}
        log(f"allow-list written for {out['setup']['allow_list']}; restarted in {out['setup']['restart_s']} s")
        again = await wait_for(lambda: imp.subscriptions > before[0] and models.subscriptions >= before[1] + 3, 60)
        out["setup"]["receivers_resubscribed_after_s"] = again
        out["setup"]["models_after_restart"] = models.phases()
        log(f"receivers resubscribed after {again} s; models {models.phases()}")
        out["setup"]["restricted_read_by_the_friend"] = await leaks(osh, res)
        log(f"as the friend: {out['setup']['restricted_read_by_the_friend']}")
        out["results"] = await suite.run(Client(osh))
    except Exception as e:  # noqa: BLE001 - reported
        out["error"] = f"{type(e).__name__}: {e}\n{traceback.format_exc(limit=4)}"
    finally:
        for t in tasks:
            t.cancel()
        await asyncio.to_thread(osh.stop)
    return out


def report(out: dict) -> tuple[int, int]:
    print("\n=== The contract suite against stock OpenSensorHub 2.0.4, directly (AT-32, 4.7) ===")
    if "error" in out:
        print("SET-UP FAILED:", out["error"])
    passed = total = 0
    for r in out.get("results", []):
        mark = {"passed": "PASS", "failed": "FAIL", "skipped": "SKIP"}[r["outcome"]]
        why = " -- " + r["detail"].splitlines()[0][:200] if r["outcome"] != "passed" else ""
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
    ap.add_argument("--json", help="write every result to this file")
    ap.add_argument("--rundir", help="where OpenSensorHub keeps its store (default: a temporary directory)")
    a = ap.parse_args()
    home = find_home(a.osh)
    folder = Path(a.folder)
    if not (folder / "index.json").exists():
        raise SystemExit(f"no data folder at {folder}: python scripts/build_data_folder.py")
    base = Path(a.rundir) if a.rundir else Path(tempfile.mkdtemp(prefix="at32-osh-"))
    log = lambda m: print(f"[{time.strftime('%H:%M:%S')}] {m}", flush=True)  # noqa: E731
    out = asyncio.run(run_once(home, base / "run", folder, a.rows, log))
    passed, total = report(out)
    if a.json:  # the record: each check's first line of detail, without tracebacks (no local paths)
        for x in out.get("results", []):
            x["detail"] = x["detail"].splitlines()[0][:400] if x["detail"] else ""
        if "error" in out:
            out["error"] = out["error"].splitlines()[0][:400]
        Path(a.json).write_text(json.dumps({"server": "OpenSensorHub osh-core 2.0.4 (75bb094), unmodified",
                                            "gateway": "none (4.7, ADR 0010)", "date": time.strftime("%Y-%m-%d"),
                                            "rows_imported": a.rows, "run": out}, indent=1, default=str) + "\n")
    ok = "error" not in out and passed == total and total > 0
    print(f"\nAT-32: {'PASSED' if ok else 'NOT PASSED'} ({passed} of {total} need checks)")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

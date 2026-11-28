"""AT-24, AT-27: the one contract suite against the JavaScript stand-in (PR-04).

The stand-in runs in Node behind a tiny HTTP server (web/scripts/standin-server.mjs),
over the same data folder the Python back end reads (FR-06d). Skipped, with the reason,
when Node or the web dependencies are missing: install them with ``cd web && npm ci``.
AT-27 (both back ends return identical values from the same files) is the importer test
below; the 4.1 pre-calculated history it was checked on is retired (D-320).
"""
import asyncio
import json
import shutil
import socket
import subprocess
import threading
import time
from pathlib import Path

import httpx
import pytest

from contract_suite import suite

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "web" / "scripts" / "standin-server.mjs"


def _why_skip():
    if not shutil.which("node"):
        return "node is not installed: the stand-in runs in Node for the contract suite"
    if not (ROOT / "web" / "node_modules" / "esbuild").exists():
        return "web/node_modules/esbuild is missing: run npm ci in web/"
    return None


class Standin:
    def __init__(self, proc, port, startup_ms):
        self.proc, self.port, self.startup_ms = proc, port, startup_ms
        self.base = f"http://127.0.0.1:{port}/"
        self.lines: list[str] = []
        self._cv = threading.Condition()
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        for line in self.proc.stdout:
            with self._cv:
                self.lines.append(line.strip())
                self._cv.notify_all()

    def control(self, action, arg=None, timeout=10.0) -> dict:
        """A control action (docs/v4-interfaces.md §8); returns the control state."""
        with self._cv:
            n = len(self.lines)
            self.proc.stdin.write(json.dumps({"action": action, "arg": arg}) + "\n")
            self.proc.stdin.flush()
            end = time.monotonic() + timeout
            while True:
                for line in self.lines[n:]:
                    if line.startswith("STATE "):
                        return json.loads(line[6:])
                    if line.startswith("ERROR "):
                        raise RuntimeError(line)
                left = end - time.monotonic()
                assert left > 0, "no answer to the control action"
                self._cv.wait(left)


@pytest.fixture(scope="module")
def standin(data_folder):
    why = _why_skip()
    if why:
        pytest.skip(why)
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    proc = subprocess.Popen(["node", str(SCRIPT), "--port", str(port), "--hold", "0.5", "--folder", str(data_folder), "--mission-a"],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, cwd=ROOT)
    try:
        deadline = time.monotonic() + 180
        startup = None
        while time.monotonic() < deadline:
            line = proc.stdout.readline()
            if not line:
                break
            if line.startswith("READY "):
                startup = int(line.split()[2])
                break
        assert startup is not None, f"the stand-in did not start (exit code {proc.poll()})"
        yield Standin(proc, port, startup)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


from tests.test_contract_uvicorn import Client  # noqa: E402 - the same client: real HTTP, /api-internal beside the API
from barge.accounts import basic  # noqa: E402

OWNER = {"Authorization": basic("owner", "demo-owner")}


def test_contract_suite_against_the_standin(standin):
    """AT-24: the same suite as test_contract_uvicorn.py, unchanged."""
    results = asyncio.run(suite.run(Client(standin.base)))
    failed = [r for r in results if r["outcome"] != "passed"]
    assert not failed, failed
    print(f"stand-in startup over the data folder: {standin.startup_ms} ms")


def _answers(c) -> httpx.Response:
    for _ in range(200):
        try:
            return c.get("")
        except httpx.TransportError:
            time.sleep(0.05)
    raise AssertionError("the stand-in never answered again")


def test_starting_and_down_answer_nothing_and_no_instance_identifier(standin):
    """§9.1 (4.7): no 503 and no instance identifier; while starting and while down, no answer at all."""
    c = httpx.Client(base_url=standin.base, timeout=30, headers=OWNER)
    r = c.get("")
    assert r.status_code == 200 and "x-server-instance" not in r.headers and "etag" not in r.headers
    state = standin.control("restart-server")
    assert state["backend"] == "standin" and state["server"] == "waiting"
    r = _answers(c)
    assert r.status_code == 200 and "x-server-instance" not in r.headers
    standin.control("down")
    with pytest.raises(httpx.TransportError):
        c.get("")
    standin.control("up")
    assert _answers(c).status_code == 200


def test_a_role_change_takes_effect_on_the_next_request(standin):
    """FR-116, D-151, through the admin stub's control action (set-role)."""
    friend = httpx.Client(base_url=standin.base, timeout=30, headers={"Authorization": basic("friend", "demo-friend")})
    sy = {s["uniqueId"]: s["id"] for s in friend.get("systems", params={"searchMembers": "true", "f": "application/sml+json"}).json()["items"]}
    co2 = sy["urn:x-barge:sensor:stern:co2"]
    ds = friend.get(f"systems/{co2}/datastreams").json()["items"][0]["id"]  # described to everyone (D-351)
    obs = f"datastreams/{ds}/observations"
    assert friend.get(obs).status_code == 403
    standin.control("set-role", {"user": "friend", "role": "viewer-emissions"})
    try:
        assert friend.get(obs).status_code == 200
    finally:
        standin.control("set-role", {"user": "friend", "role": "viewer"})
    assert friend.get(obs).status_code == 403


def test_the_importer_is_the_same_in_both_back_ends(standin, data_folder):
    """PR-06: the stand-in's importer is the Python one's twin. Over the same folder, Mission A (imported silently)
    and Mission C (imported on request) are served identically: catalogue, identifiers, schemas, observations."""
    from fastapi.testclient import TestClient

    from barge.api import create_app
    from barge.runtime import Runtime

    rt = Runtime(folder=data_folder, silent_import=True)
    while not (rt.running and rt.importer.subscribed):
        rt.tick()
    c_file = "MISSION_C_20310421.csv"
    entry = next(f for f in rt.importer.listing if f["file"] == c_file)
    rt.loop.run_until_complete(rt.importer.import_file(entry))
    py = TestClient(create_app(rt), headers=OWNER)
    js = httpx.Client(base_url=standin.base, timeout=60, headers=OWNER)
    uid = lambda c, p: {s["uniqueId"]: s["id"] for s in c.get(p + "systems", params={"searchMembers": "true", "f": "application/sml+json"}).json()["items"]}  # noqa: E731
    sy_py, sy_js = uid(py, "/"), uid(js, "")
    assert sy_py["urn:x-barge:importer"] == sy_js["urn:x-barge:importer"]
    swe = {"f": "application/swe+json", "limit": "100000"}
    listing = lambda c, p, sid: c.get(f"{p}systems/{sid}/datastreams").json()["items"]  # noqa: E731
    cat_py = next(x for x in listing(py, "/", sy_py["urn:x-barge:importer"]) if x["outputName"] == "catalogue")
    cat_js = next(x for x in listing(js, "", sy_js["urn:x-barge:importer"]) if x["outputName"] == "catalogue")
    fold = lambda rows: {r["file"]: {k: v for k, v in r.items() if k != "time"} for r in rows}  # noqa: E731
    rows_js = js.get(f"datastreams/{cat_js['id']}/observations", params=swe).json()
    if not any(r["file"] == c_file and r["status"] == "imported" for r in rows_js):
        ics = next(x for x in js.get(f"systems/{sy_js['urn:x-barge:importer']}/controlstreams").json()["items"])
        js.post(f"controlstreams/{ics['id']}/commands", json={"parameters": {"action": "import", "file": c_file}})
        for _ in range(100):
            rows_js = js.get(f"datastreams/{cat_js['id']}/observations", params=swe).json()
            if any(r["file"] == c_file and r["status"] == "imported" for r in rows_js):
                break
            time.sleep(0.1)
    rows_py = py.get(f"/datastreams/{cat_py['id']}/observations", params=swe).json()
    assert fold(rows_py) == fold(rows_js)
    datasets = [r["dataset"] for r in fold(rows_py).values() if r["status"] == "imported"]
    assert len(datasets) == 2
    for ds in datasets:
        for sensor in ("urn:x-barge:sensor:bow", "urn:x-barge:sensor:stern", "urn:x-barge:sensor:bow:co2", "urn:x-barge:sensor:stern:co2"):
            out = ("co2__" if sensor.endswith("co2") else "weather__") + ds
            a = next(x for x in listing(py, "/", sy_py[sensor]) if x["outputName"] == out)
            b = next(x for x in listing(js, "", sy_js[sensor]) if x["outputName"] == out)
            assert a["phenomenonTime"] == b["phenomenonTime"], (sensor, out)
            if ds.startswith("mission-a"):  # made before anything else: the same opaque identifiers
                assert a["id"] == b["id"], (sensor, out)
            sa = py.get(f"/datastreams/{a['id']}/schema", params={"obsFormat": "application/swe+json"}).json()
            sb = js.get(f"datastreams/{b['id']}/schema", params={"obsFormat": "application/swe+json"}).json()
            assert sa == sb, (sensor, out)
            for params in ({"limit": "5000", "f": "application/swe+json"}, {"resultTime": "latest", "f": "application/swe+json"},
                           {"phenomenonTime": a["phenomenonTime"][0] + "/..", "limit": "3"}):
                ra = py.get(f"/datastreams/{a['id']}/observations", params=params).json()
                rb = js.get(f"datastreams/{b['id']}/observations", params=params).json()
                if isinstance(ra, dict):  # observation resources carry their datastream's id
                    ra = [{k: v for k, v in x.items() if k not in ("id", "datastream@id")} for x in ra["items"]]
                    rb = [{k: v for k, v in x.items() if k not in ("id", "datastream@id")} for x in rb["items"]]
                assert ra == rb, (sensor, out, params)


def test_the_models_declare_the_same_outputs_in_both_back_ends(standin, data_folder):
    """PR-06, §10: the stand-in's models are the Python ones' twins in what they publish. On Mission A each core model
    declares the same datastreams with the same schemas, and logs a complete run 1. Values may differ: the stand-in's
    methods are simpler (FR-06e)."""
    from fastapi.testclient import TestClient

    from barge.api import create_app
    from barge.runtime import Runtime

    rt = Runtime(folder=data_folder, local_models=True, silent_import=True)
    while not (rt.running and rt.local.live and all(r.completed for r in rt.local.runners)):
        rt.tick()
    py = TestClient(create_app(rt), headers=OWNER)
    js = httpx.Client(base_url=standin.base, timeout=60, headers=OWNER)
    sys_of = lambda c, p: {s["uniqueId"]: s["id"] for s in c.get(p + "systems", params={"searchMembers": "true", "f": "application/sml+json"}).json()["items"]}  # noqa: E731
    sy_py, sy_js = sys_of(py, "/"), sys_of(js, "")
    a = next(d["id"] for d in rt.importer.datasets.values() if d["file"].startswith("MISSION_A"))
    swe = {"obsFormat": "application/swe+json"}
    for m in ("data-cleanse", "summaries", "analysis"):
        for uid in (f"urn:x-barge:process:{m}", f"urn:x-barge:process:{m}:restricted"):
            outs = {}
            for c, p, sy in ((py, "/", sy_py), (js, "", sy_js)):
                log = []
                for _ in range(600):  # the stand-in processes in the background
                    items = [x for x in c.get(f"{p}systems/{sy[uid]}/datastreams").json()["items"] if x["outputName"].endswith(a)]
                    runs = next((x for x in items if x["outputName"] == f"runs__{a}"), None)
                    log = c.get(f"{p}datastreams/{runs['id']}/observations", params={"f": "application/swe+json"}).json() if runs else []
                    if uid.endswith(":restricted") or (log and log[-1]["status"] == "complete"):
                        break
                    time.sleep(0.1)
                if not uid.endswith(":restricted"):
                    assert log[-1]["status"] == "complete" and log[-1]["run_id"] == f"{m}-{a}-1", (p, m, log[-1:])
                outs[p] = {x["outputName"]: c.get(f"{p}datastreams/{x['id']}/schema", params=swe).json() for x in items}
            assert outs["/"] == outs[""], (uid, sorted(outs["/"]), sorted(outs[""]))

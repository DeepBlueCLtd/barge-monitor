"""AT-24, AT-27: the one contract suite against the JavaScript stand-in (PR-04).

The stand-in runs in Node behind a tiny HTTP server (web/scripts/standin-server.mjs),
over the same pre-calculated history the Python back end loads (FR-06d). Skipped,
with the reason, when Node, the web dependencies or the history are missing:
build the history with ``python scripts/build_history.py --days 7 .cache/history 1 2 3``
and install the web dependencies with ``cd web && npm ci``.
"""
import asyncio
import gzip
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
SEED = 1


def _history_dir():
    ptr = ROOT / "web" / "public" / "py" / "history.json"
    if not ptr.exists():
        return None, "web/public/py/history.json is missing: run scripts/build_history.py"
    h = json.loads(ptr.read_text())
    d = ROOT / ".cache" / "history" / h["code_hash"] / f"days-{h['days']:g}"
    if not (d / f"seed-{SEED}" / "manifest.json").exists():
        return None, f"no pre-calculated history at {d}: run scripts/build_history.py --days {h['days']:g} .cache/history {SEED}"
    return d, None


def _why_skip():
    if not shutil.which("node"):
        return "node is not installed: the stand-in runs in Node for the contract suite"
    if not (ROOT / "web" / "node_modules" / "esbuild").exists():
        return "web/node_modules/esbuild is missing: run npm ci in web/"
    return _history_dir()[1]


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
def standin():
    why = _why_skip()
    if why:
        pytest.skip(why)
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    hist, _ = _history_dir()
    proc = subprocess.Popen(["node", str(SCRIPT), "--port", str(port), "--seed", str(SEED), "--history", str(hist)],
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


class Client:
    def __init__(self, base):
        self.base = base

    async def request(self, method, path, params=None, body=None, headers=None):
        async with httpx.AsyncClient(base_url=self.base, timeout=60) as c:
            r = await c.request(method, path, params=params, json=body, headers=headers)
            ctype = r.headers.get("content-type", "")
            data = r.json() if ("json" in ctype and r.content) else r.text
            return r.status_code, dict(r.headers), data


def test_contract_suite_against_the_standin(standin):
    """AT-24: the same suite as test_contract_uvicorn.py, unchanged."""
    results = asyncio.run(suite.run(Client(standin.base)))
    failed = [r for r in results if r["outcome"] != "passed"]
    assert not failed, failed
    print(f"stand-in startup with 7 days of history: {standin.startup_ms} ms")


def test_history_observations_match_the_python_back_end(standin):
    """AT-27: both back ends read the same history files and return identical values."""
    from fastapi.testclient import TestClient

    from barge.api import create_app
    from barge.runtime import Runtime

    hist, _ = _history_dir()
    d = hist / f"seed-{SEED}"
    manifest = json.loads((d / "manifest.json").read_text())
    files = {f["name"]: gzip.decompress((d / f"{f['name']}.gz").read_bytes()) for f in manifest["files"]}
    rt = Runtime(seed=SEED, pregen_days=manifest["days"], history={"manifest": manifest, "files": files})
    assert rt.history_source == "pre-built", "the Python back end refused the history (code hash or length)"
    while not rt.server.ready:
        rt.tick()
    py = TestClient(create_app(rt))
    js = httpx.Client(base_url=standin.base, timeout=60)
    for sensor in ("bow", "stern"):
        ds_py = next(x for x in py.get(f"/systems/{sensor}/datastreams").json()["items"] if x["outputName"] == "weather")
        ds_js = next(x for x in js.get(f"systems/{sensor}/datastreams").json()["items"] if x["outputName"] == "weather")
        assert ds_py["id"] == ds_js["id"]  # same schema, same identifier (FR-51)
        assert ds_py["phenomenonTime"] == ds_js["phenomenonTime"]
        for params in ({"phenomenonTime": "2031-04-09T11:58:00Z/2031-04-09T12:08:00Z"},
                       {"phenomenonTime": "2031-04-13T23:59:00Z/..", "limit": "500"},  # across a day file boundary
                       {"limit": "50", "offset": "86390"},
                       {"resultTime": "latest"}):
            a = py.get(f"/datastreams/{ds_py['id']}/observations", params=params)
            b = js.get(f"datastreams/{ds_js['id']}/observations", params=params)
            assert a.status_code == b.status_code == 200, (a.text, b.text)
            assert a.json() == b.json(), (sensor, params)
            assert a.headers["x-total-count"] == b.headers["x-total-count"]
            assert a.headers.get("link", "").split("?")[-1] == b.headers.get("link", "").split("?")[-1]


def test_waiting_mode_and_instance_identifiers(standin):
    """FR-47, FR-49: restart gives 503 with Retry-After and a new instance; down gives no answer."""
    c = httpx.Client(base_url=standin.base, timeout=30)
    before = c.get("").headers["x-server-instance"]
    state = standin.control("restart-server")
    assert state["backend"] == "standin" and state["server"] == "waiting"
    r = c.get("systems")
    assert r.status_code == 503 and int(r.headers["retry-after"]) > 0, r.text
    assert r.json()["code"] == "ServiceUnavailable"
    for _ in range(200):
        r = c.get("")
        if r.status_code == 200:
            break
        time.sleep(0.05)
    assert r.status_code == 200
    after = r.headers["x-server-instance"]
    assert after != before and r.headers["etag"].strip('"') == after
    standin.control("down")
    with pytest.raises(httpx.TransportError):
        c.get("")
    standin.control("up")
    for _ in range(200):
        r = c.get("")
        if r.status_code == 200:
            break
        time.sleep(0.05)
    assert r.status_code == 200 and r.headers["x-server-instance"] not in (before, after)

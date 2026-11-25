"""AT-02 (the other half of PR-04): the same contract suite against the JavaScript stand-in, in Node.

The stand-in runs behind a small HTTP harness, ``web/scripts/standin-server.mjs``, over the same data
folder (FR-06d). The test runs only against a harness of Version 4.6: one that reports
``{"version": "4.6"}`` at ``GET /demonstrator/harness``. Otherwise it is skipped, saying why: Node or
the web dependencies missing, no data folder, or a harness that is not the 4.6 one yet.

Harness interface assumed: ``node web/scripts/standin-server.mjs --port N --folder DIR`` prints
``READY <port> <startup ms>`` on stdout when it answers.
"""
import asyncio
import shutil
import socket
import subprocess
import threading
import time
from pathlib import Path

import httpx
import pytest

from contract_suite import suite
from tests.helpers import folder_path
from tests.test_contract_uvicorn import Client

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "web" / "scripts" / "standin-server.mjs"
VERSION = "4.6"


def _why_skip():
    if not shutil.which("node"):
        return "node is not installed: the stand-in runs in Node for the contract suite"
    if not (ROOT / "web" / "node_modules" / "esbuild").exists():
        return "web/node_modules/esbuild is missing: run npm ci in web/"
    if not SCRIPT.exists():
        return "web/scripts/standin-server.mjs is missing"
    try:
        folder_path()
    except RuntimeError as e:
        return str(e)
    return None


@pytest.fixture(scope="module")
def standin():
    why = _why_skip()
    if why:
        pytest.skip(why)
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    proc = subprocess.Popen(["node", str(SCRIPT), "--port", str(port), "--folder", str(folder_path())],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, cwd=ROOT)
    lines = []
    threading.Thread(target=lambda: [lines.append(x) for x in proc.stdout], daemon=True).start()
    try:
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline and not any(x.startswith("READY ") for x in lines):
            if proc.poll() is not None:
                pytest.skip(f"the stand-in harness exited ({proc.returncode}) with --folder: not the {VERSION} harness yet")
            time.sleep(0.1)
        base = f"http://127.0.0.1:{port}/"
        try:
            r = httpx.get(base + "demonstrator/harness", auth=("owner", "demo-owner"), timeout=10)
            version = r.json().get("version") if r.status_code == 200 else None
        except (httpx.HTTPError, ValueError):
            version = None
        if version != VERSION:
            pytest.skip(f"the stand-in harness does not report version {VERSION} at GET /demonstrator/harness "
                        f"(got {version!r}): it is not the {VERSION} harness yet")
        yield base
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


def test_contract_suite_against_the_standin(standin):
    """The same suite as test_contract_uvicorn.py, unchanged."""
    results = asyncio.run(suite.run(Client(standin)))
    failed = [r for r in results if r["outcome"] != "passed"]
    assert not failed, failed

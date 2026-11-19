"""AT-02 (CPython half): the contract suite against the app under uvicorn.

The browser half runs the same suite from the workspace worker through the
Service Worker; see web/e2e.
"""
import asyncio
import socket
import threading
import time

import httpx
import pytest
import uvicorn

from barge.edr import create_app
from contract_suite import suite


def _free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


@pytest.fixture(scope="module")
def server():
    port = _free_port()
    app = create_app(seed=3)
    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", lifespan="on")
    srv = uvicorn.Server(config)
    th = threading.Thread(target=srv.run, daemon=True)
    th.start()
    for _ in range(200):
        if srv.started:
            break
        time.sleep(0.05)
    yield f"http://127.0.0.1:{port}/"
    srv.should_exit = True
    th.join(timeout=5)


class HttpxClient:
    def __init__(self, base):
        self.base = base

    async def get(self, path, params=None):
        async with httpx.AsyncClient(base_url=self.base, timeout=60) as c:
            r = await c.get(path, params=params)
            return r.status_code, r.json()

    async def put(self, path, body):
        async with httpx.AsyncClient(base_url=self.base, timeout=60) as c:
            r = await c.put(path, json=body)
            return r.status_code, r.json()


def test_contract_suite_under_uvicorn(server):
    results = asyncio.run(suite.run(HttpxClient(server)))
    failed = [r for r in results if r["outcome"] == "failed"]
    assert not failed, failed
    assert sum(r["outcome"] == "passed" for r in results) >= len(results) - 1

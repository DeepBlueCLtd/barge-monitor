"""AT-02 (CPython half) and AT-12: the contract suite against the app under uvicorn."""
import asyncio
import socket
import threading
import time

import httpx
import pytest
import uvicorn

from barge.api import create_app
from barge.runtime import Runtime
from contract_suite import suite


@pytest.fixture(scope="module")
def server():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    rt = Runtime(seed=3, pregen_days=1, local_models=True)
    while not (rt.server.ready and rt.local.live):
        rt.tick()
    srv = uvicorn.Server(uvicorn.Config(create_app(rt), host="127.0.0.1", port=port, log_level="warning"))
    th = threading.Thread(target=srv.run, daemon=True)
    th.start()
    for _ in range(200):
        if srv.started:
            break
        time.sleep(0.05)
    yield f"http://127.0.0.1:{port}/"
    srv.should_exit = True
    th.join(timeout=5)


class Client:
    def __init__(self, base):
        self.base = base

    async def request(self, method, path, params=None, body=None, headers=None):
        async with httpx.AsyncClient(base_url=self.base, timeout=60) as c:
            r = await c.request(method, path, params=params, json=body, headers=headers)
            ctype = r.headers.get("content-type", "")
            data = r.json() if ("json" in ctype and r.content) else r.text
            return r.status_code, dict(r.headers), data


def test_contract_suite_under_uvicorn(server):
    results = asyncio.run(suite.run(Client(server)))
    failed = [r for r in results if r["outcome"] != "passed"]
    assert not failed, failed

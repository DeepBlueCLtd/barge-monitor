"""AT-02 (CPython half): the server-neutral contract suite (PR-04) against the app under uvicorn."""
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
def server(data_folder):
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    # Over the data folder: Mission A imported and processed, so that the models' outputs exist (D-285).
    rt = Runtime(seed=3, pregen_days=0.3, local_models=True, hold_s=0.5, folder=data_folder)
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


class Stream:
    def __init__(self, client, cm, resp):
        self._client, self._cm, self.resp = client, cm, resp
        self.status = resp.status_code
        self._lines = resp.aiter_lines() if self.status == 200 else None

    async def next_line(self, timeout=10):
        if self._lines is None:
            return None
        try:
            return await asyncio.wait_for(self._lines.__anext__(), timeout)
        except (StopAsyncIteration, asyncio.TimeoutError):
            return None

    async def close(self):
        await self._cm.__aexit__(None, None, None)
        await self._client.aclose()


class Client:
    """The suite's client over real HTTP; the internal endpoint is /api-internal beside the API."""

    def __init__(self, base):
        self.base = base

    async def request(self, method, path, params=None, body=None, headers=None):
        async with httpx.AsyncClient(base_url=self.base, timeout=60) as c:
            r = await c.request(method, path, params=params, json=body, headers=headers)
            return r.status_code, dict(r.headers), suite.read_body(r.content)

    async def open_stream(self, path, params=None, headers=None, internal=False):
        c = httpx.AsyncClient(base_url=self.base + ("api-internal/" if internal else ""), timeout=60)
        cm = c.stream("GET", path, params=params, headers=headers)
        resp = await cm.__aenter__()
        return Stream(c, cm, resp)


def test_contract_suite_under_uvicorn(server):
    results = asyncio.run(suite.run(Client(server)))
    failed = [r for r in results if r["outcome"] != "passed"]
    assert not failed, failed

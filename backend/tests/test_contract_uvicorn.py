"""AT-02 (CPython half): the contract suite against the application under uvicorn, with the core
models running in-process, as an ordinary ASGI deployment (NFR-03)."""
import asyncio
import socket
import threading
import time

import httpx
import pytest
import uvicorn

from barge.serve import build
from contract_suite import suite
from tests.helpers import folder_path


@pytest.fixture(scope="module")
def server():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    served = build(folder_path(), hold_s=0.2)
    srv = uvicorn.Server(uvicorn.Config(served, host="127.0.0.1", port=port, log_level="warning", lifespan="on"))
    th = threading.Thread(target=srv.run, daemon=True)
    th.start()
    for _ in range(400):
        if srv.started and served.rt.running and served.rt.replay.models_ready:
            break
        time.sleep(0.05)
    assert served.rt.running, "the server did not start"
    yield f"http://127.0.0.1:{port}/"
    srv.should_exit = True
    th.join(timeout=5)


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
        async with httpx.AsyncClient(base_url=self.base, timeout=60) as c:
            r = await c.request(method, path, params=params, json=body, headers=headers)
            ctype = r.headers.get("content-type", "")
            data = r.json() if ("json" in ctype and r.content) else r.text
            return r.status_code, dict(r.headers), data

    async def open_stream(self, path, params=None, headers=None):
        c = httpx.AsyncClient(base_url=self.base, timeout=httpx.Timeout(60, read=None))
        cm = c.stream("GET", path, params=params, headers=headers)
        resp = await cm.__aenter__()
        return Stream(c, cm, resp)


def test_contract_suite_under_uvicorn(server):
    results = asyncio.run(suite.run(Client(server)))
    failed = [r for r in results if r["outcome"] != "passed"]
    assert not failed, failed
    assert len(results) == len(suite.NEED) + len(suite.STANDIN)

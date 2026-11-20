import asyncio

import httpx

from barge.api import create_app
from barge.clock import ManualClock
from barge.runtime import Runtime


class Rig:
    """The application over a runtime with a hand-set clock, called in-process."""

    def __init__(self, seed=5, days=2.0, capture=True):
        self.clock = ManualClock(days * 86400.0)
        self.rt = Runtime(seed=seed, clock=self.clock, pregen_days=days, capture=capture)
        self.app = create_app(self.rt)
        self.ready()

    def ready(self):
        while self.rt.server and not self.rt.server.ready:
            self.rt.tick()

    def advance(self, seconds):
        self.clock.play()
        self.clock.advance(seconds)
        self.rt.tick()
        self.rt.server and self.rt.server.adapter.refresh()

    def request(self, method, path, params=None, json=None, headers=None):
        async def go():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://t") as c:
                return await c.request(method, path, params=params, json=json, headers=headers)
        return asyncio.run(go())

    def get(self, path, params=None):
        r = self.request("GET", path, params)
        return r.status_code, (r.json() if r.content else None), r

    def ds(self, system, output):
        _, body, _ = self.get(f"/systems/{system}/datastreams")
        return next(d for d in body["items"] if d["outputName"] == output)

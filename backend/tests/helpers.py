import asyncio
import json

import httpx

from barge.clock import ManualClock
from barge.edr import create_app


class Rig:
    """The app with a hand-set clock, called in-process through ASGI."""

    def __init__(self, seed=5, start_hours=0.0):
        self.clock = ManualClock(start_hours * 3600.0)
        self.app = create_app(seed=seed, clock=self.clock, warm_start=0)
        self.sim = self.app.sim

    def get(self, path, params=None):
        async def go():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://t") as c:
                return await c.get(path, params=params)
        r = asyncio.run(go())
        return r.status_code, r.json(), r

    def route(self):
        cl = self.app.canal["centreline"]
        return "LINESTRING(" + ",".join(f"{x} {y}" for x, y in zip(cl["lon"], cl["lat"])) + ")"

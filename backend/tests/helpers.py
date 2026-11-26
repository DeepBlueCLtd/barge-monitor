import asyncio

import httpx

from barge.accounts import basic, password_of
from barge.api import create_app
from barge.clock import ManualClock
from barge.runtime import Runtime

HOLD_S = 0.01  # the server's hold on a command's answer, shortened for the tests (§9.1: 5 s)


class Rig:
    """The application over a runtime with a hand-set clock, called in-process."""

    def __init__(self, seed=5, days=2.0, capture=True, user="owner", **store):
        self.clock = ManualClock(days * 86400.0)
        self.user = user
        self.rt = Runtime(seed=seed, clock=self.clock, pregen_days=days, capture=capture, local_models=True,
                          hold_s=HOLD_S, **store)
        self.app = create_app(self.rt)
        self.ready()

    def ready(self):
        for _ in range(10000):
            if self.rt.server and self.rt.server.ready and self.rt.local.live:
                return
            self.rt.tick()
        raise AssertionError("the server and models never became ready")

    def advance(self, seconds):
        self.clock.play()
        self.clock.advance(seconds)
        self.rt.server and self.rt.server.adapter.refresh()
        self.rt.tick()

    def auth(self, user=None) -> dict:
        user = user or self.user
        return {"Authorization": basic(user, password_of(user))}

    def request(self, method, path, params=None, json=None, headers=None, user=None):
        """A request as ``user`` (the owner unless said otherwise); ``user=False`` sends no credentials."""
        if user is not False:
            headers = {**self.auth(user or None), **(headers or {})}

        async def go():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://t") as c:
                return await c.request(method, path, params=params, json=json, headers=headers)
        return asyncio.run(go())

    def get(self, path, params=None, user=None):
        r = self.request("GET", path, params, user=user)
        try:
            body = r.json() if r.content else None
        except ValueError:
            body = r.text
        return r.status_code, body, r

    def systems(self, user=None) -> dict:
        """uniqueId -> id, by discovery (D-193)."""
        _, body, _ = self.get("/systems", {"searchMembers": "true", "f": "application/sml+json", "limit": "1000"}, user=user)
        return {s["uniqueId"]: s["id"] for s in body["items"]}

    def sid(self, name: str) -> str:
        """A system's id from the last part of its uniqueId (``bow``, ``summaries``, ``models``)."""
        sy = self.systems()
        return next(i for u, i in sy.items() if u.rsplit(":", 1)[-1] == name)

    def ds(self, system, output):
        _, body, _ = self.get(f"/systems/{self.sid(system)}/datastreams")
        return next(d for d in body["items"] if d["outputName"] == output)

    def obs(self, ds_id, params=None, user=None):
        return self.get(f"/datastreams/{ds_id}/observations", {"f": "application/swe+json", **(params or {})}, user=user)[1]

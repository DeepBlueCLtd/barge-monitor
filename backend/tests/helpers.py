import asyncio

import httpx

from barge.accounts import basic, password_of
from barge.api import create_app
from barge.runtime import Runtime

HOLD_S = 0.01  # the server's hold on a command's answer, shortened for the tests (§9.1: 5 s)


class Rig:
    """The application over a runtime, called in-process. ``folder``: a data folder for the CSV importer (none:
    an empty one); ``models=False`` runs no in-process models. There is no clock to set: the 4.1 simulation clock
    is retired (D-320). Mission A is imported silently at startup, as the page does with ``?mission-a`` (D-366)."""

    def __init__(self, capture=True, user="owner", models=True, **kw):
        kw.setdefault("silent_import", True)
        self.user = user
        self.rt = Runtime(capture=capture, local_models=models, hold_s=HOLD_S, **kw)
        self.app = create_app(self.rt)
        self.ready()

    def ready(self):
        """The server answers, the importer holds its subscription and every in-process model is live."""
        rt = self.rt
        for _ in range(10000):
            if rt.server and rt.server.ready and rt.importer.subscribed and (rt.local is None or rt.local.live):
                return
            rt.tick()
        raise AssertionError("the server, the importer and the models never became ready")

    def step(self, n=1):
        """Let the back end's loop run (pushed commands, imports)."""
        for _ in range(n):
            self.rt.tick()

    def command(self, uid, input_name, params, user=None):
        """Send a command (its answer is held only HOLD_S here); returns the response."""
        sid = self.systems()[uid]
        _, body, _ = self.get(f"/systems/{sid}/controlstreams")
        cs = next(c for c in body["items"] if c["inputName"] == input_name)
        return self.request("POST", f"/controlstreams/{cs['id']}/commands", json={"parameters": params}, user=user)

    def reports(self, cmd_id):
        return self.get(f"/commands/{cmd_id}/status")[1]["items"]

    def wait(self, cmd_id, steps=200):
        """Tick until the command's outcome is final; its status reports other than PENDING, oldest first."""
        st = []
        for _ in range(steps):
            st = [x for x in self.reports(cmd_id) if x["statusCode"] != "PENDING"]
            if st and st[-1]["statusCode"] in ("COMPLETED", "FAILED", "REJECTED"):
                return st
            self.step()
        raise AssertionError(f"command {cmd_id} never finished: {st}")

    def dataset(self, file_prefix):
        """The id of the current (not superseded) dataset imported from a file whose name starts so."""
        return next(d["id"] for d in reversed(list(self.rt.importer.datasets.values()))
                    if d["file"].startswith(file_prefix) and not d["superseded"])

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

"""A test rig: the back end in-process, on its own event loop, with a hand-set host clock.

``Rig`` starts the server over a data folder (the built one by default), runs the core models
in-process (the same HTTP requests of the same application as in the browser), and lets a test
advance real time second by second: the replay clock, the replay state and every model step
follow, as the worker's timers would make them.
"""
from __future__ import annotations

import asyncio
import json
import shutil
from pathlib import Path

import numpy as np

from barge import accounts as A
from barge import asgi
from barge.api import create_app
from barge.clock import ManualClock
from barge.folder import DirFolder
from barge.runtime import Runtime
from barge.times import parse_iso

ROOT = Path(__file__).resolve().parents[2]
FOLDER = ROOT / "web" / "public" / "data" / "folder"
CACHE = ROOT / ".cache" / "data"
USERS = {"owner": "demo-owner", "friend": "demo-friend", "analyst": "demo-analyst"}


def folder_path() -> Path:
    for p in (FOLDER, CACHE):
        if (p / "index.json").exists():
            return p
    raise RuntimeError("build the data folder first: python scripts/build_data_folder.py")


def copy_folder(dst: Path, files=None) -> Path:
    """A private copy of the data folder (tests that copy files in or change them)."""
    src = folder_path()
    dst.mkdir(parents=True, exist_ok=True)
    for p in src.iterdir():
        if files is None or p.name in files or p.name.startswith(("index", "manifest")):
            shutil.copy2(p, dst / p.name)
    return dst


class Response:
    def __init__(self, status, headers, body):
        self.status = status
        self.headers = {k.lower(): v for k, v in headers}
        self.body = body

    @property
    def json(self):
        return json.loads(self.body)


class Rig:
    all: list = []

    def __init__(self, folder=None, models=True, capture=True, parser=None, silent_import=True, classes=None):
        Rig.all.append(self)
        self.loop = asyncio.new_event_loop()
        self.clock = ManualClock()
        self.rt = Runtime(DirFolder(folder or folder_path()), real=self.clock, hold_s=0.0, start_s=0.0, capture=capture,
                          parser=parser, silent_import=silent_import)
        self.run(self.rt.start())
        self.app = create_app(self.rt)
        self.local = None
        if models:
            from barge.local_models import CORE, LocalModels

            self.local = self.run(self._local(LocalModels, classes or CORE))
            for rn in self.local.runners:
                rn.api.retry_s = 0.01  # the hand-set clock does not pace asyncio's sleeps
            self.settle()

    async def _local(self, cls, classes):
        return cls(self.rt, classes)

    def run(self, coro):
        return self.loop.run_until_complete(coro)

    def spin(self, n: int = 20) -> None:
        """Let pushed commands and their status reports through."""
        self.run(asyncio.sleep(0.001 * n))

    def step(self, real: float = 1.0) -> None:
        """One real second: the replay clock, the state, every model."""
        self.clock.advance(real)
        self.rt.tick()
        if self.local:
            self.run(self.local.step())
        self.spin(5)

    def settle(self, steps: int = 4) -> None:
        for _ in range(steps):
            self.step(1.0)
        for _ in range(30):
            if self.rt.replay.models_ready or not self.rt.replay.dataset:
                return
            self.step(1.0)

    def control(self, action, arg=None):
        async def go():
            return self.rt.control(action, arg)
        out = self.run(go())
        self.spin(5)
        return out

    def restart(self, steps: int = 3):
        """Restart the server and let it start; the models resubscribe."""
        self.control("restart-server")
        for _ in range(steps):
            self.step(1.0)

    def close(self):
        if self.loop.is_closed():
            return
        if self.local:
            self.local.close()
        self.rt.stop()
        self.spin(5)
        tasks = [t for t in asyncio.all_tasks(self.loop) if not t.done()]
        for t in tasks:
            t.cancel()
        async def drain():
            await asyncio.gather(*tasks, return_exceptions=True)
        self.loop.run_until_complete(drain())
        self.loop.close()

    # --- HTTP, as the display client sends it ---------------------------------------------------
    def request(self, method, path, params=None, body=None, user="owner", password=None, headers=None, ctype=None):
        return self.run(self.app_request(method, path, params, body, user, password, headers, ctype))

    async def app_request(self, method, path, params=None, body=None, user="owner", password=None, headers=None,
                          ctype=None):
        q = "&".join(f"{k}={v}" for k, v in (params or {}).items())
        hs = list((headers or {}).items())
        if user is not None:
            hs.append(("authorization", A.basic(user, password if password is not None else
                                                 USERS.get(user, A.SERVICE_PASSWORD))))
        raw = None
        if body is not None:
            raw = body if isinstance(body, bytes) else json.dumps(body).encode()
            hs.append(("content-type", ctype or "application/json"))
        r = await asgi.call(self.app, method, path, q, raw, "", hs, "http://t")
        return None if r is None else Response(*r)

    def get(self, path, params=None, **kw):
        return self.request("GET", path, params, **kw)

    def obs(self, ds_id, params=None, user="owner"):
        p = {"f": "application%2Fswe%2Bjson", "limit": "1000000", **(params or {})}
        r = self.get(f"/datastreams/{ds_id}/observations", p, user=user)
        assert r.status == 200, (r.status, r.body[:300])
        return r.json

    # --- finding things as a client does: by uniqueId and outputName ------------------------------
    def systems(self, user="owner"):
        r = self.get("/collections/all_systems/items", {"f": "application%2Fsml%2Bjson", "limit": "100000"}, user=user)
        return {s["uniqueId"]: s for s in r.json["items"]}

    def ds(self, uid, output, user="owner"):
        s = self.systems(user).get(uid)
        if s is None:
            return None
        r = self.get(f"/systems/{s['id']}/datastreams", {"limit": "100000"}, user=user)
        return next((d for d in r.json["items"] if d["outputName"] == output), None)

    def cs(self, uid, name, user="owner"):
        s = self.systems(user).get(uid)
        r = self.get(f"/systems/{s['id']}/controlstreams", user=user)
        return next((c for c in r.json["items"] if c["inputName"] == name), None)

    def command(self, uid, name, params, user="owner"):
        """Send a command (it is pushed at once; with hold_s 0 the POST answers at once too)."""
        c = self.cs(uid, name, user)
        r = self.request("POST", f"/controlstreams/{c['id']}/commands", body={"parameters": params}, user=user)
        self.spin(30)
        return r

    def status_of(self, uid, name, cmd_id, user="owner"):
        c = self.cs(uid, name, user)
        reps = self.get(f"/controlstreams/{c['id']}/status", user=user).json["items"]
        return [x for x in reps if x["command@id"] == cmd_id]

    def state(self):
        return self.rt.replay.state()

    def replay(self, action, dataset=None, rate=None, position=None, user="owner"):
        st = self.state() or {}
        params = {"action": action, "dataset": dataset if dataset is not None else st.get("dataset", ""),
                  "rate": rate if rate is not None else st.get("rate", 1), "position": position or st.get("position", "")}
        r = self.command("urn:x-barge:replay", "replay", params, user=user)
        assert r.status == 200, (r.status, r.body)
        return r.json["id"]

    def play_until(self, t_iso: str, rate: float = 100.0, max_steps: int = 5000):
        """Play at ``rate`` until the replay time reaches ``t_iso``, then pause; models catch up."""
        self.replay("play", rate=rate)
        target = parse_iso(t_iso)
        for _ in range(max_steps):
            if self.rt.replay.time >= target or not self.rt.replay.playing:
                break
            self.step(min(1.0, max(0.01, (target - self.rt.replay.time) / rate)))
        self.replay("pause")
        for _ in range(60):
            self.step(1.0)
            if all(r.phase == "live" and "waiting" not in r.detail for r in (self.local.runners if self.local else [])):
                pass
        return self.rt.replay.time

    def dataset(self, prefix: str) -> str:
        return next(d["id"] for d in self.rt.importer.datasets.values() if d["file"].startswith(prefix)
                    and not d["superseded"])


def column(rows, name):
    return np.array([np.nan if r.get(name) in (None, "NaN") else r[name] for r in rows], dtype=float)

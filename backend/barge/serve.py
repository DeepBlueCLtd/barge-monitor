"""The CPython deployment: the same application under an ordinary ASGI server (NFR-03, AT-02, AT-05).

``build(folder)`` returns an ASGI application that, on startup, starts the server stand-in over the
data folder (with the silent import of Mission A), ticks it ten times a real second, and runs the
core models in-process once a real second. Run it with, for example::

    uvicorn --factory barge.serve:app --port 8000      # BARGE_FOLDER names the data folder
"""
from __future__ import annotations

import asyncio
import os

from .api import create_app
from .folder import DirFolder
from .runtime import Runtime


class Served:
    def __init__(self, folder, local_models: bool = True, **runtime):
        self.rt = Runtime(DirFolder(folder), **runtime)
        self.app = create_app(self.rt)
        self.local_models = local_models
        self.local = None
        self._tasks = []
        self.started = asyncio.Event()

    def openapi(self) -> dict:
        return self.app.openapi()

    async def startup(self) -> None:
        await self.rt.start()
        self._tasks.append(asyncio.ensure_future(self._tick()))
        if self.local_models:
            from .local_models import LocalModels

            self.local = LocalModels(self.rt)
            self._tasks.append(asyncio.ensure_future(self.local.run(1.0)))
        self.started.set()

    async def _tick(self) -> None:
        while True:
            try:
                self.rt.tick()
                self.rt.tap.drain()  # nobody draws them here
            except Exception as e:  # noqa: BLE001 - the host keeps ticking
                print(f"tick: {type(e).__name__}: {e}")
            await asyncio.sleep(0.1)

    async def shutdown(self) -> None:
        if self.local:
            self.local.close()
        for t in self._tasks:
            t.cancel()

    async def __call__(self, scope, receive, send):
        if scope["type"] == "lifespan":
            while True:
                m = await receive()
                if m["type"] == "lifespan.startup":
                    await self.startup()
                    await send({"type": "lifespan.startup.complete"})
                elif m["type"] == "lifespan.shutdown":
                    await self.shutdown()
                    await send({"type": "lifespan.shutdown.complete"})
                    return
        return await self.app(scope, receive, send)


def build(folder=None, **kw) -> Served:
    return Served(folder or os.environ.get("BARGE_FOLDER", "web/public/data/folder"), **kw)


def app() -> Served:
    return build()

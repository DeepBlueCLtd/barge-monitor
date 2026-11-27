"""The core models run in-process, for CPython (tests and an ordinary ASGI server).

In the browser each model has its own worker (FR-33) and reaches the data server with ``fetch``
through the relay; here they share the process but make exactly the same HTTP requests of the same
ASGI application, with the same service credentials (``models/csmodel.py``), so the tests exercise
the same code paths. A model's push subscription (§9.2) is a streamed answer of the application,
held on the internal endpoint.

The models run in an event loop of their own, kept between ticks, so that a subscription stays
open: each tick runs one step of each model (§10.2: a few windows of the run in hand), then lets
pushed commands through.
"""
from __future__ import annotations

import asyncio
import atexit
import sys
from pathlib import Path

_MODELS = Path(__file__).resolve().parent.parent / "models"
if str(_MODELS) not in sys.path:
    sys.path.insert(0, str(_MODELS))

import csmodel  # noqa: E402
import data_cleanse  # noqa: E402
import summaries  # noqa: E402
import analysis  # noqa: E402

from . import asgi  # noqa: E402
from .accounts import password_of  # noqa: E402
from .api import INTERNAL  # noqa: E402

CORE = (data_cleanse.DataCleanse, summaries.Summaries, analysis.Analysis)
SETTLE = 400  # loop iterations a tick may take to finish the models' work in hand (in-process: no real waiting)


class LocalModels:
    def __init__(self, runtime, classes=CORE, loop=None):
        from .api import create_app

        self.rt = runtime
        self.app = create_app(runtime)
        self.loop = loop or asyncio.new_event_loop()  # the runtime's own, which the importer shares
        atexit.register(self.close)
        self.runners = []
        for cls in classes:
            self.add(cls())

    async def _transport(self, method, path, headers, body):
        if not self.rt.running:
            raise csmodel.Unavailable("the data server does not answer")
        path, _, query = path.partition("?")
        r = await asgi.call(self.app, method, path, query, body, "", list(headers.items()), "http://models")
        if r is None:
            raise csmodel.Unavailable("the data server does not answer")
        status, rh, payload = r
        return status, {k.lower(): v for k, v in rh}, payload

    async def _stream(self, path, headers, internal=False):
        """A streamed answer, in-process: (status, async iterator of chunks)."""
        if not self.rt.running:
            raise csmodel.Unavailable("the data server does not answer")
        path, _, query = path.partition("?")
        q: asyncio.Queue = asyncio.Queue()
        started: asyncio.Future = asyncio.get_running_loop().create_future()

        def on_stream(kind, *a):
            if kind == "start" and not started.done():
                started.set_result(a[0])
            elif kind == "chunk":
                q.put_nowait(a[0])
            elif kind == "end":
                q.put_nowait(None)

        task = asyncio.ensure_future(asgi.call(self.app, "GET", (INTERNAL if internal else "") + path, query, None, "",
                                               list(headers.items()), "http://models", on_stream=on_stream))

        def done(t):
            if not started.done():
                r = None if t.cancelled() or t.exception() else t.result()
                started.set_result(r[0] if isinstance(r, tuple) else None)
            q.put_nowait(None)
        task.add_done_callback(done)
        status = await started
        if status is None:
            raise csmodel.Unavailable("the data server does not answer")

        async def chunks():
            try:
                while True:
                    c = await q.get()
                    if c is None:
                        return
                    yield c
            finally:
                task.cancel()
        return status, chunks()

    def add(self, model) -> csmodel.Runner:
        user = f"svc-{model.id}"
        api = csmodel.Api(model.id, self._transport, user, password_of(user), stream=self._stream, real=self.rt.real)
        api.retry_s = 0.0  # in-process, the server answers as soon as it is up: resubscribe at the next tick
        api.tap = lambda dst, summary, content=None, m=model.id, a=api: self.rt.tap.emit(
            *(("models", "scilibs") if dst == "scilibs" else ("scilibs", "models")), "I", f"{m}: {summary}", content,
            model=m, quiet=a.quiet)
        r = csmodel.Runner(model, api)
        r.scan_s = 0.0  # in-process: read the catalogue at every step
        self.runners.append(r)
        return r

    async def _tick(self, r) -> None:
        await r.step()

    def settle(self) -> None:
        """Let pushed commands and their status reports go through: run the loop until nothing is waiting."""
        for _ in range(SETTLE):
            self.loop.run_until_complete(asyncio.sleep(0))
            if not any(r.handling for r in self.runners) and not self.loop._ready:  # noqa: SLF001
                break

    def tick(self) -> None:
        for r in self.runners:
            try:
                self.loop.run_until_complete(self._tick(r))
            except Exception as e:  # noqa: BLE001 - a broken model never stops the others (FR-33)
                r.phase, r.detail = "failed", f"{type(e).__name__}: {e}"
            self.rt.set_phase(r.model.id, r.phase, r.detail, r.model.label)
        self.settle()

    def close(self) -> None:
        """End the models' subscriptions and close their loop (at exit: no task is left pending)."""
        if self.loop.is_closed():
            return
        tasks = asyncio.all_tasks(self.loop)
        for t in tasks:
            t.cancel()
        if tasks:
            self.loop.run_until_complete(asyncio.gather(*tasks, return_exceptions=True))
        self.loop.close()

    @property
    def live(self) -> bool:
        return all(r.phase == "live" for r in self.runners)

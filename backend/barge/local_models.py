"""The core models run in-process, for CPython (tests and an ordinary ASGI server).

In the browser each model has its own worker (FR-33) and reaches the data server with ``fetch``
through the relay; here they share the process but make exactly the same HTTP requests of the
same ASGI application (the access gateway in front of the server), with their own service
credentials, and hold their push subscriptions as streamed answers (``models/csmodel.py``).
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

_MODELS = Path(__file__).resolve().parent.parent / "models"
if str(_MODELS) not in sys.path:
    sys.path.insert(0, str(_MODELS))

import analysis  # noqa: E402
import csmodel  # noqa: E402
import data_cleanse  # noqa: E402
import summaries  # noqa: E402

from . import accounts as A  # noqa: E402
from . import asgi  # noqa: E402

CORE = (data_cleanse.DataCleanse, summaries.Summaries, analysis.Analysis)
ORIGIN = "http://models"


def transport_for(app):
    async def transport(method, path, headers, body):
        path, _, query = path.partition("?")
        r = await asgi.call(app, method, path, query, body, "", list(headers.items()), ORIGIN)
        if r is None:
            raise csmodel.Unavailable("the data server does not answer")
        status, rh, payload = r
        return status, {k.lower(): v for k, v in rh}, payload

    async def stream(path, headers):
        path, _, query = path.partition("?")
        q: asyncio.Queue = asyncio.Queue()
        started = asyncio.get_event_loop().create_future()

        def on(kind, *a):
            if kind == "start" and not started.done():
                started.set_result(a[0])
            elif kind == "chunk":
                q.put_nowait(a[0])
            elif kind == "end":
                q.put_nowait(None)

        task = asyncio.ensure_future(asgi.call(app, "GET", path, query, None, "", list(headers.items()), ORIGIN,
                                               on_stream=on))
        await asyncio.wait({started, task}, return_when=asyncio.FIRST_COMPLETED)
        if not started.done():
            r = task.result()
            if r is None:
                raise csmodel.Unavailable("the data server does not answer")
            return r[0], _empty()

        async def chunks():
            try:
                while True:
                    c = await q.get()
                    if c is None:
                        return
                    yield c
            finally:
                if not task.done():
                    task.cancel()
        return started.result(), chunks()

    return transport, stream


async def _empty():
    return
    yield  # noqa: unreachable - an empty async generator


class LocalModels:
    def __init__(self, runtime, classes=CORE):
        from .api import create_app

        self.rt = runtime
        self.app = create_app(runtime)
        self.transport, self.stream = transport_for(self.app)
        self.runners: list[csmodel.Runner] = []
        for cls in classes:
            self.add(cls())

    def add(self, model, user: str | None = None) -> csmodel.Runner:
        user = user or f"svc-{model.id}"
        api = csmodel.Api(model.id, self.transport, user, A.SERVICE_PASSWORD, stream=self.stream)
        api.role_of = self.rt.accounts.role_of  # the same delivered assignment the gateway reads (D-152)
        api.tap = lambda dst, summary, content=None, m=model.id, a=api: self.rt.tap.emit(
            *(("models", "scilibs") if dst == "scilibs" else ("scilibs", "models")), "I", f"{m}: {summary}", content,
            model=m, quiet=a.quiet)
        r = csmodel.Runner(model, api)
        self.runners.append(r)
        return r

    async def step(self) -> None:
        """One step of each model (once per real second in a deployment)."""
        for r in self.runners:
            try:
                await r.step()
            except Exception as e:  # noqa: BLE001 - a broken model never stops the others (FR-33, AT-14)
                r.phase, r.detail = "failed", f"{type(e).__name__}: {e}"
            self.rt.set_phase(r.model.id, r.phase, r.detail, r.model.label)

    async def run(self, every: float = 1.0) -> None:
        while True:
            await self.step()
            await asyncio.sleep(every)

    def close(self) -> None:
        for r in self.runners:
            if r.sub_task is not None:
                r.sub_task.cancel()

"""The core models run in-process, for CPython (tests and an ordinary ASGI server).

In the browser each model has its own worker (FR-33) and reaches the data
server with ``fetch``; here they share the process but make exactly the same
HTTP requests of the same ASGI application (``models/csmodel.py``), so the
tests exercise the same code paths.
"""
from __future__ import annotations

import asyncio
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

CORE = (data_cleanse.DataCleanse, summaries.Summaries, analysis.Analysis)


class LocalModels:
    def __init__(self, runtime, classes=CORE):
        from .api import create_app

        self.rt = runtime
        self.app = create_app(runtime)
        self.runners = []
        for cls in classes:
            self.add(cls())

    async def _transport(self, method, path, headers, body):
        if self.rt.down:
            raise csmodel.Unavailable("the data server does not answer")
        path, _, query = path.partition("?")
        status, rh, payload = await asgi.call(self.app, method, path, query, body, "", list(headers.items()), "http://models")
        return status, {k.lower(): v for k, v in rh}, payload

    def add(self, model) -> csmodel.Runner:
        api = csmodel.Api(model.id, self._transport, now=self.rt.now)
        api.tap = lambda dst, summary, content=None, m=model.id, a=api: self.rt.tap.emit(
            *(("models", "scilibs") if dst == "scilibs" else ("scilibs", "models")), "I", f"{m}: {summary}", content,
            model=m, quiet=a.quiet)
        r = csmodel.Runner(model, api)
        self.runners.append(r)
        return r

    def tick(self) -> None:
        waiting = self.rt.pending_commands() if not self.rt.clock.playing else {}
        for r in self.runners:
            try:
                asyncio.run(r.tick(self.rt.clock.playing, wake=bool(waiting.get(getattr(r.model, "system", None)))))
            except Exception as e:  # noqa: BLE001 - a broken model never stops the others (FR-33)
                r.phase, r.detail = "failed", f"{type(e).__name__}: {e}"
            self.rt.set_phase(r.model.id, r.phase, r.detail, r.model.label)

    @property
    def live(self) -> bool:
        return all(r.phase == "live" for r in self.runners)

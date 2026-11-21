"""The core models run in-process, for CPython (tests and an ordinary ASGI server).

In the browser each model has its own worker (FR-33); here they share the
process but call the data server through exactly the same interface
(``models/csmodel.py``), so the tests exercise the same code paths.
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
import model_a  # noqa: E402
import model_b  # noqa: E402

CORE = (data_cleanse.DataCleanse, model_a.ModelA, model_b.ModelB)


class LocalModels:
    def __init__(self, runtime, classes=CORE):
        self.rt = runtime
        self.runners = []
        for cls in classes:
            self.add(cls())

    def add(self, model) -> csmodel.Runner:
        api = csmodel.LocalApi(model.id, self.rt.host, self.rt)
        r = csmodel.Runner(model, api)
        self.rt.host.listeners[model.id] = r.notify
        self.runners.append(r)
        return r

    def tick(self) -> None:
        for r in self.runners:
            try:
                asyncio.run(r.tick(self.rt.clock.playing))
            except Exception as e:  # noqa: BLE001 - a broken model never stops the others (FR-33)
                r.phase, r.detail = "failed", f"{type(e).__name__}: {e}"
            self.rt.host.set_phase(r.model.id, r.phase, r.detail, r.model.label)

    @property
    def live(self) -> bool:
        return all(r.phase == "live" for r in self.runners)

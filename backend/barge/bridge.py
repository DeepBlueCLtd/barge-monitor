"""The back-end worker's entry points: the seam's last step, and the models' port.

The relay hands each request to the backend worker over a MessagePort; the
worker calls ``handle`` here, which builds an ordinary ASGI scope and awaits
the FastAPI application exactly as uvicorn would. While the server is down
the bridge answers nothing, so the relay can report a network failure
(FR-49). No routing or application logic lives here.

Model workers reach the data server the same way, through the relay: there
is no other interface. Each model only tells the shell its phase.
"""
from __future__ import annotations

import json

from . import asgi
from .api import create_app
from .runtime import Runtime


class Bridge:
    def __init__(self, seed: int, progress=None, pregen_days: float | None = None, history: dict | None = None):
        kw = {} if pregen_days is None else {"pregen_days": pregen_days}
        self.rt = Runtime(seed=seed, progress=progress, history=history, **kw)
        self.app = create_app(self.rt)

    def set_model_phase(self, model: str, phase: str, detail: str, label: str) -> None:
        self.rt.set_phase(model, phase, detail, label)

    def tick(self) -> str:
        """Advance the system; return captured messages and state as JSON for the page."""
        self.rt.tick()
        return json.dumps({"messages": self.rt.tap.drain(), "clock": self.rt.clock.state(),
                           "server": "down" if self.rt.down else ("waiting" if not self.rt.server.ready else "running"),
                           "pending_commands": self.rt.pending_commands()},
                          default=str)

    def control(self, action: str, arg=None) -> str:
        rt = self.rt
        if action == "play":
            rt.play()
        elif action == "pause":
            rt.pause()
        elif action == "rate":
            rt.set_rate(float(arg))
        elif action == "restart-server":
            rt.restart_server()
        elif action == "down":
            rt.take_down()
        elif action == "up":
            rt.bring_up()
        elif action == "field":
            rt.set_field(arg["name"], arg["on"])
        elif action == "profile-lie":
            rt.set_profile_lie(arg)
        elif action == "capture":
            rt.tap.enabled = bool(arg)
        elif action != "state":
            raise ValueError(action)
        return json.dumps(rt.control_state(), default=str)

    def emit(self, src, dst, letter, summary, content="", failed=False):
        """Messages seen by the page or the relay are captured through the same tap."""
        self.rt.tap.emit(src, dst, letter, summary, content, failed)

    async def handle(self, method, path, query, body, root_path, headers=None, origin="https://localhost"):
        if self.rt.down:
            return None  # no answer at all: the relay reports a network failure
        return await asgi.call(self.app, method, path, query, body, root_path, headers, origin)

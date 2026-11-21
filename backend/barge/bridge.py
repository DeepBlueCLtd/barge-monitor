"""The back-end worker's entry points: the seam's last step, and the models' port.

The relay hands each request to the backend worker over a MessagePort; the
worker calls ``handle`` here, which builds an ordinary ASGI scope and awaits
the FastAPI application exactly as uvicorn would. While the server is down
the bridge answers nothing, so the relay can report a network failure
(FR-49). No routing or application logic lives here.

Each model worker's calls arrive at ``model_call`` and go to the data
server's internal interface (modelhost.py); the server reaches a model
through ``notify``, which the worker forwards over the model's port.
"""
from __future__ import annotations

import json

from .api import create_app
from .runtime import Runtime


class Bridge:
    def __init__(self, seed: int, progress=None, pregen_days: float | None = None, history: dict | None = None):
        kw = {} if pregen_days is None else {"pregen_days": pregen_days}
        self.rt = Runtime(seed=seed, progress=progress, history=history, **kw)
        self.app = create_app(self.rt)

    def model_call(self, model: str, op: str, args, quiet: bool = False):
        """A call from a model worker. Columns arrive and leave packed (models/csmodel.py)."""
        from .local_models import csmodel

        pack, unpack = csmodel.pack, csmodel.unpack

        return pack(self.rt.host.call(model, op, unpack(args), quiet=bool(quiet)))

    def set_listener(self, model: str, fn) -> None:
        self.rt.host.listeners[model] = lambda message: fn(json.dumps(message, default=str))

    def set_model_phase(self, model: str, phase: str, detail: str, label: str) -> None:
        self.rt.host.set_phase(model, phase, detail, label)

    def tick(self) -> str:
        """Advance the system; return captured messages and state as JSON for the page."""
        self.rt.tick()
        return json.dumps({"messages": self.rt.tap.drain(), "clock": self.rt.clock.state(),
                           "server": "down" if self.rt.down else ("waiting" if not self.rt.server.ready else "running")},
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
        scope = {
            "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": method.upper(),
            "scheme": origin.split(":")[0], "path": root_path + path, "raw_path": (root_path + path).encode(),
            "root_path": root_path, "query_string": (query or "").encode("latin-1"),
            "headers": [(k.lower().encode(), v.encode()) for k, v in (headers or []) if k.lower() != "host"]
                       + [(b"host", origin.split("://", 1)[-1].encode())],
            "client": None, "server": None,
        }
        sent = {"status": 500, "headers": [], "body": b""}
        delivered = False

        async def receive():
            nonlocal delivered
            if delivered:
                return {"type": "http.disconnect"}
            delivered = True
            return {"type": "http.request", "body": bytes(body or b""), "more_body": False}

        async def send(msg):
            if msg["type"] == "http.response.start":
                sent["status"] = msg["status"]
                sent["headers"] = [(k.decode(), v.decode()) for k, v in msg.get("headers", [])]
            elif msg["type"] == "http.response.body":
                sent["body"] += msg.get("body", b"")

        await self.app(scope, receive, send)
        return sent["status"], sent["headers"], sent["body"]

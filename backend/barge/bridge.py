"""The back-end worker's entry points: the seam's last step, and the models' port.

The relay hands each request to the backend worker over a MessagePort; the
worker calls ``handle`` here, which builds an ordinary ASGI scope and awaits
the FastAPI application exactly as uvicorn would. While the server is starting
or down the bridge answers nothing (``None``), so the relay reports a network
failure (§9.1). No routing or application logic lives here.

A push subscription (§9.2) is a **streamed** answer: ``handle`` calls
``on_stream("start", status, headers)``, then ``on_stream("chunk", bytes)`` per
command, then ``on_stream("end")``, and returns ``"stream"``. The worker turns
these into the port messages ``{status, headers, stream: true}``, ``{chunk}``
and ``{end: true}``.

Model workers reach the data server the same way, through the relay: there
is no other interface. Each model only tells the shell its phase.
"""
from __future__ import annotations

import json
import sys

from . import asgi
from .api import create_app
from .folder import FetchFolder
from .runtime import Runtime


def _js(x):
    try:
        from pyodide.ffi import to_js
    except ImportError:  # CPython (tests): nothing to convert
        return x
    return to_js(x)


def _py(x):
    return x.to_py() if hasattr(x, "to_py") else x


def _none(x):
    """JavaScript's null arrives in Pyodide as ``JsNull``, not None."""
    return None if x is None or type(x).__name__ == "JsNull" else x


class Bridge:
    def __init__(self, fetch_index=None, fetch_file=None):
        """``fetch_index()`` and ``fetch_file(name)`` read the data folder in the browser (``folder.FetchFolder``):
        the worker fetches ``index.json`` and each ``<file>.gz``, and decompresses them."""
        folder = FetchFolder(fetch_index, fetch_file) if _none(fetch_index) is not None else None
        # In Pyodide the page's event loop runs the importer: its subscription and imports are tasks on it. In
        # CPython (tests) the runtime keeps a loop of its own, run at each tick.
        self.rt = Runtime(folder=folder, own_loop=sys.platform != "emscripten")
        self.app = create_app(self.rt)

    def startup_phase(self) -> str:
        """``import`` (the importer starting, and the silent import of Mission A) or ``ready``."""
        return self.rt.startup_phase()

    def set_model_phase(self, model: str, phase: str, detail: str, label: str) -> None:
        self.rt.set_phase(model, phase, detail, label)

    def tick(self) -> str:
        """Advance the system; return captured messages and state as JSON for the page."""
        self.rt.tick()
        return json.dumps({"messages": self.rt.tap.drain(),
                           "server": "down" if self.rt.down else ("waiting" if not self.rt.server.ready else "running")},
                          default=str)

    def control(self, action: str, arg=None) -> str:
        rt = self.rt
        if action == "restart-server":
            rt.restart_server()
        elif action == "down":
            rt.take_down()
        elif action == "up":
            rt.bring_up()
        elif action == "field":
            rt.set_field(arg["name"], arg["on"])
        elif action == "profile-lie":
            a = _py(arg)
            rt.set_profile_lie(a.get("on") if isinstance(a, dict) else a)
        elif action == "capture":
            rt.tap.enabled = bool(arg)
        elif action == "reset-instance":
            rt.reset_instance()
        elif action == "set-role":
            a = _py(arg)
            rt.set_role(a["user"], a["role"])
        elif action != "state":
            raise ValueError(action)
        return json.dumps(rt.control_state(), default=str)

    def emit(self, src, dst, letter, summary, content="", failed=False):
        """Messages seen by the page or the relay are captured through the same tap."""
        self.rt.tap.emit(src, dst, letter, summary, content, failed)

    async def handle(self, method, path, query, body, root_path, headers=None, origin="https://localhost",
                     on_stream=None):
        if not self.rt.running:
            return None  # starting or down: no answer at all; the relay reports a network failure (§9.1)
        hs = [tuple(h) for h in _py(headers or [])]
        body = _none(body)
        raw = bytes(_py(body)) if body is not None else None
        cb = None
        if _none(on_stream) is not None:
            def cb(kind, *a):
                if kind == "start":
                    on_stream("start", a[0], _js([list(h) for h in a[1]]))
                elif kind == "chunk":
                    on_stream("chunk", _js(a[0]))
                else:
                    on_stream("end")
        r = await asgi.call(self.app, method, path, query, raw, root_path, hs, origin, on_stream=cb)
        if r is None or r == "stream":
            return r
        return r

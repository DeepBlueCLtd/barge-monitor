"""The back-end worker's entry points (Pyodide): the seam's last step, the shell's controls, the tick.

The relay hands each request to the back-end worker over a MessagePort; the worker calls
``handle`` here, which builds an ordinary ASGI scope and awaits the application (the access
gateway in front of the data server) exactly as uvicorn would. No routing or application logic
lives here.

* While the server is starting or down, ``handle`` answers ``None``: no answer at all, so the
  relay reports a network failure (§9.1).
* A push subscription (§9.2) is a **streamed** answer: ``handle`` calls ``on_stream("start",
  status, headers)``, then ``on_stream("chunk", bytes)`` per command, then ``on_stream("end")``,
  and returns ``"stream"``. The worker turns these into the port messages ``{status, headers,
  stream: true}``, ``{chunk}`` and ``{end: true}``.
"""
from __future__ import annotations

import json

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
    def __init__(self, fetch_index, fetch_file, fetch_manifest=None, real=None):
        kw = {"real": real} if real is not None else {}
        self.rt = Runtime(FetchFolder(fetch_index, fetch_file, fetch_manifest), **kw)
        self.app = create_app(self.rt)

    async def start(self) -> None:
        await self.rt.start()

    @property
    def frozen(self) -> bool:
        return self.rt.frozen

    def set_model_phase(self, model: str, phase: str, detail: str, label: str) -> None:
        self.rt.set_phase(model, phase, detail, label)

    def tick(self) -> str:
        """Every 100 ms: the replay clock and the server's start; captured messages and state for the page."""
        self.rt.tick()
        return json.dumps({"messages": self.rt.tap.drain(), "server": self.rt.status, "replay": self.rt.replay.view()},
                          default=str)

    def control(self, action: str, arg=None) -> str:
        return json.dumps(self.rt.control(action, _py(arg)), default=str)

    def emit(self, src, dst, letter, summary, content="", failed=False):
        """Messages seen by the page or the relay are captured through the same tap."""
        self.rt.tap.emit(src, dst, letter, summary, content, failed)

    async def handle(self, method, path, query, body, root_path, headers=None, origin="https://localhost",
                     on_stream=None):
        hs = [tuple(h) for h in _py(headers or [])]
        body = _none(body)
        raw = bytes(_py(body)) if body is not None else None
        cb = None
        if on_stream is not None:
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
        status, out_headers, payload = r
        return _js([status, [list(h) for h in out_headers], payload])

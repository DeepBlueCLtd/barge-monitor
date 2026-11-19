"""The seam's last step inside the backend worker: call the ASGI app.

The Service Worker hands each request to the backend worker over a
MessagePort; the worker calls ``handle`` here, which builds an ordinary ASGI
scope and awaits the application exactly as uvicorn would. No routing or
application logic lives here or in the Service Worker.
"""
from __future__ import annotations

from .edr import App
from .sim import Simulation


class Bridge:
    def __init__(self, seed: int):
        self.sim = Simulation(seed=seed)
        self.app = App(self.sim)

    def tick(self) -> int:
        return self.sim.tick()

    async def handle(self, method: str, path: str, query: str, body: bytes | None, root_path: str,
                     headers: list | None = None):
        scope = {
            "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
            "method": method.upper(), "scheme": "https", "path": root_path + path,
            "raw_path": (root_path + path).encode(), "root_path": root_path,
            "query_string": (query or "").encode("latin-1"),
            "headers": [(k.lower().encode(), v.encode()) for k, v in (headers or [])],
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

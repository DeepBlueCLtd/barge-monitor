"""The access gateway in front of a stock OpenSensorHub (AT-32; §9.5, D-150 to D-153).

The gateway is ``barge.gateway.Gateway``, the same code that stands in front of the Python stand-in,
unchanged in what it decides (credentials, roles, filtering, writes, who may subscribe). What differs
is what it stands in front of: here ``OshUpstream``, an ASGI application that passes each request
on to OpenSensorHub over HTTP. Only two things there are more than passing on, each named:

* **Push subscriptions (§9.2, §9.5).** ``GET /controlstreams/{id}/commands?subscribe=1`` is opened
  as a WebSocket on OpenSensorHub's internal endpoint (``/api-internal``, access control off), with
  the caller's credentials, and each pushed command is written as one line of
  ``application/x-ndjson``: OpenSensorHub pushes commands over WebSocket only (D-190).
* **The declared profile (FR-41).** ``GET /profile.json`` is answered from ``contracts/profile.json``,
  after the gateway has checked the credentials: OpenSensorHub cannot serve a file beside its API
  (D-191).

The gateway's own discovery (``Gateway.refresh``: ``/systems``, then ``/systems/{id}/subsystems``,
``/datastreams``, ``/controlstreams``, D-192) is the same in front of either server: OpenSensorHub's
listings carry no parent link (D-193), and the stand-ins' no longer do either.

Nothing here rewrites what a client sends or what OpenSensorHub answers: D-193 to D-196 are adopted
in the clients and the contract (2026-11-26), and the run is AT-32 as specified.
"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import httpx  # noqa: E402

from barge import accounts as A  # noqa: E402
from barge.api import NDJSON, refusal_page  # noqa: E402
from barge.gateway import Gateway  # noqa: E402
from barge.tap import Tap  # noqa: E402

CONTRACTS = Path(__file__).resolve().parents[2] / "contracts"
HOP = {"host", "content-length", "transfer-encoding", "connection", "x-tap-chain", "x-tap-hop", "x-tap-model",
       "x-tap-quiet", "accept-encoding"}


class Shim:
    """What the gateway asks of the runtime it sits in: here, nothing but the delivered accounts."""

    def __init__(self):
        self.accounts = A.Accounts()
        self.tap = Tap()
        self.tap.enabled = False
        self.running = True
        self.boots = 1

    async def wait_unfrozen(self):
        return None


class OshUpstream:
    """An ASGI application that is OpenSensorHub, reached over HTTP (and WebSocket for receivers)."""

    def __init__(self, root: str):
        self.root = root.rstrip("/")  # http://host:port/sensorhub
        self.http = httpx.AsyncClient(timeout=httpx.Timeout(90.0), trust_env=False)

    async def __call__(self, scope, receive, send):
        assert scope["type"] == "http"
        method = scope["method"]
        path = scope["path"] or "/"
        query = scope.get("query_string", b"").decode("latin-1")
        headers = [(k.decode("latin-1"), v.decode("latin-1")) for k, v in scope.get("headers", [])
                   if k.decode("latin-1").lower() not in HOP]
        body = b""
        while True:
            m = await receive()
            if m["type"] != "http.request":
                break
            body += m.get("body", b"")
            if not m.get("more_body"):
                break
        if method == "GET" and path == "/profile.json":
            data = (CONTRACTS / "profile.json").read_bytes()
            await send({"type": "http.response.start", "status": 200,
                        "headers": [(b"content-type", b"application/json")]})
            await send({"type": "http.response.body", "body": data})
            return
        parts = [p for p in path.split("/") if p]
        if (method == "GET" and len(parts) == 3 and parts[0] == "controlstreams" and parts[2] == "commands"
                and "subscribe=" in query and "subscribe=0" not in query):
            return await self._subscribe(parts[1], headers, receive, send)
        r = await self.http.request(method, self.root + "/api" + path + (f"?{query}" if query else ""),
                                    headers=headers, content=body or None)
        hs = [(k.encode("latin-1"), v.encode("latin-1")) for k, v in r.headers.items()
              if k.lower() not in ("content-length", "transfer-encoding", "connection", "content-encoding")]
        await send({"type": "http.response.start", "status": r.status_code, "headers": hs})
        await send({"type": "http.response.body", "body": r.content})

    async def _subscribe(self, cs: str, headers, receive, send):
        """A receiver's subscription, as a WebSocket on the internal endpoint (D-190)."""
        import websockets

        auth = next((v for k, v in headers if k.lower() == "authorization"), "")
        url = self.root.replace("http", "ws", 1) + f"/api-internal/controlstreams/{cs}/commands"
        try:
            ws = await websockets.connect(url, additional_headers={"Authorization": auth}, proxy=None, open_timeout=10)
        except websockets.exceptions.InvalidStatus as e:
            st = e.response.status_code
            page = refusal_page(st, f"the server refused the subscription ({st})")
            await send({"type": "http.response.start", "status": st, "headers": list(page.raw_headers)})
            await send({"type": "http.response.body", "body": page.body})
            return
        await send({"type": "http.response.start", "status": 200, "headers": [(b"content-type", NDJSON.encode())]})

        async def gone():
            while (await receive())["type"] != "http.disconnect":
                pass
        watcher = asyncio.ensure_future(gone())
        try:
            while True:
                recv = asyncio.ensure_future(ws.recv())
                done, _ = await asyncio.wait({recv, watcher}, return_when=asyncio.FIRST_COMPLETED)
                if watcher in done:
                    recv.cancel()
                    break
                try:
                    msg = recv.result()
                except websockets.exceptions.ConnectionClosed:
                    break
                cmd = json.loads(msg)
                line = {k: cmd[k] for k in ("id", "parameters", "issueTime", "sender") if k in cmd}
                await send({"type": "http.response.body", "body": json.dumps(line).encode() + b"\n", "more_body": True})
        finally:
            watcher.cancel()
            await ws.close()
        await send({"type": "http.response.body", "body": b"", "more_body": False})


class OshGateway(Gateway):
    """The gateway, unchanged, in front of OpenSensorHub."""

    def __init__(self, upstream: OshUpstream):
        super().__init__(upstream, Shim())

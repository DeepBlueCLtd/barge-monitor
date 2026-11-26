"""The access gateway in front of a stock OpenSensorHub (AT-32; §9.5, D-150 to D-153).

The gateway is ``barge.gateway.Gateway``, the same code that stands in front of the Python stand-in,
unchanged in what it decides (credentials, roles, filtering, writes, who may subscribe). What differs
is what it stands in front of: here ``OshUpstream``, an ASGI application that passes each request
on to OpenSensorHub over HTTP. Only three things there are more than passing on, each named:

* **Push subscriptions (§9.2, §9.5).** ``GET /controlstreams/{id}/commands?subscribe=1`` is opened
  as a WebSocket on OpenSensorHub's internal endpoint (``/api-internal``, access control off), with
  the caller's credentials, and each pushed command is written as one line of
  ``application/x-ndjson``: OpenSensorHub pushes commands over WebSocket only (D-190).
* **The declared profile (FR-41).** ``GET /profile.json`` is answered from ``contracts/profile.json``,
  after the gateway has checked the credentials: OpenSensorHub cannot serve a file beside its API
  (D-191).
* **Discovery for the gateway's own decisions.** ``OshGateway.refresh`` learns which system is
  under which from OpenSensorHub's own listings (``/systems``, ``/systems/{id}/subsystems``,
  ``/datastreams``, ``/controlstreams``), because OpenSensorHub serves no
  ``/collections/all_systems/items`` and lists no parent links (D-192).

``proposed`` (off by default) applies, in this layer, the client changes that the AT-32 finding
proposes, so that what lies beneath the first divergences can be seen. It is an experiment, never
part of the gateway: with it, the run is not AT-32 as specified.
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
from barge.gateway import BIG, Gateway  # noqa: E402
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

    def __init__(self, root: str, proposed: bool = False):
        self.root = root.rstrip("/")  # http://host:port/sensorhub
        self.proposed = proposed
        self.http = httpx.AsyncClient(timeout=httpx.Timeout(90.0), trust_env=False)
        self.rewrites: dict[str, int] = {}

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
        if self.proposed:
            path, query, headers = self._propose(method, path, query, headers, body)
            body = self._propose_body(method, path, body)
        r = await self.http.request(method, self.root + "/api" + path + (f"?{query}" if query else ""),
                                    headers=headers, content=body or None)
        hs = [(k.encode("latin-1"), v.encode("latin-1")) for k, v in r.headers.items()
              if k.lower() not in ("content-length", "transfer-encoding", "connection", "content-encoding")]
        if self.proposed and r.headers.get("content-type") == "auto" and r.content[:1] in (b"{", b"["):  # D-196
            self.rewrites["D-196"] = self.rewrites.get("D-196", 0) + 1
            hs = [(k, v) for k, v in hs if k.lower() != b"content-type"] + [(b"content-type", b"application/json")]
        await send({"type": "http.response.start", "status": r.status_code, "headers": hs})
        await send({"type": "http.response.body", "body": r.content})

    def _propose(self, method, path, query, headers, body):
        """The client changes the AT-32 finding proposes, applied here only to look beneath them."""
        if method == "GET" and path.rstrip("/") == "/collections/all_systems/items":  # D-193
            self.rewrites["D-193"] = self.rewrites.get("D-193", 0) + 1
            path, query = "/systems", "searchMembers=true" + (f"&{query}" if query else "")
        if method == "POST" and (path == "/systems" or path.endswith("/subsystems")):  # D-194
            try:
                kind = json.loads(body or b"{}").get("type")
            except ValueError:
                kind = None
            ctype = next((v for k, v in headers if k.lower() == "content-type"), "")
            if kind and kind != "Feature" and ctype.split(";")[0].strip() == "application/json":
                self.rewrites["D-194"] = self.rewrites.get("D-194", 0) + 1
                headers = [(k, v) for k, v in headers if k.lower() != "content-type"] + [
                    ("content-type", "application/sml+json")]
        return path, query, headers

    def _propose_body(self, method, path, body: bytes) -> bytes:
        """D-195: the UCUM code for parts per million is ``[ppm]``; OpenSensorHub refuses ``ppm``."""
        if method == "POST" and (path.endswith("/datastreams") or path.endswith("/controlstreams")) \
                and b'"code":"ppm"' in body.replace(b" ", b""):
            self.rewrites["D-195"] = self.rewrites.get("D-195", 0) + 1
            return body.replace(b'"code": "ppm"', b'"code": "[ppm]"').replace(b'"code":"ppm"', b'"code":"[ppm]"')
        return body

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
    """The gateway, discovering with what OpenSensorHub serves (D-192)."""

    def __init__(self, upstream: OshUpstream):
        super().__init__(upstream, Shim())

    async def refresh(self, auth: str) -> None:
        m = {"systems": {}, "ds": {}, "cs": {}, "cmd": dict((self._maps or {}).get("cmd", {}))}
        queue = [(s, None) for s in ((await self._ask(auth, "/systems", f"limit={BIG}")) or {}).get("items", [])]
        while queue:
            s, parent = queue.pop()
            uid = s.get("uniqueId") or (s.get("properties") or {}).get("uid")
            m["systems"][s["id"]] = (uid, parent)
            subs = await self._ask(auth, f"/systems/{s['id']}/subsystems", f"limit={BIG}")
            queue += [(c, s["id"]) for c in (subs or {}).get("items", [])]
        for d in ((await self._ask(auth, "/datastreams", f"limit={BIG}")) or {}).get("items", []):
            m["ds"][d["id"]] = d["system@id"]
        for c in ((await self._ask(auth, "/controlstreams", f"limit={BIG}")) or {}).get("items", []):
            m["cs"][c["id"]] = c["system@id"]
        self._maps, self._boot = m, self.rt.boots

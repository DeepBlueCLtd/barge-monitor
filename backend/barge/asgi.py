"""One HTTP request of an ASGI application, without a network: what the relay's last step and the
in-process models both do. No routing or application logic lives here.

``call`` returns ``(status, headers, body)``, or ``None`` when the server answers nothing (it is
starting or down: the relay then reports a network failure, §9.1).

A **streamed** answer (a push subscription, §9.2) is recognised by its first body message having
``more_body``. With ``on_stream`` given, ``call`` then calls ``on_stream("start", status, headers)``,
``on_stream("chunk", bytes)`` per chunk and ``on_stream("end")``, and returns ``"stream"`` once it
ends. Cancelling the task that awaits ``call`` disconnects the client.
"""
from __future__ import annotations

import asyncio

from .api import ServerUnavailable


async def call(app, method, path, query="", body=None, root_path="", headers=None, origin="https://localhost",
               on_stream=None):
    scope = {
        "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": method.upper(),
        "scheme": origin.split(":")[0], "path": root_path + path, "raw_path": (root_path + path).encode(),
        "root_path": root_path, "query_string": (query or "").encode("latin-1"),
        "headers": [(k.lower().encode("latin-1"), str(v).encode("latin-1")) for k, v in (headers or [])
                    if k.lower() != "host"] + [(b"host", origin.split("://", 1)[-1].encode())],
        "client": None, "server": None,
    }
    sent = {"status": 500, "headers": [], "body": [], "streaming": False}
    delivered = False
    gone = asyncio.Event()

    async def receive():
        nonlocal delivered
        if not delivered:
            delivered = True
            return {"type": "http.request", "body": bytes(body or b""), "more_body": False}
        await gone.wait()  # a streamed answer listens for the client's disconnect
        return {"type": "http.disconnect"}

    async def send(msg):
        if msg["type"] == "http.response.start":
            sent["status"] = msg["status"]
            sent["headers"] = [(k.decode("latin-1"), v.decode("latin-1")) for k, v in msg.get("headers", [])]
        elif msg["type"] == "http.response.body":
            chunk = msg.get("body", b"")
            more = msg.get("more_body", False)
            if on_stream is not None and (sent["streaming"] or more):
                if not sent["streaming"]:
                    sent["streaming"] = True
                    on_stream("start", sent["status"], sent["headers"])
                if chunk:
                    on_stream("chunk", chunk)
                if not more:
                    on_stream("end")
                return
            sent["body"].append(chunk)

    try:
        await app(scope, receive, send)
    except ServerUnavailable:
        if sent["streaming"]:
            on_stream("end")
            return "stream"
        return None
    except asyncio.CancelledError:
        gone.set()
        raise
    finally:
        gone.set()
    if sent["streaming"]:
        return "stream"
    return sent["status"], sent["headers"], b"".join(sent["body"])

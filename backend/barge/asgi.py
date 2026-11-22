"""One HTTP request of an ASGI application, without a network: what the relay's last step
and the in-process models both do. No routing or application logic lives here."""
from __future__ import annotations


async def call(app, method, path, query="", body=None, root_path="", headers=None, origin="https://localhost"):
    scope = {
        "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": method.upper(),
        "scheme": origin.split(":")[0], "path": root_path + path, "raw_path": (root_path + path).encode(),
        "root_path": root_path, "query_string": (query or "").encode("latin-1"),
        "headers": [(k.lower().encode(), v.encode()) for k, v in (headers or []) if k.lower() != "host"]
                   + [(b"host", origin.split("://", 1)[-1].encode())],
        "client": None, "server": None,
    }
    sent = {"status": 500, "headers": [], "body": []}
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
            sent["body"].append(msg.get("body", b""))

    await app(scope, receive, send)
    return sent["status"], sent["headers"], b"".join(sent["body"])

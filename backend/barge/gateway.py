"""The access gateway (§9.5; decision D-150): our code in front of the data server.

A stock OpenSensorHub cannot hide a system (S-AUTH, 2026-11-25), so the restriction of FR-93
is done here, in a component of its own (``gateway``), drawn as such and never hidden inside the
stand-in. Every request from the display client and from the models passes it; the importer and
the replay controller are modules inside the server and do not.

* **Credentials.** It authenticates every request against the delivered accounts and forwards it
  with the same credentials. Without valid credentials it answers ``401`` itself, and it strips
  the server's ``WWW-Authenticate`` so the browser never shows its own login dialog (D-153).
* **Roles.** It reads the user-to-role assignment on every request: a role change takes effect
  at once (FR-116, D-151).
* **Filtering.** Restricted resources, matched by unique-id prefix (``urn:x-barge:sensor:*:co2``,
  ``urn:x-barge:process:*:restricted``) for a role without emissions, and other users'
  workspaces, are removed from every listing, with their datastreams, control streams and
  commands; every path under them answers ``404``.
* **Writes.** Create and append only under one's own systems: a user under its workspace, a
  service under its own systems (the importer also under the sensors).
* **Push subscriptions** are forwarded for service accounts only.

The gateway learns which system a datastream, control stream or command belongs to by asking
the server (discovery), with the caller's credentials; those requests are counted, not drawn.
Capture (§2): ``client|models → gateway → server`` and back, each hop a message.
"""
from __future__ import annotations

import json
import re

from . import accounts as A
from .api import NDJSON, ServerUnavailable, _letter_for_request, _letter_for_response, _shown, refusal_page
from .store import URN

CO2 = re.compile(r"^urn:x-barge:sensor:[^:]+:co2(:|$)")
RESTRICTED = re.compile(r"^urn:x-barge:process:[^:]+:restricted(:|$)")
WORKSPACE = re.compile(r"^urn:x-barge:workspace:([^:]+)")
BIG = 1_000_000


class Refused(Exception):
    def __init__(self, status: int, why: str):
        super().__init__(why)
        self.status, self.why = status, why


class Gateway:
    def __init__(self, server, rt):
        self.server = server  # the data server's ASGI application
        self.rt = rt
        self._maps = None
        self._boot = None

    def openapi(self) -> dict:
        return self.server.openapi()

    # --- what an account may see and write ----------------------------------------------------
    @staticmethod
    def hidden_uid(uid: str, acct: A.Account) -> bool:
        if (CO2.match(uid) or RESTRICTED.match(uid)) and not A.may_read_co2(acct.role):
            return True
        m = WORKSPACE.match(uid)
        return bool(m) and m.group(1) != acct.user

    def chain(self, sid: str) -> list[str]:
        out, seen = [], set()
        while sid and sid not in seen and sid in self._maps["systems"]:
            seen.add(sid)
            uid, parent = self._maps["systems"][sid]
            out.append(uid)
            sid = parent
        return out

    def hidden(self, sid: str, acct) -> bool:
        return any(self.hidden_uid(u, acct) for u in self.chain(sid))

    def own(self, sid: str, acct) -> bool:
        uids = self.chain(sid)
        if acct.kind == "user":
            return f"{URN}workspace:{acct.user}" in uids
        if acct.user == "svc-importer":
            return any(u == URN + "importer" or u.startswith(URN + "sensor:") for u in uids)
        if acct.user == "svc-replay":
            return URN + "replay" in uids
        mine = f"{URN}process:{acct.user[4:]}"
        return any(u == mine or u.startswith(mine + ":") for u in uids)

    # --- the server's discovery, asked by the gateway ------------------------------------------
    async def _ask(self, auth: str, path: str, query: str = ""):
        from .asgi import call

        r = await call(self.server, "GET", path, query, headers=[("authorization", auth), ("x-tap-quiet", "1")])
        if r is None:
            raise ServerUnavailable()
        st, _, body = r
        return json.loads(body) if st == 200 else None

    async def refresh(self, auth: str) -> None:
        sysl = await self._ask(auth, "/collections/all_systems/items", f"f=application/sml%2Bjson&limit={BIG}")
        dss = await self._ask(auth, "/datastreams", f"limit={BIG}")
        css = await self._ask(auth, "/controlstreams", f"limit={BIG}")
        m = self._maps if self._maps and self._boot == self.rt.boots else {"systems": {}, "ds": {}, "cs": {}, "cmd": {}}
        for s in (sysl or {}).get("items", []):
            parent = next((lk["href"].rstrip("/").rsplit("/", 1)[-1] for lk in s.get("links", [])
                           if lk.get("rel") == "parent"), None)
            m["systems"][s["id"]] = (s["uniqueId"], parent)
        for d in (dss or {}).get("items", []):
            m["ds"][d["id"]] = d["system@id"]
        for c in (css or {}).get("items", []):
            m["cs"][c["id"]] = c["system@id"]
        self._maps, self._boot = m, self.rt.boots

    async def system_of(self, kind: str, rid: str, auth: str) -> str | None:
        if self._maps is None or self._boot != self.rt.boots:
            self._maps = None
            await self.refresh(auth)
        if kind == "systems":
            if rid not in self._maps["systems"]:
                await self.refresh(auth)
            return rid if rid in self._maps["systems"] else None
        if kind == "commands":
            if rid not in self._maps["cmd"]:
                c = await self._ask(auth, f"/commands/{rid}")
                if c is None:
                    return None
                self._maps["cmd"][rid] = c["controlstream@id"]
            return await self.system_of("controlstreams", self._maps["cmd"][rid], auth)
        key = "ds" if kind == "datastreams" else "cs"
        if rid not in self._maps[key]:
            await self.refresh(auth)
        sid = self._maps[key].get(rid)
        if sid is not None and sid not in self._maps["systems"]:
            await self.refresh(auth)
        return sid

    async def check(self, method: str, rel: str, query: str, acct, auth: str, body: bytes) -> None:
        """Refuse what this account may not do, as an absent resource (404) or a refusal (403)."""
        parts = [p for p in rel.split("/") if p]
        if not parts or parts[0] in ("conformance", "collections", "profile.json", "demonstrator"):
            return
        if parts[0] in ("systems", "datastreams", "controlstreams", "commands") and len(parts) >= 2:
            sid = await self.system_of(parts[0], parts[1], auth)
            if sid is None:
                return  # unknown to the server too: it answers 404 itself
            if self.hidden(sid, acct):
                raise Refused(404, f"{parts[0][:-1]} {parts[1]} not found")
            if method == "POST":
                sub = parts[2] if len(parts) > 2 else ""
                if parts[0] == "systems" and sub == "subsystems":
                    if self.own(sid, acct) or self._registering(sid, acct, body):
                        return
                    raise Refused(403, "this account may not create a system here")
                if sub == "commands" and parts[0] == "controlstreams":
                    return  # every user may command what it can see (§9.3)
                if not self.own(sid, acct):
                    raise Refused(403, "create and append only under your own systems")
            if method == "GET" and parts[0] == "controlstreams" and len(parts) > 2 and parts[2] == "commands" \
                    and "subscribe=" in query and "subscribe=0" not in query and acct.kind != "service":
                raise Refused(403, "only service accounts subscribe to commands")
        elif method == "POST" and parts == ["systems"]:
            raise Refused(403, "this account may not create a top-level system")

    def _registering(self, sid: str, acct, body: bytes) -> bool:
        """A model's service account registers its own process system under Models (FR-28)."""
        if acct.user not in A.MODEL_SERVICES or self._maps["systems"].get(sid, ("",))[0] != URN + "process:models":
            return False
        try:
            b = json.loads(body or b"{}")
        except ValueError:
            return False
        uid = b.get("uniqueId") or (b.get("properties") or {}).get("uid")
        return uid == f"{URN}process:{acct.user[4:]}"

    async def filter(self, payload: bytes, acct, auth: str) -> bytes:
        """Remove what the account may not see from a listing."""
        try:
            doc = json.loads(payload)
        except ValueError:
            return payload
        if not isinstance(doc, dict) or not isinstance(doc.get("items"), list):
            return payload
        if self._maps is None or self._boot != self.rt.boots:
            self._maps = None
            await self.refresh(auth)
        m = self._maps
        known = set(m["systems"])
        if any(isinstance(it, dict) and ((it.get("system@id") and it["system@id"] not in known)
                                         or (it.get("controlstream@id") and it["controlstream@id"] not in m["cs"]))
               for it in doc["items"]):
            await self.refresh(auth)

        def keep(it) -> bool:
            if not isinstance(it, dict):
                return True
            if "system@id" in it:
                return not self.hidden(it["system@id"], acct)
            if "controlstream@id" in it:
                sid = m["cs"].get(it["controlstream@id"])
                return sid is None or not self.hidden(sid, acct)
            uid = it.get("uniqueId") or (it.get("properties") or {}).get("uid")
            if uid:
                return not (self.hidden(it["id"], acct) if it.get("id") in m["systems"] else self.hidden_uid(uid, acct))
            return True
        doc["items"] = [it for it in doc["items"] if keep(it)]
        return json.dumps(doc).encode()

    # --- ASGI ----------------------------------------------------------------------------------------
    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.server(scope, receive, send)
        rt, tap = self.rt, self.rt.tap
        if not rt.running:
            raise ServerUnavailable()
        await rt.wait_unfrozen()
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
        root = scope.get("root_path", "") or ""
        rel = (scope["path"][len(root):] if root and scope["path"].startswith(root) else scope["path"]) or "/"
        query = scope.get("query_string", b"").decode("latin-1")
        method = scope["method"]
        body = b""
        while True:
            msg = await receive()
            if msg["type"] != "http.request":
                break
            body += msg.get("body", b"")
            if not msg.get("more_body"):
                break
        auth = headers.get("authorization", "")
        acct = rt.accounts.authenticate(auth)
        model = headers.get("x-tap-model") or None
        quiet = headers.get("x-tap-quiet") == "1"
        who = "models" if model else (acct.component if acct and acct.component in ("client", "models") else "client")
        hop = headers.get("x-tap-hop", "0")
        token = tap.begin_chain(headers.get("x-tap-chain"), int(hop) if hop.isdigit() else 0)
        chain_id = tap.chain_id()
        ask = f"{method} {rel}{'?' + query if query else ''}"
        tap.emit(who, "gateway", _letter_for_request(method, rel), f"{model}: {ask}" if model else ask,
                 ask + (f"\nAuthorization: {auth}" if auth else "") + ("\n\n" + _shown(body) if body else ""),
                 model=model, quiet=quiet)

        async def answer(status, hs, payload, streamed=False, at_hop=None):
            nonlocal token
            last = tap.end_chain(token)
            t2 = tap.begin_chain(chain_id, at_hop if at_hop is not None else last)
            ctype = next((v.decode() for k, v in hs if k.lower() == b"content-type"), "")
            summary = f"{status} {rel}" + (" (subscribed)" if streamed else "")
            tap.emit("gateway", who, _letter_for_response(status, rel, ctype), f"{model}: {summary}" if model else summary,
                     "push subscription open" if streamed else _shown(payload), model=model, quiet=quiet)
            hops = tap.end_chain(t2)
            token = tap.begin_chain(chain_id, hops)
            hs = [(k, v) for k, v in hs if k.lower() not in (b"www-authenticate", b"content-length", b"x-tap-hops")]
            if not streamed:
                hs.append((b"content-length", str(len(payload)).encode()))
            hs.append((b"x-tap-hops", str(hops).encode()))
            await send({"type": "http.response.start", "status": status, "headers": hs})

        try:
            if acct is None:
                r = refusal_page(401, "valid credentials are needed")  # no WWW-Authenticate (D-153)
                await answer(401, list(r.raw_headers), r.body)
                await send({"type": "http.response.body", "body": r.body})
                return
            try:
                await self.check(method, rel, query, acct, auth, body)
            except Refused as e:
                r = refusal_page(e.status, e.why)
                await answer(e.status, list(r.raw_headers), r.body)
                await send({"type": "http.response.body", "body": r.body})
                return
            fwd = [(k, v) for k, v in scope.get("headers", []) if k not in (b"x-tap-chain", b"x-tap-hop")]
            fwd += [(b"x-tap-chain", chain_id.encode()), (b"x-tap-hop", str(tap.end_chain(token)).encode())]
            token = tap.begin_chain(chain_id, int(fwd[-1][1]))
            inner = dict(scope, headers=fwd)
            state = {"start": None, "body": [], "streamed": False, "buf": b""}
            delivered = False

            async def inner_receive():
                nonlocal delivered
                if not delivered:
                    delivered = True
                    return {"type": "http.request", "body": body, "more_body": False}
                while True:
                    m = await receive()
                    if m["type"] == "http.disconnect":
                        return m

            async def inner_send(msg):
                if msg["type"] == "http.response.start":
                    hs = list(msg.get("headers", []))
                    hops = next((int(v) for k, v in hs if k == b"x-tap-hops"), None)
                    ctype = next((v.decode() for k, v in hs if k.lower() == b"content-type"), "")
                    if ctype.startswith(NDJSON):
                        state["streamed"] = True
                        await answer(msg["status"], hs, b"", streamed=True, at_hop=hops)
                    else:
                        state["start"] = (msg["status"], hs, hops)
                    return
                chunk = msg.get("body", b"")
                if state["streamed"]:
                    state["buf"] += chunk
                    while b"\n" in state["buf"]:
                        line, state["buf"] = state["buf"].split(b"\n", 1)
                        try:
                            cmd = json.loads(line)
                        except ValueError:
                            cmd = {}
                        p = cmd.get("parameters", {}) if isinstance(cmd, dict) else {}
                        tap.emit("gateway", who, "K", f"push: {', '.join(f'{k}={v}' for k, v in p.items() if k != 'doi')[:100]}",
                                 line.decode("utf-8", "replace"), model=model, push=True)
                    await send(msg)
                    return
                state["body"].append(chunk)
                if not msg.get("more_body"):
                    st, hs, hops = state["start"]
                    payload = b"".join(state["body"])
                    if method == "GET" and st == 200:
                        payload = await self.filter(payload, acct, auth)
                    elif method == "POST" and st == 201 and rel.endswith("/datastreams") and self._maps is not None:
                        loc = next((v.decode() for k, v in hs if k.lower() == b"location"), "")
                        self._maps["ds"][loc.rstrip("/").rsplit("/", 1)[-1]] = rel.split("/")[2]
                    await answer(st, hs, payload, at_hop=hops)
                    await send({"type": "http.response.body", "body": payload})

            await self.server(inner, inner_receive, inner_send)
        finally:
            tap.end_chain(token)

"""The data server's HTTP interface: a stand-in that behaves as a configured stock OpenSensorHub (FR-06c, §9).

An ordinary ASGI application on FastAPI: it runs unchanged under uvicorn and in Pyodide (NFR-03).
It behaves as OpenSensorHub does wherever this system relies on it (docs/v4-interfaces.md §9.1):

* opaque identifiers; discovery of every system by ``GET /systems?searchMembers=true``; SensorML
  sent as ``application/sml+json`` (anything else is read as GeoJSON); unit codes must be UCUM;
* ``POST`` creating what exists answers ``201`` with the existing ``Location``;
* one observation per ``POST`` (an array is ``400``); a missing value is ``"NaN"`` (``null`` in a
  Quantity is ``400``); ``PUT``, ``PATCH`` and ``DELETE`` answer ``405``;
* the format is chosen with ``f=``; ``Accept`` is ignored; paging by ``limit`` and ``offset``, with no
  ``next`` link in SWE JSON; a ``limit`` over the maximum is served, not refused;
* refusals are HTML pages; no instance identifier and no ``503``: while starting or down the server
  answers nothing (``ServerUnavailable``; the relay reports a network failure);
* commands are **pushed** to subscribers (``?subscribe=1``, a never-ending NDJSON stream, §9.2);
  without one a command is dropped and answered ``202`` after the hold; with one it is answered
  ``200`` after the hold, and the sender's ``PENDING`` report is stored then; status is posted to
  ``/controlstreams/{id}/status``;
* ``/profile.json`` beside the API (FR-41), not linked from the landing page.

**Authentication and permissions** are the server's own (§9.3; 4.7: no gateway). Every request
needs ``Authorization: Basic``; without valid credentials ``401`` with ``WWW-Authenticate: basic``,
as OpenSensorHub sends it (the relay drops the header, D-226). A restricted resource is **listed,
and refused with 403** (FR-93 as relaxed in 4.7). Creating and appending is allowed only under
one's own systems. Roles are read on every request (FR-116). Receivers subscribe on the internal
endpoint ``/api-internal``, for service accounts only (D-223).

The CSV importer (``importer.py``) is a module of this server: its datasets are stored datastreams
under the sensors and the CO₂ analysers. Beside them, until the 4.1 display client and models are
replaced (plan Phases 6 and 7), each sensor's ``weather`` datastream is read from the 4.1 logger store
through the store adapter (letter ``S``), and the profile served is the 4.1 one (D-252, D-271).

One thing here is not OpenSensorHub and says so: ``/demonstrator/referee`` (scaffolding: the only
code that reads the manifest, FR-37).
"""
from __future__ import annotations

import asyncio
import html
import json
import math
import re

import numpy as np
from fastapi import FastAPI, Path, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response, StreamingResponse

from . import accounts as A
from . import config as C
from . import scoring
from . import swe
from .server import SOSA, iso, iso_many, iso_real, parse_iso
from .store import NUMERIC, URN, Subscription
from .tap import COMPONENTS
from .ucum import bad_codes

CS1 = "http://www.opengis.net/spec/ogcapi-connectedsystems-1/1.0/conf/"
CS2 = "http://www.opengis.net/spec/ogcapi-connectedsystems-2/1.0/conf/"
CONFORMANCE = [
    "http://www.opengis.net/spec/ogcapi-common-1/1.0/conf/core",
    "http://www.opengis.net/spec/ogcapi-common-1/1.0/conf/json",
    "http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/core",
    CS1 + "system", CS1 + "subsystem", CS1 + "sensorml", CS1 + "geojson",
    CS2 + "datastream", CS2 + "controlstream", CS2 + "json", CS2 + "swecommon-json", CS2 + "create-replace-delete",
]
REASONS = {400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed",
           415: "Unsupported Media Type", 500: "Internal Server Error"}
COMMAND_STATUSES = ("ACCEPTED", "EXECUTING", "COMPLETED", "FAILED", "REJECTED")
REFEREE = "/demonstrator/referee"
INTERNAL = "/api-internal"
NDJSON = "application/x-ndjson"
SML_JSON = "application/sml+json"
GEO_JSON = "application/geo+json"
FORMATS = {"json": swe.JSON, swe.JSON: swe.JSON, "swe+json": swe.SWE_JSON, swe.SWE_JSON: swe.SWE_JSON,
           "sml+json": SML_JSON, SML_JSON: SML_JSON, "geojson": GEO_JSON, GEO_JSON: GEO_JSON}
FIELD_TYPES = ("Quantity", "Count", "Category", "Boolean", "Text", "Time")
SHOWN_BYTES = 4 * 4000  # what a captured message shows of a body (the tap clips it further)
PRECISION = 2

# Restricted systems, matched by unique id (§9.3): reading them, or anything under them, answers 403.
CO2 = re.compile(r"^urn:x-barge:sensor:[^:]+:co2(:|$)")
RESTRICTED = re.compile(r"^urn:x-barge:process:[^:]+:restricted(:|$)")
WORKSPACE = re.compile(r"^urn:x-barge:workspace:([^:]+)$")


class ServerUnavailable(Exception):
    """The server is starting or down: no answer at all (the relay reports a network failure)."""


class Refusal(Exception):
    def __init__(self, status: int, description: str, headers=None):
        super().__init__(description)
        self.status, self.description, self.headers = status, description, headers or {}


def refusal_page(status: int, description: str, headers=None) -> Response:
    """A refusal is an HTML page, as OpenSensorHub's are; no client may rely on its body (§9.1)."""
    title = f"{status} {REASONS.get(status, 'Error')}"
    body = (f"<!doctype html><html><head><title>{title}</title></head><body><h1>{title}</h1>"
            f"<p>{html.escape(description)}</p></body></html>")
    return Response(body, status_code=status, media_type="text/html", headers=headers or {})


def _letter_for_request(method: str, path: str) -> str:
    path = path.rstrip("/")
    if path.startswith("/demonstrator"):
        return "I"
    if method == "POST" and path.endswith("/commands"):
        return "K"
    if method in ("POST", "PUT") and path.endswith("/observations"):
        return "O"
    return "Q"


def _letter_for_response(status: int, path: str, ctype: str) -> str:
    if status >= 400:
        return "H"
    if path.startswith("/demonstrator"):
        return "I"
    if path.rstrip("/").endswith("/profile.json"):
        return "P"
    if "swe+json" in ctype or path.rstrip("/").endswith("/observations"):
        return "O"
    return "D"


def _shown(b: bytes) -> str:
    if len(b) <= SHOWN_BYTES:
        return b.decode("utf-8", "replace")
    return b[:SHOWN_BYTES].decode("utf-8", "replace") + f"… ({len(b)} bytes in all)"


# --- permissions (§9.3) ---------------------------------------------------------------------------
def restricted_for(chain: list[dict], acct: A.Account) -> bool:
    """True when this account may not read a system (given with its ancestors): listed, but refused with 403."""
    for s in chain:
        if (CO2.match(s["uid"]) or RESTRICTED.match(s["uid"])) and not A.may_read_co2(acct.role):
            return True
        m = WORKSPACE.match(s["uid"])
        if m and m.group(1) != acct.user:
            return True
    return False


def owns(chain: list[dict], acct: A.Account) -> bool:
    """Create and append only under one's own systems: a user under its workspace; a service account under
    its own systems (the importer under the importer and the sensors)."""
    uids = [s["uid"] for s in chain]
    if acct.kind == "user":
        return f"{URN}workspace:{acct.user}" in uids
    if acct.user == "svc-importer":
        return any(u == URN + "importer" or u.startswith(URN + "sensor:") for u in uids)
    mine = f"{URN}process:{acct.user[4:]}"
    return any(u == mine or u.startswith(mine + ":") for u in uids)


class Gate:
    """The server's front: lifecycle (no answer while starting or down), the two endpoints, authentication,
    capture. A pure ASGI middleware around the FastAPI application, so that a push subscription streams
    through it. Nothing is decided by the capture headers (§2)."""

    def __init__(self, app: FastAPI, rt):
        self.app = app
        self.rt = rt

    def openapi(self) -> dict:
        return self.app.openapi()

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        rt = self.rt
        if not rt.running:
            raise ServerUnavailable()
        tap = rt.tap
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
        root = scope.get("root_path", "") or ""
        path = scope["path"]
        rel = (path[len(root):] if root and path.startswith(root) else path) or "/"
        internal = root.endswith(INTERNAL)
        if not internal and (rel == INTERNAL or rel.startswith(INTERNAL + "/")):  # served at the site's root
            internal, root = True, root + INTERNAL
            rel = rel[len(INTERNAL):] or "/"
        scope = dict(scope, root_path=root, path=root + rel)
        query = scope.get("query_string", b"").decode("latin-1")
        method = scope["method"]
        body = b""
        while True:
            m = await receive()
            if m["type"] == "http.request":
                body += m.get("body", b"")
                if not m.get("more_body"):
                    break
            else:
                break
        auth = headers.get("authorization")
        acct = rt.accounts.authenticate(auth)
        model = headers.get("x-tap-model") or None
        quiet = headers.get("x-tap-quiet") == "1"
        who = "models" if model else (acct.component if acct and acct.component in COMPONENTS else "client")
        hop = headers.get("x-tap-hop", "1")
        token = tap.begin_chain(headers.get("x-tap-chain"), int(hop) if hop.isdigit() else 1)
        where = INTERNAL if internal else ""
        ask = f"{method} {where}{rel}{'?' + query if query else ''}"
        shown = ask + (f"\nAuthorization: {auth}" if auth else "") + ("\n\n" + _shown(body) if body else "")
        tap.emit(who, "server", _letter_for_request(method, rel), f"{model}: {ask}" if model else ask, shown,
                 model=model, quiet=quiet)
        chain_id = tap.chain_id()
        state = {"start": None, "body": [], "streamed": False}

        async def respond(status: int, out_headers: list, payload: bytes, streamed=False):
            nonlocal token
            hops = tap.end_chain(token)
            ctype = next((v.decode() for k, v in out_headers if k.lower() == b"content-type"), "")
            out_headers = [h for h in out_headers if h[0].lower() != b"content-length"]
            if not streamed:
                out_headers.append((b"content-length", str(len(payload)).encode()))
            out_headers.append((b"x-tap-hops", str(hops + 1).encode()))
            t2 = tap.begin_chain(chain_id, hops)
            summary = f"{status} {where}{rel}" + (" (subscribed)" if streamed else "")
            tap.emit("server", who, _letter_for_response(status, rel, ctype), f"{model}: {summary}" if model else summary,
                     "push subscription open: commands follow as they are sent" if streamed else _shown(payload),
                     model=model, quiet=quiet)
            tap.end_chain(t2)
            token = tap.begin_chain(chain_id, hops + 2)
            await send({"type": "http.response.start", "status": status, "headers": out_headers})

        async def refuse(r: Response):
            await respond(r.status_code, list(r.raw_headers), r.body)
            await send({"type": "http.response.body", "body": r.body})

        try:
            if acct is None:  # as OpenSensorHub answers; the relay drops WWW-Authenticate (D-226)
                return await refuse(refusal_page(401, "valid credentials are needed", {"WWW-Authenticate": "basic"}))
            if internal and acct.kind != "service":  # the internal endpoint is for the server's own processes (D-223)
                return await refuse(refusal_page(403, "the internal endpoint is for service accounts only"))
            inner = dict(scope)
            inner["state"] = {"account": acct, "model": model, "quiet": quiet, "internal": internal}
            delivered = False

            async def inner_receive():
                nonlocal delivered
                if not delivered:
                    delivered = True
                    return {"type": "http.request", "body": body, "more_body": False}
                while True:  # a streamed answer listens for the client's disconnect
                    m = await receive()
                    if m["type"] == "http.disconnect":
                        return m

            async def inner_send(msg):
                if msg["type"] == "http.response.start":
                    hs = list(msg.get("headers", []))
                    ctype = next((v.decode() for k, v in hs if k.lower() == b"content-type"), "")
                    if ctype.startswith(NDJSON):
                        state["streamed"] = True
                        await respond(msg["status"], hs, b"", streamed=True)
                    else:
                        state["start"] = (msg["status"], hs)
                elif msg["type"] == "http.response.body":
                    if state["streamed"]:
                        await send(msg)
                        return
                    state["body"].append(msg.get("body", b""))
                    if not msg.get("more_body"):
                        payload = b"".join(state["body"])
                        st, hs = state["start"]
                        await respond(st, hs, payload)
                        await send({"type": "http.response.body", "body": payload})

            await self.app(inner, inner_receive, inner_send)
        finally:
            tap.end_chain(token)


def create_app(rt) -> Gate:
    """The data server's stand-in: under uvicorn or in Pyodide, the same object (NFR-03)."""
    app = FastAPI(
        title="Canal barge weather demonstrator: data server stand-in (OpenSensorHub)",
        version="4.7.0",
        description=("What this system needs of a Connected Systems server (OGC API – Connected Systems Parts 1 and 2), "
                     "as a stand-in that behaves as a configured stock OpenSensorHub does (FR-06c). Every request needs "
                     "Basic credentials; receivers subscribe on /api-internal. Everything is fictional."),
        openapi_url=None, docs_url=None, redoc_url=None,
    )

    def srv():
        return rt.server

    def store():
        return rt.store

    @app.exception_handler(Refusal)
    async def refusal_handler(_request, exc: Refusal):
        return refusal_page(exc.status, exc.description, exc.headers)

    @app.exception_handler(RequestValidationError)
    async def validation_handler(_request, exc: RequestValidationError):
        err = exc.errors()[0] if exc.errors() else {}
        return refusal_page(400, f"{err.get('loc', ['?'])[-1]}: {err.get('msg', 'invalid')}")

    # --- helpers -------------------------------------------------------------------------
    def who(request: Request) -> A.Account:
        # Roles are read on every request (FR-116, D-151): the account table is the live one.
        return request.state.account

    def base(request: Request) -> str:
        return str(request.base_url).rstrip("/")

    def link(request, href, rel, type_=swe.JSON, title=None):
        lk = {"href": base(request) + href, "rel": rel, "type": type_}
        if title:
            lk["title"] = title
        return lk

    def page(items: list, request: Request, path: str, limit: int, offset: int):
        if limit < 1 or offset < 0:
            raise Refusal(400, "limit must be at least 1 and offset zero or more")
        chunk = items[offset:offset + limit]
        links = [link(request, path, "self")]
        if offset + limit < len(items):
            links.append(link(request, f"{path}{'&' if '?' in path else '?'}limit={limit}&offset={offset + limit}", "next"))
        return {"items": chunk, "links": links}

    def fmt(f: str | None, default: str, allowed: tuple) -> str:
        if f is None:
            return default  # Accept is ignored, as OpenSensorHub ignores it (§9.1)
        norm = FORMATS.get(f.strip())
        if norm not in allowed:
            raise Refusal(400, f"format {f} is not offered here; offered: {', '.join(allowed)}")
        return norm

    def get_system(sid) -> dict:
        s = store().systems.get(sid)
        if s is None:
            raise Refusal(404, f"system {sid} not found")
        return s

    def readable(request, sid) -> list[dict]:
        """The system and its ancestors; 403 when the account may not read it (listed, refused: §9.3)."""
        chain = store().chain(sid)
        if restricted_for(chain, who(request)):
            raise Refusal(403, "this account may not read this resource")
        return chain

    def writable(request, sid) -> None:
        if not owns(store().chain(sid), who(request)):
            raise Refusal(403, "create and append only under your own systems")

    def get_ds(dsid, hidden=False) -> dict:
        d = store().datastreams.get(dsid)
        if d is None or not (hidden or srv().served(d)):
            raise Refusal(404, f"datastream {dsid} not found")
        return d

    def get_cs(csid) -> dict:
        c = store().controlstreams.get(csid)
        if c is None or c["replaced"]:
            raise Refusal(404, f"control stream {csid} not found")
        return c

    def system_json(request, s, form, listed=True):
        sid = s["id"]
        links = [link(request, f"/systems/{sid}", "self"), link(request, f"/systems/{sid}/datastreams", "datastreams"),
                 link(request, f"/systems/{sid}/subsystems", "subsystems"),
                 link(request, f"/systems/{sid}/controlstreams", "controlstreams")]
        if s["parent"] and not listed:  # a listing carries no parent link, as OpenSensorHub's (D-193)
            links.append(link(request, f"/systems/{s['parent']}", "parent"))
        if form in (SML_JSON, swe.JSON):
            kind = "SimpleProcess" if s["asset"] in ("Process", "Simulation", "Other") else "PhysicalSystem"
            return {"type": kind, "id": sid, "uniqueId": s["uid"], "label": s["label"], "description": s["description"],
                    "definition": s["feature"], "assetType": s["asset"], "links": links}
        return {"type": "Feature", "id": sid, "geometry": None,
                "properties": {"featureType": s["feature"], "uid": s["uid"], "name": s["label"],
                               "description": s["description"], "assetType": s["asset"]},
                "links": links}

    def ds_json(request, d):
        rec = srv().visible(d["schema"])
        props = [{"definition": f.get("definition", ""), "label": f.get("label", f["name"]), "name": f["name"]}
                 for f in rec["fields"] if not (f["type"] == "Time" and f["name"] == "time")]
        did = d["id"]
        span = srv().time_range(d)
        span_iso = [iso(span[0]), iso(span[1])] if span else None
        now = iso(rt.now())
        times = ({"validTime": span_iso, "phenomenonTime": span_iso, "resultTime": span_iso} if span
                 else {"validTime": [now, now]})  # validTime is required by clients (OSHConnect)
        return {"id": did, "name": d["name"], "outputName": d["outputName"], "system@id": d["system"],
                "system@link": {"href": base(request) + f"/systems/{d['system']}"}, **times,
                "resultType": "record", "live": d["kind"] == "sensor", "formats": list(swe.OBS_FORMATS),
                "observedProperties": props,
                "links": [link(request, f"/datastreams/{did}", "self"),
                          link(request, f"/datastreams/{did}/schema?obsFormat=application%2Fswe%2Bjson", "schema"),
                          link(request, f"/datastreams/{did}/observations", "observations")]}

    def cs_json(request, c):
        cid = c["id"]
        return {"id": cid, "name": c["name"], "inputName": c["inputName"], "system@id": c["system"],
                "system@link": {"href": base(request) + f"/systems/{c['system']}"},
                "live": bool(rt.hub.subscribers(cid)), "async": True, "formats": [swe.JSON],
                "links": [link(request, f"/controlstreams/{cid}", "self"),
                          link(request, f"/controlstreams/{cid}/schema", "schema"),
                          link(request, f"/controlstreams/{cid}/commands", "commands")]}

    async def json_body(request: Request):
        raw = await request.body()
        try:
            return json.loads(raw or b"null")
        except json.JSONDecodeError:
            raise Refusal(400, "the request body must be JSON")

    # --- discovery (FR-23) -------------------------------------------------------------------
    @app.get("/", summary="Landing page")
    async def landing(request: Request, f: str | None = Query(None)):
        return {"title": "Canal barge weather demonstrator",
                "description": "A stand-in for OpenSensorHub's Connected Systems API. Everything is fictional.",
                "links": [link(request, "/", "self"), link(request, "/conformance", "conformance"),
                          link(request, "/collections", "data"), link(request, "/systems", "systems"),
                          link(request, "/datastreams", "datastreams"), link(request, "/controlstreams", "controlstreams")]}

    @app.get("/conformance", summary="Conformance declaration")
    async def conformance(request: Request, f: str | None = Query(None)):
        claims = list(CONFORMANCE)
        if srv().claims_profile():
            claims.append(srv().profile["id"])
        return {"conformsTo": claims}

    @app.get("/profile.json", summary="Declared profile, beside the API (FR-41)")
    async def profile(request: Request):
        return srv().profile

    COLLECTIONS = {"all_systems": ("All systems", "feature"), "all_datastreams": ("All datastreams", "Datastream")}

    def collection_json(request, cid):
        title, kind = COLLECTIONS[cid]
        # OpenSensorHub's all_systems links its items to /systems and serves no /collections/all_systems/items (D-193).
        items = "/systems" if cid == "all_systems" else f"/collections/{cid}/items"
        return {"id": cid, "title": title, "itemType": kind,
                "links": [link(request, f"/collections/{cid}", "self"), link(request, items, "items")]}

    @app.get("/collections", summary="Collections")
    async def collections(request: Request, f: str | None = Query(None)):
        return {"links": [link(request, "/collections", "self")],
                "collections": [collection_json(request, c) for c in COLLECTIONS]}

    @app.get("/collections/{collectionId}", summary="A collection")
    async def collection(request: Request, collectionId: str = Path(...)):
        if collectionId not in COLLECTIONS:
            raise Refusal(404, f"collection {collectionId} not found")
        return collection_json(request, collectionId)

    @app.get("/collections/{collectionId}/items", summary="Items of a collection")
    async def collection_items(request: Request, collectionId: str = Path(...), limit: int = Query(C.DEFAULT_LIMIT),
                               offset: int = Query(0), f: str | None = Query(None)):
        if collectionId == "all_systems":  # as OpenSensorHub answers: every system is GET /systems?searchMembers=true
            raise Refusal(400, "Invalid resource name: 'items'")
        if collectionId == "all_datastreams":
            items = [ds_json(request, d) for d in store().datastreams.values() if srv().served(d)]
            return page(items, request, f"/collections/{collectionId}/items", limit, offset)
        raise Refusal(404, f"collection {collectionId} not found")

    # --- Part 1: systems (listed whether or not the account may read them: §9.3) --------------------
    @app.get("/systems", summary="Systems: the top level, or every system with searchMembers=true (D-193)")
    async def systems(request: Request, limit: int = Query(C.DEFAULT_LIMIT), offset: int = Query(0),
                      f: str | None = Query(None), searchMembers: bool = Query(False)):
        form = fmt(f, GEO_JSON, (GEO_JSON, SML_JSON, swe.JSON))
        items = [system_json(request, s, form) for s in store().systems.values() if searchMembers or not s["parent"]]
        return page(items, request, "/systems" + ("?searchMembers=true" if searchMembers else ""), limit, offset)

    @app.get("/systems/{systemId}", summary="A system")
    async def system(request: Request, systemId: str = Path(...), f: str | None = Query(None)):
        form = fmt(f, GEO_JSON, (GEO_JSON, SML_JSON, swe.JSON))
        s = get_system(systemId)
        readable(request, systemId)
        return system_json(request, s, form, listed=False)

    @app.get("/systems/{systemId}/subsystems", summary="Subsystems")
    async def subsystems(request: Request, systemId: str = Path(...), limit: int = Query(C.DEFAULT_LIMIT),
                         offset: int = Query(0), f: str | None = Query(None)):
        form = fmt(f, GEO_JSON, (GEO_JSON, SML_JSON, swe.JSON))
        get_system(systemId)
        readable(request, systemId)
        items = [system_json(request, s, form) for s in store().systems.values() if s["parent"] == systemId]
        return page(items, request, f"/systems/{systemId}/subsystems", limit, offset)

    def system_from_body(body) -> dict:
        if not isinstance(body, dict):
            raise Refusal(400, "a system must be SensorML JSON or a GeoJSON feature")
        props = body.get("properties") if isinstance(body.get("properties"), dict) else {}
        uid = body.get("uniqueId") or props.get("uid")
        label = body.get("label") or body.get("name") or props.get("name")
        if not isinstance(uid, str) or not uid or not isinstance(label, str):
            raise Refusal(400, "a system needs a uniqueId and a label")
        return {"uid": uid, "label": label, "description": body.get("description") or props.get("description") or "",
                "feature": body.get("definition") or props.get("featureType") or SOSA + "System",
                "asset": body.get("assetType") or props.get("assetType") or "Process"}

    async def create_system(request: Request, parent: str | None):
        a = who(request)
        body = await json_body(request)
        # D-194: SensorML is sent as application/sml+json; anything else is read as GeoJSON, as OpenSensorHub does.
        ctype = (request.headers.get("content-type") or swe.JSON).split(";")[0].strip().lower()
        kind = body.get("type") if isinstance(body, dict) else None
        if ctype == SML_JSON and kind == "Feature":
            raise Refusal(400, "a SensorML description cannot be a GeoJSON Feature")
        if ctype != SML_JSON and kind != "Feature":
            raise Refusal(400, "The type of a GeoJSON feature must be 'Feature' (send SensorML as application/sml+json)")
        b = system_from_body(body)
        if parent is None:
            if not (a.user == "svc-importer" and b["uid"] == URN + "importer"):
                raise Refusal(403, "this account may not create a top-level system")
        else:
            chain = store().chain(parent)
            registering = (a.user in A.MODEL_SERVICES and chain[0]["uid"] == URN + "process:models"
                           and b["uid"] == f"{URN}process:{a.user[4:]}")  # a model registers under Models (FR-28)
            if not (registering or owns(chain, a)):
                raise Refusal(403, "this account may not create a system here")
        s, _ = store().add_system(b["uid"], b["label"], b["description"], b["feature"], b["asset"], parent=parent,
                                  owner=a.user)
        return Response(status_code=201, headers={"Location": base(request) + f"/systems/{s['id']}"})

    @app.post("/systems", status_code=201, summary="Create a system (SensorML as application/sml+json, D-194)",
              openapi_extra={"requestBody": {"required": True, "content": {
                  SML_JSON: {"schema": {"type": "object"}}, GEO_JSON: {"schema": {"type": "object"}}}}})
    async def post_system(request: Request):
        return await create_system(request, None)

    @app.post("/systems/{systemId}/subsystems", status_code=201,
              summary="Create a subsystem (a model registers; SensorML as application/sml+json, D-194)",
              openapi_extra={"requestBody": {"required": True, "content": {
                  SML_JSON: {"schema": {"type": "object"}}, GEO_JSON: {"schema": {"type": "object"}}}}})
    async def post_subsystem(request: Request, systemId: str = Path(...)):
        get_system(systemId)
        readable(request, systemId)
        return await create_system(request, systemId)

    # --- Part 2: datastreams and observations --------------------------------------------------
    @app.get("/datastreams", summary="Datastreams")
    async def datastreams(request: Request, limit: int = Query(C.DEFAULT_LIMIT), offset: int = Query(0)):
        items = [ds_json(request, d) for d in store().datastreams.values() if srv().served(d)]
        return page(items, request, "/datastreams", limit, offset)

    @app.get("/systems/{systemId}/datastreams", summary="A system's datastreams")
    async def system_datastreams(request: Request, systemId: str = Path(...), limit: int = Query(C.DEFAULT_LIMIT),
                                 offset: int = Query(0)):
        get_system(systemId)
        items = [ds_json(request, d) for d in store().datastreams.values() if d["system"] == systemId and srv().served(d)]
        return page(items, request, f"/systems/{systemId}/datastreams", limit, offset)

    @app.get("/datastreams/{dsId}", summary="A datastream")
    async def datastream(request: Request, dsId: str = Path(...)):
        d = get_ds(dsId)
        readable(request, d["system"])
        return ds_json(request, d)

    @app.get("/datastreams/{dsId}/schema", summary="A datastream's schema")
    async def ds_schema(request: Request, dsId: str = Path(...), obsFormat: str | None = Query(None),
                        f: str | None = Query(None)):
        d = get_ds(dsId)
        readable(request, d["system"])
        return swe.schema_response(srv().visible(d["schema"]), fmt(obsFormat or f, swe.JSON, swe.OBS_FORMATS))

    @app.post("/systems/{systemId}/datastreams", status_code=201, summary="Create a datastream")
    async def post_datastream(request: Request, systemId: str = Path(...)):
        get_system(systemId)
        readable(request, systemId)
        writable(request, systemId)
        a = who(request)
        body = await json_body(request)
        sch = body.get("schema") if isinstance(body, dict) else None
        rec = sch.get("recordSchema") if isinstance(sch, dict) else None
        out = body.get("outputName") if isinstance(body, dict) else None
        if not isinstance(rec, dict) or not isinstance(rec.get("fields"), list) or not rec["fields"] or \
                not isinstance(out, str) or not out:
            raise Refusal(400, "a datastream needs an outputName and a SWE Common DataRecord")
        if bad := bad_codes(rec):  # D-195: OpenSensorHub checks UCUM strictly
            raise Refusal(400, f"Invalid UCUM code '{bad[0]}'")
        first = rec["fields"][0]
        if first.get("type") != "Time" or first.get("name") != "time":
            raise Refusal(400, "the first field must be a Time named time")
        for fd in rec["fields"]:
            if fd.get("type") not in FIELD_TYPES or not fd.get("name"):
                raise Refusal(400, f"field {fd.get('name')}: type {fd.get('type')} is not supported")
        d, _ = store().add_datastream(systemId, out, body.get("name", out), rec, owner=a.user)
        return Response(status_code=201, headers={"Location": base(request) + f"/datastreams/{d['id']}"})

    @app.get("/datastreams/{dsId}/observations", summary="Observations")
    async def observations(request: Request, dsId: str = Path(...), phenomenonTime: str | None = Query(None),
                           resultTime: str | None = Query(None), limit: int = Query(C.DEFAULT_LIMIT),
                           offset: int = Query(0), f: str | None = Query(None)):
        d = get_ds(dsId)
        readable(request, d["system"])
        of = fmt(f, swe.JSON, swe.OBS_FORMATS)
        if limit < 1 or offset < 0:
            raise Refusal(400, "limit must be at least 1 and offset zero or more")
        lim = min(limit, C.MAX_LIMIT)  # a limit over the maximum is served, not refused (§9.1)
        latest = resultTime == "latest"
        t0, t1 = _interval(phenomenonTime) if phenomenonTime else (-math.inf, math.inf)
        if resultTime and not latest:
            r0, r1 = _interval(resultTime)
            t0, t1 = max(t0, r0), min(t1, r1)
        rec = srv().visible(d["schema"])
        names = [x["name"] for x in rec["fields"] if x["name"] != "time"]
        st = request.state
        if d["kind"] == "sensor":
            if latest:
                tr = srv().adapter.time_range(d["sensor"])
                if not tr:
                    return _obs_response(request, d, rec, {"t": np.empty(0)}, of, lim, offset, 0)
                t0 = t1 = tr[1]
            raw = [n for n in names if not n.endswith("_qc")]
            cols = srv().sensor_records(d["sensor"], t0, min(t1, rt.now()), lim, offset, fields=raw,
                                        why=f"{st.model} read" if st.model else "observation request", quiet=st.quiet)
        else:
            ser = d["series"]
            if latest:
                i = ser.latest()
                idx = np.array([] if i is None else [i], dtype=int)
            else:
                i0, i1 = ser.range(t0, t1)
                idx = np.arange(i0 + offset, min(i1, i0 + offset + lim))
            cols = ser.take(idx, names)
        return _obs_response(request, d, rec, cols, of, lim, offset, len(cols["t"]))

    @app.post("/datastreams/{dsId}/observations", status_code=201, summary="Publish one observation")
    async def post_observation(request: Request, dsId: str = Path(...)):
        d = get_ds(dsId, hidden=True)  # a datastream not served still takes its model's observations (FR-52)
        readable(request, d["system"])
        writable(request, d["system"])
        if d["kind"] == "sensor":
            raise Refusal(405, "a sensor's observations come from the logger store, not from clients")
        body = await json_body(request)
        if not isinstance(body, dict):
            raise Refusal(400, "one observation per request: the body must be one JSON object")
        if "result" in body and isinstance(body["result"], dict):  # application/json observation resource
            t, values = body.get("phenomenonTime"), body["result"]
        else:  # application/swe+json record
            t, values = body.get("time"), {k: v for k, v in body.items() if k != "time"}
        if not isinstance(t, str):
            raise Refusal(400, "an observation needs its time (ISO 8601, UTC)")
        try:
            tt = parse_iso(t)
        except ValueError as e:
            raise Refusal(400, f"time: {e}")
        types = {fd["name"]: fd["type"] for fd in d["schema"]["fields"] if fd["name"] != "time"}
        row = {}
        for k, v in values.items():
            ty = types.get(k)
            if ty is None:
                raise Refusal(400, f"field {k} is not in the datastream's schema")
            row[k] = _decode(k, ty, v)
        store().append_row(d, tt, row)
        return Response(status_code=201, headers={"Location": base(request) + f"/datastreams/{dsId}/observations"})

    # --- Part 2: control streams and commands -------------------------------------------------------
    @app.get("/controlstreams", summary="Control streams")
    async def controlstreams(request: Request, limit: int = Query(C.DEFAULT_LIMIT), offset: int = Query(0)):
        items = [cs_json(request, c) for c in store().controlstreams.values() if not c["replaced"]]
        return page(items, request, "/controlstreams", limit, offset)

    @app.get("/systems/{systemId}/controlstreams", summary="A system's control streams")
    async def system_controlstreams(request: Request, systemId: str = Path(...), limit: int = Query(C.DEFAULT_LIMIT),
                                    offset: int = Query(0)):
        get_system(systemId)
        items = [cs_json(request, c) for c in store().controlstreams.values() if c["system"] == systemId and not c["replaced"]]
        return page(items, request, f"/systems/{systemId}/controlstreams", limit, offset)

    @app.get("/controlstreams/{csId}", summary="A control stream")
    async def controlstream(request: Request, csId: str = Path(...)):
        c = get_cs(csId)
        readable(request, c["system"])
        return cs_json(request, c)

    @app.get("/controlstreams/{csId}/schema", summary="A control stream's schema, with its bounds")
    async def controlstream_schema(request: Request, csId: str = Path(...)):
        c = get_cs(csId)
        readable(request, c["system"])
        return {"commandFormat": swe.JSON, "parametersSchema": c["schema"]}

    @app.post("/systems/{systemId}/controlstreams", status_code=201, summary="Create a control stream")
    async def post_controlstream(request: Request, systemId: str = Path(...)):
        get_system(systemId)
        readable(request, systemId)
        writable(request, systemId)
        a = who(request)
        body = await json_body(request)
        sch = body.get("schema") if isinstance(body, dict) else None
        rec = sch.get("parametersSchema") if isinstance(sch, dict) else None
        name = body.get("inputName") if isinstance(body, dict) else None
        if not isinstance(rec, dict) or not isinstance(rec.get("fields"), list) or not isinstance(name, str) or not name:
            raise Refusal(400, "a control stream needs an inputName and a SWE Common DataRecord of parameters")
        if bad := bad_codes(rec):  # D-195
            raise Refusal(400, f"Invalid UCUM code '{bad[0]}'")
        c, _ = store().add_controlstream(systemId, name, body.get("name", name), rec, owner=a.user)
        return Response(status_code=201, headers={"Location": base(request) + f"/controlstreams/{c['id']}"})

    def command_json(request, cmd) -> dict:
        return {"id": cmd["id"], "controlstream@id": cmd["controlstream@id"], "issueTime": cmd["issueTime"],
                "parameters": cmd["parameters"], "sender": cmd["sender"],
                "currentStatus": cmd["status"][-1]["statusCode"] if cmd["status"] else "PENDING",
                "links": [link(request, f"/commands/{cmd['id']}/status", "status")]}

    @app.post("/controlstreams/{csId}/commands", summary="Send a command (pushed to subscribers)")
    async def post_command(request: Request, csId: str = Path(...)):
        c = get_cs(csId)
        readable(request, c["system"])  # every user may command what it may read (§9.3)
        a = who(request)
        body = await json_body(request)
        params = body.get("parameters") if isinstance(body, dict) else None
        if not isinstance(params, dict):
            raise Refusal(400, "a command needs a parameters object")
        names = [fd["name"] for fd in c["schema"]["fields"]]
        missing = [n for n in names if n not in params]
        unknown = [k for k in params if k not in names]
        if missing or unknown:  # every parameter, on every command (as OpenSensorHub requires); bounds are the receiver's
            raise Refusal(400, f"a command carries every parameter: missing {missing}, unknown {unknown}")
        st = store()
        cid = st.ids.next("command")
        cmd = {"id": cid, "controlstream@id": csId, "issueTime": iso_real(rt.real()), "parameters": params,
               "sender": a.user, "status": []}
        pushed = {"id": cid, "parameters": params, "issueTime": cmd["issueTime"], "sender": a.user}
        if not rt.hub.subscribers(csId):
            await asyncio.sleep(rt.hold_s)  # dropped: nobody listens (§9.1)
            return Response("Accepted, but the request timed out: no receiver is subscribed", status_code=202,
                            media_type="text/plain")
        st.commands[cid] = cmd
        rt.push(c, pushed)
        await asyncio.sleep(rt.hold_s)  # the sender never waits on this answer (FR-27, AT-39)
        # OpenSensorHub stores the sender's PENDING as it answers, often after the receiver's COMPLETED: readers
        # take a command's outcome as its latest report other than PENDING (D-199)
        rt.command_status(cid, "PENDING")
        out = dict(command_json(request, cmd), currentStatus="PENDING")
        return JSONResponse(out, status_code=200, headers={"Location": base(request) + f"/commands/{cid}"})

    @app.get("/controlstreams/{csId}/commands", summary="Commands sent; with subscribe=1, a push subscription (NDJSON)")
    async def get_commands(request: Request, csId: str = Path(...), subscribe: str | None = Query(None),
                           limit: int = Query(C.DEFAULT_LIMIT), offset: int = Query(0)):
        c = get_cs(csId)
        readable(request, c["system"])
        if subscribe not in (None, "", "0", "false"):
            s = request.state
            if not s.internal:  # OpenSensorHub closes public subscriptions with access control on (D-223)
                raise Refusal(403, f"subscribe on the internal endpoint ({INTERNAL}), as a service account")
            sub = rt.hub.subscribe(Subscription(c["id"], s.account, s.model))  # registered before the answer

            async def lines():
                try:
                    while True:
                        cmd = await sub.queue.get()
                        if cmd is None:
                            return
                        yield (json.dumps(cmd, separators=(",", ":")) + "\n").encode()
                finally:
                    rt.hub.unsubscribe(sub)
            return StreamingResponse(lines(), media_type=NDJSON, headers={"cache-control": "no-store"})
        items = [command_json(request, x) for x in store().commands.values() if x["controlstream@id"] == csId]
        return page(items, request, f"/controlstreams/{csId}/commands", limit, offset)

    @app.post("/controlstreams/{csId}/status", status_code=201, summary="Report a command's status (its receiver)")
    async def post_status(request: Request, csId: str = Path(...)):
        c = get_cs(csId)
        readable(request, c["system"])
        writable(request, c["system"])
        body = await json_body(request)
        if not isinstance(body, dict):
            raise Refusal(400, "a status report is a JSON object")
        cid, code = body.get("command@id"), body.get("statusCode")
        cmd = store().commands.get(cid)
        if cmd is None or cmd["controlstream@id"] != csId:
            raise Refusal(400, f"command {cid} is not one of this control stream's")
        if code not in COMMAND_STATUSES:
            raise Refusal(400, f"statusCode must be one of {', '.join(COMMAND_STATUSES)}")
        rt.command_status(cid, code, str(body.get("message") or ""))
        return Response(status_code=201, headers={"Location": base(request) + f"/commands/{cid}/status"})

    @app.get("/controlstreams/{csId}/status", summary="Status reports of a control stream's commands")
    async def get_status(request: Request, csId: str = Path(...), limit: int = Query(C.DEFAULT_LIMIT),
                         offset: int = Query(0)):
        c = get_cs(csId)
        readable(request, c["system"])
        return page(list(store().status_reports.get(csId, [])), request, f"/controlstreams/{csId}/status", limit, offset)

    def get_cmd(request, cmdId):
        cmd = store().commands.get(cmdId)
        if cmd is None:
            raise Refusal(404, f"command {cmdId} not found")
        readable(request, get_cs(cmd["controlstream@id"])["system"])
        return cmd

    @app.get("/commands/{cmdId}", summary="A command")
    async def command(request: Request, cmdId: str = Path(...)):
        return command_json(request, get_cmd(request, cmdId))

    @app.get("/commands/{cmdId}/status", summary="A command's status reports")
    async def command_status(request: Request, cmdId: str = Path(...)):
        return {"items": get_cmd(request, cmdId)["status"]}

    # --- scaffolding, not part of the system --------------------------------------------------------
    @app.post(REFEREE + "/{kind}", summary="Score a result against the manifest (demonstrator scaffolding)",
              tags=["demonstrator"])
    async def referee(request: Request, kind: str = Path(...)):
        """Scored here, outside the model: a model never sees the manifest or the position (FR-37)."""
        payload = await json_body(request)
        w = rt.world
        try:
            if kind == "changes":
                det = {"t": np.asarray(payload["t"], dtype=float), "scale": np.asarray(payload["scale"], dtype=int)}
                r = scoring.score_changes(w, det, float(payload["t0"]), float(payload["t1"]))
                return {k: (None if v is None else float(v)) for k, v in r.items()}
            if kind == "clusters":
                t = np.asarray(payload["t"], dtype=float)
                if len(t) < 2:
                    return {"ari_air_mass": None, "ari_reach_kind": None}
                r = scoring.score_clusters(w, t, np.asarray(payload["labels"]))
                return {k: (None if not np.isfinite(v) else float(v)) for k, v in r.items()}
        except (KeyError, TypeError, ValueError) as e:
            raise Refusal(400, f"referee: {e}")
        raise Refusal(404, f"the referee scores changes and clusters, not {kind}")

    # --- everything else ----------------------------------------------------------------------------
    @app.api_route("/{rest:path}", methods=["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"],
                   include_in_schema=False)
    async def refuse(request: Request, rest: str):
        if request.method in ("PUT", "PATCH", "DELETE"):  # nothing is replaced or deleted (D-224)
            raise Refusal(405, f"{request.method} is not allowed: nothing is replaced or deleted")
        if request.method != "GET":
            raise Refusal(405, f"{request.method} /{rest} is not allowed")
        raise Refusal(404, f"no resource at /{rest}")

    return Gate(app, rt)


# --- module helpers -----------------------------------------------------------------------------

def _interval(text: str):
    try:
        if "/" in text:
            a, b = text.split("/", 1)
            t0 = -math.inf if a in ("", "..") else parse_iso(a)
            t1 = math.inf if b in ("", "..", "now") else parse_iso(b)
        else:
            t0 = t1 = parse_iso(text)
    except ValueError as e:
        raise Refusal(400, f"time interval: {e}")
    if t1 < t0:
        raise Refusal(400, "time interval: it ends before it starts")
    return t0, t1


def _decode(name: str, ty: str, v):
    """One published value, as stored: numbers as float (NaN missing), times as simulated seconds."""
    if ty == "Quantity":
        if v == "NaN":
            return np.nan
        if v is None or isinstance(v, bool) or not isinstance(v, (int, float)):
            raise Refusal(400, f"{name}: a Quantity is a number or \"NaN\", not {json.dumps(v)}")
        return float(v)
    if ty == "Count":  # OpenSensorHub refuses both "NaN" and null in a Count (D-197)
        if isinstance(v, bool) or not isinstance(v, (int, float)) or int(v) != v:
            raise Refusal(400, f"{name}: a Count is a whole number")
        return float(v)
    if ty == "Boolean":
        if v is None:
            return np.nan
        if not isinstance(v, bool):
            raise Refusal(400, f"{name}: a Boolean is true or false")
        return 1.0 if v else 0.0
    if ty == "Time":
        if v in (None, ""):
            return np.nan
        try:
            return parse_iso(v)
        except (ValueError, TypeError, AttributeError):
            raise Refusal(400, f"{name}: not an ISO 8601 time")
    if v is not None and not isinstance(v, str):
        raise Refusal(400, f"{name}: a {ty} is text")
    return v


def _column(fd: dict, v, sensor: bool) -> list:
    ty = fd["type"]
    v = np.asarray(v)
    if ty == "Quantity":
        f = np.round(v.astype(float), PRECISION)
        out = f.tolist()
        return ["NaN" if x != x else x for x in out] if np.isnan(f).any() else out
    if ty == "Count":
        return ["NaN" if x != x else int(x) for x in v.astype(float).tolist()]
    if ty == "Boolean":
        return [None if x != x else bool(x) for x in v.astype(float).tolist()]
    if ty == "Time":
        f = v.astype(float)
        out = [None] * len(f)
        ok = np.isfinite(f)
        for i, s in zip(np.flatnonzero(ok).tolist(), iso_many(f[ok])):
            out[i] = s
        return out
    if sensor and ty == "Category" and v.dtype != object:  # the adapter's coded columns
        if fd["name"].endswith("_qc"):
            return [None if x != x else str(int(x)) for x in v.astype(float).tolist()]
        tokens = (fd.get("constraint") or {}).get("values") or []
        return [None if x != x else tokens[int(x)] for x in v.astype(float).tolist()]
    return [None if (isinstance(x, float) and x != x) else x for x in v.tolist()]


def _obs_response(request, d, rec, cols, of, limit, offset, n):
    fields = [x for x in rec["fields"] if x["name"] != "time" and x["name"] in cols]
    times = iso_many(cols["t"]) if len(cols["t"]) else []
    names = [x["name"] for x in fields]
    sensor = d["kind"] == "sensor"
    columns = [_column(x, cols[x["name"]], sensor) for x in fields]
    if of == swe.SWE_JSON:  # an array of records, time first; no next link (§9.1)
        rows = [dict(zip(["time"] + names, vals)) for vals in zip(times, *columns)]
        return Response(json.dumps(rows, separators=(",", ":"), allow_nan=False), media_type=swe.SWE_JSON)
    root = str(request.base_url).rstrip("/")
    items = [{"id": f"{d['id']}-{offset + i}", "datastream@id": d["id"], "phenomenonTime": tt, "resultTime": tt,
              "result": dict(zip(names, vals))} for i, (tt, *vals) in enumerate(zip(times, *columns))]
    path = f"/datastreams/{d['id']}/observations"
    links = [{"href": f"{root}{path}", "rel": "self"}]
    if n == limit:
        q = dict(request.query_params)
        q.update({"limit": str(limit), "offset": str(offset + limit)})
        links.append({"href": f"{root}{path}?" + "&".join(f"{k}={v}" for k, v in q.items()), "rel": "next"})
    return JSONResponse({"items": items, "links": links})

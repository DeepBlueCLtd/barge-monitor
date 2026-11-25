"""The data server's HTTP interface: a stand-in for OpenSensorHub (FR-06c, FR-38a; §9 of the interfaces).

An ordinary ASGI application on FastAPI: it runs unchanged under uvicorn and in Pyodide
(NFR-03). It **behaves as a stock OpenSensorHub** wherever this system relies on it (§9.1):

* opaque identifiers; ``POST`` creating what exists answers ``201`` with the existing ``Location``;
* one observation per ``POST`` (an array is ``400``); a missing value is ``"NaN"`` (``null`` in a
  Quantity is ``400``); ``PUT`` and ``DELETE`` answer ``405``;
* the format is chosen with ``f=``; ``Accept`` is ignored; paging by ``limit`` and ``offset``, no
  ``next`` link in SWE JSON; a ``limit`` over the maximum is served;
* refusals are HTML pages; no instance identifier and no ``503`` (while starting or down the
  server answers nothing: ``ServerUnavailable``);
* commands are **pushed** to subscribers (``?subscribe=1``, a never-ending NDJSON stream, §9.2);
  without one a command is dropped and answered ``202`` after about 5 s; with one it is answered
  ``200`` after about 5 s; status is posted to ``/controlstreams/{id}/status``;
* ``/profile.json`` beside the API (FR-41).

**Authentication** (§9.3, §9.5): every request needs ``Authorization: Basic``; without valid
credentials ``401`` with ``WWW-Authenticate: basic``, as OpenSensorHub answers. The server applies
no permission per system: every request reaches it through the access gateway (``gateway.py``),
which does. The importer and the replay controller are modules inside it and use no HTTP.

One thing here is not OpenSensorHub and says so: ``/demonstrator/referee`` (scaffolding: the only
code that reads the manifest, FR-37).
"""
from __future__ import annotations

import asyncio
import html
import json
import math

import numpy as np
from fastapi import FastAPI, Path, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response, StreamingResponse

from . import config as C
from . import scoring
from . import swe
from .store import Subscription
from .times import iso, iso_many, parse_iso, world_seconds

SOSA = "http://www.w3.org/ns/sosa/"
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
NDJSON = "application/x-ndjson"
SML_JSON = "application/sml+json"
GEO_JSON = "application/geo+json"
FORMATS = {"json": swe.JSON, swe.JSON: swe.JSON, "swe+json": swe.SWE_JSON, swe.SWE_JSON: swe.SWE_JSON,
           "sml+json": SML_JSON, SML_JSON: SML_JSON, "geojson": GEO_JSON, GEO_JSON: GEO_JSON}
SHOWN_BYTES = 4 * 4000  # what a captured message shows of a body (the tap clips it further)


class ServerUnavailable(Exception):
    """The server is starting or down: no answer at all (the relay reports a network failure)."""


class Refusal(Exception):
    def __init__(self, status: int, description: str, headers=None):
        super().__init__(description)
        self.status, self.description, self.headers = status, description, headers or {}


def refusal_page(status: int, description: str, headers=None) -> Response:
    """A refusal is an HTML page, as OpenSensorHub's are; no client may rely on its body (FR-30)."""
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


class Gate:
    """The server's front: lifecycle (no answer while starting or down), Freeze, authentication, capture.

    A pure ASGI middleware around the FastAPI application, so that a push subscription streams
    through it. Every request it sees has come through the access gateway, so it is captured as
    ``gateway → server`` and ``server → gateway``. Nothing is decided by the capture headers (§2).
    """

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
        await rt.wait_unfrozen()  # Freeze: held, unanswered, released in order (§4)
        if not rt.running:
            raise ServerUnavailable()
        tap = rt.tap
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
        root = scope.get("root_path", "") or ""
        path = scope["path"]
        rel = (path[len(root):] if root and path.startswith(root) else path) or "/"
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
        acct = rt.accounts.authenticate(headers.get("authorization"))
        model = headers.get("x-tap-model") or None
        quiet = headers.get("x-tap-quiet") == "1"
        who = "gateway"  # nothing reaches the server but through the gateway (§9.5)
        origin = "models" if model else (acct.component if acct and acct.component in ("client", "models") else "client")
        hop = headers.get("x-tap-hop", "1")
        token = tap.begin_chain(headers.get("x-tap-chain"), int(hop) if hop.isdigit() else 1)
        ask = f"{method} {rel}{'?' + query if query else ''}"
        shown = ask + (f"\nAuthorization: {headers['authorization']}" if "authorization" in headers else "") + \
            ("\n\n" + _shown(body) if body else "")
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
            summary = f"{status} {rel}" + (" (subscribed)" if streamed else "")
            tap.emit("server", who, _letter_for_response(status, rel, ctype), f"{model}: {summary}" if model else summary,
                     "push subscription open: commands follow as they are sent" if streamed else _shown(payload),
                     model=model, quiet=quiet)
            tap.end_chain(t2)
            token = tap.begin_chain(chain_id, hops + 2)
            await send({"type": "http.response.start", "status": status, "headers": out_headers})

        if acct is None:
            r = refusal_page(401, "valid credentials are needed", {"WWW-Authenticate": "basic"})
            await respond(401, list(r.raw_headers), r.body)
            await send({"type": "http.response.body", "body": r.body})
            tap.end_chain(token)
            return

        inner = dict(scope)
        inner["state"] = {"account": acct, "model": model, "quiet": quiet, "who": who, "origin": origin}
        delivered = False
        disconnected = asyncio.Event()

        async def inner_receive():
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": body, "more_body": False}
            await receive_disconnect()
            return {"type": "http.disconnect"}

        async def receive_disconnect():
            # The client's own disconnect, if its transport reports one.
            while True:
                m = await receive()
                if m["type"] == "http.disconnect":
                    disconnected.set()
                    return

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

        try:
            await self.app(inner, inner_receive, inner_send)
        finally:
            tap.end_chain(token)


def create_app(rt):
    """What clients reach: the access gateway in front of the data server (§9.5). Under uvicorn or in
    Pyodide, the same object (NFR-03)."""
    from .gateway import Gateway

    return Gateway(create_server(rt), rt)


def create_server(rt) -> Gate:
    """The data server's stand-in alone, as OpenSensorHub would be behind the gateway."""
    app = FastAPI(
        title="Canal barge weather demonstrator: data server stand-in (OpenSensorHub)",
        version="4.6.0",
        description=("What this system needs of a Connected Systems server (OGC API – Connected Systems Parts 1 and 2), "
                     "as a stand-in that behaves as a stock OpenSensorHub does (FR-06c). Every request needs "
                     "Basic credentials. Everything is fictional."),
        openapi_url=None, docs_url=None, redoc_url=None,
    )
    store = lambda: rt.store  # noqa: E731 - Reset instance replaces the store

    @app.exception_handler(Refusal)
    async def refusal_handler(_request, exc: Refusal):
        return refusal_page(exc.status, exc.description, exc.headers)

    @app.exception_handler(RequestValidationError)
    async def validation_handler(_request, exc: RequestValidationError):
        err = exc.errors()[0] if exc.errors() else {}
        return refusal_page(400, f"{err.get('loc', ['?'])[-1]}: {err.get('msg', 'invalid')}")

    # --- helpers -------------------------------------------------------------------------
    def who(request: Request):
        return request.state.account

    def base(request: Request) -> str:
        return str(request.base_url).rstrip("/")

    def link(request, href, rel, type_="application/json", title=None):
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
            links.append(link(request, f"{path}?limit={limit}&offset={offset + limit}", "next"))
        return {"items": chunk, "links": links}

    def fmt(f: str | None, default: str, allowed: tuple) -> str:
        if f is None:
            return default
        norm = FORMATS.get(f.strip())
        if norm not in allowed:
            raise Refusal(400, f"format {f} is not offered here; offered: {', '.join(allowed)}")
        return norm

    def visible(request) -> list[dict]:
        return list(store().systems.values())

    def get_system(request, sid) -> dict:
        s = store().systems.get(sid)
        if s is None:
            raise Refusal(404, f"system {sid} not found")
        return s

    def served_schema(d) -> dict:
        off = rt.live_offering
        rec = d["schema"]
        return dict(rec, fields=[f for f in rec["fields"] if f["name"] == "time" or off.keep(f["name"])])

    def served(d) -> bool:
        return not d["replaced"] and len(served_schema(d)["fields"]) > 1  # every output off: not served (FR-52)

    def get_ds(request, dsid, hidden=False) -> dict:
        d = store().datastreams.get(dsid)
        if d is None or not (hidden or served(d)):
            raise Refusal(404, f"datastream {dsid} not found")
        return d

    def get_cs(request, csid) -> dict:
        c = store().controlstreams.get(csid)
        if c is None or c["replaced"]:
            raise Refusal(404, f"control stream {csid} not found")
        return c

    def system_json(request, s, form):
        sid = s["id"]
        links = [link(request, f"/systems/{sid}", "self"), link(request, f"/systems/{sid}/datastreams", "datastreams"),
                 link(request, f"/systems/{sid}/subsystems", "subsystems"),
                 link(request, f"/systems/{sid}/controlstreams", "controlstreams")]
        if s["parent"]:
            links.append(link(request, f"/systems/{s['parent']}", "parent"))
        if form == SML_JSON:
            out = {"type": "SimpleProcess" if s["asset"] in ("Process", "Simulation", "Other") or "System" in s["feature"]
                   else "PhysicalSystem", "id": sid, "uniqueId": s["uid"], "label": s["label"],
                   "description": s["description"], "definition": s["feature"], "assetType": s["asset"]}
            if s["characteristics"]:
                out["characteristics"] = [{"label": "Replay", "characteristics": [
                    {"type": "Quantity", "name": k, "label": "Highest replay rate sustained", "uom": {"code": "1"},
                     "value": v} for k, v in s["characteristics"].items()]}]
            out["links"] = links
            return out
        return {"type": "Feature", "id": sid, "geometry": None,
                "properties": {"featureType": s["feature"], "uid": s["uid"], "name": s["label"],
                               "description": s["description"], "assetType": s["asset"]},
                "links": links}

    def ds_json(request, d):
        span = d["series"].span()
        rec = served_schema(d)
        props = [{"definition": f.get("definition", ""), "label": f.get("label", f["name"]), "name": f["name"]}
                 for f in rec["fields"] if not (f["type"] == "Time" and f["name"] == "time")]
        did = d["id"]
        return {"id": did, "name": d["name"], "outputName": d["outputName"], "system@id": d["system"],
                "system@link": {"href": base(request) + f"/systems/{d['system']}"},
                "validTime": [iso(span[0]) if span else iso(rt.real()), "now"],
                "phenomenonTime": [iso(span[0]), iso(span[1])] if span else None,
                "resultTime": [iso(span[0]), iso(span[1])] if span else None,
                "resultType": "record", "live": False, "formats": list(swe.OBS_FORMATS), "observedProperties": props,
                "links": [link(request, f"/datastreams/{did}", "self"),
                          link(request, f"/datastreams/{did}/schema?obsFormat=application%2Fswe%2Bjson", "schema"),
                          link(request, f"/datastreams/{did}/observations", "observations")]}

    def cs_json(request, c):
        cid = c["id"]
        return {"id": cid, "name": c["name"], "inputName": c["inputName"], "system@id": c["system"],
                "system@link": {"href": base(request) + f"/systems/{c['system']}"}, "live": True, "async": True,
                "formats": [swe.JSON],
                "links": [link(request, f"/controlstreams/{cid}", "self"),
                          link(request, f"/controlstreams/{cid}/schema", "schema"),
                          link(request, f"/controlstreams/{cid}/commands", "commands")]}

    async def json_body(request: Request):
        raw = await request.body()
        try:
            return json.loads(raw or b"null")
        except json.JSONDecodeError:
            raise Refusal(400, "the request body must be JSON")

    # --- discovery (FR-23) --------------------------------------------------------------------
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
        if rt.claims_profile():
            claims.append(rt.profile["id"])
        return {"conformsTo": claims}

    @app.get("/profile.json", summary="Declared profile, beside the API (FR-41)")
    async def profile(request: Request):
        return rt.profile

    COLLECTIONS = {"all_systems": ("All systems", "feature"), "all_datastreams": ("All datastreams", "Datastream")}

    def collection_json(request, cid):
        title, kind = COLLECTIONS[cid]
        return {"id": cid, "title": title, "itemType": kind,
                "links": [link(request, f"/collections/{cid}", "self"), link(request, f"/collections/{cid}/items", "items")]}

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
        if collectionId == "all_systems":
            form = fmt(f, GEO_JSON, (GEO_JSON, SML_JSON, swe.JSON))
            items = [system_json(request, s, form) for s in visible(request)]
            return page(items, request, f"/collections/{collectionId}/items", limit, offset)
        if collectionId == "all_datastreams":
            items = [ds_json(request, d) for d in store().datastreams.values() if served(d)]
            return page(items, request, f"/collections/{collectionId}/items", limit, offset)
        raise Refusal(404, f"collection {collectionId} not found")

    # --- Part 1: systems --------------------------------------------------------------------
    @app.get("/systems", summary="Systems (top level)")
    async def systems(request: Request, limit: int = Query(C.DEFAULT_LIMIT), offset: int = Query(0),
                      f: str | None = Query(None)):
        form = fmt(f, GEO_JSON, (GEO_JSON, SML_JSON, swe.JSON))
        items = [system_json(request, s, form) for s in visible(request) if not s["parent"]]
        return page(items, request, "/systems", limit, offset)

    @app.get("/systems/{systemId}", summary="A system")
    async def system(request: Request, systemId: str = Path(...), f: str | None = Query(None)):
        form = fmt(f, GEO_JSON, (GEO_JSON, SML_JSON, swe.JSON))
        return system_json(request, get_system(request, systemId), form)

    @app.get("/systems/{systemId}/subsystems", summary="Subsystems")
    async def subsystems(request: Request, systemId: str = Path(...), limit: int = Query(C.DEFAULT_LIMIT),
                         offset: int = Query(0), f: str | None = Query(None)):
        form = fmt(f, GEO_JSON, (GEO_JSON, SML_JSON, swe.JSON))
        get_system(request, systemId)
        items = [system_json(request, s, form) for s in visible(request) if s["parent"] == systemId]
        return page(items, request, f"/systems/{systemId}/subsystems", limit, offset)

    def system_from_body(body) -> dict:
        if not isinstance(body, dict):
            raise Refusal(400, "a system must be SensorML JSON or a GeoJSON feature")
        props = body.get("properties") if isinstance(body.get("properties"), dict) else {}
        uid = body.get("uniqueId") or props.get("uid")
        label = body.get("label") or body.get("name") or props.get("name")
        if not isinstance(uid, str) or not uid or not isinstance(label, str):
            raise Refusal(400, "a system needs a uniqueId and a label")
        chars = {}

        def walk(x):
            if isinstance(x, dict):
                if x.get("name") == "max_rate" and "value" in x:
                    chars["max_rate"] = float(x["value"])
                for v in x.values():
                    walk(v)
            elif isinstance(x, list):
                for v in x:
                    walk(v)
        walk(body.get("characteristics"))
        return {"uid": uid, "label": label, "description": body.get("description") or props.get("description") or "",
                "feature": body.get("definition") or props.get("featureType") or SOSA + "System",
                "asset": body.get("assetType") or props.get("assetType") or "Process", "characteristics": chars}

    async def create_system(request: Request, parent: str | None):
        a = who(request)
        b = system_from_body(await json_body(request))
        s, _ = store().add_system(b["uid"], b["label"], b["description"], b["feature"], b["asset"], parent=parent,
                                  owner=a.user, characteristics=b["characteristics"])
        return Response(status_code=201, headers={"Location": base(request) + f"/systems/{s['id']}"})

    @app.post("/systems", status_code=201, summary="Create a system")
    async def post_system(request: Request):
        return await create_system(request, None)

    @app.post("/systems/{systemId}/subsystems", status_code=201, summary="Create a subsystem (a model registers)")
    async def post_subsystem(request: Request, systemId: str = Path(...)):
        get_system(request, systemId)
        return await create_system(request, systemId)

    # --- Part 2: datastreams and observations ----------------------------------------------------
    @app.get("/datastreams", summary="Datastreams")
    async def datastreams(request: Request, limit: int = Query(C.DEFAULT_LIMIT), offset: int = Query(0)):
        items = [ds_json(request, d) for d in store().datastreams.values() if served(d)]
        return page(items, request, "/datastreams", limit, offset)

    @app.get("/systems/{systemId}/datastreams", summary="A system's datastreams")
    async def system_datastreams(request: Request, systemId: str = Path(...), limit: int = Query(C.DEFAULT_LIMIT),
                                 offset: int = Query(0)):
        get_system(request, systemId)
        items = [ds_json(request, d) for d in store().datastreams.values() if d["system"] == systemId and served(d)]
        return page(items, request, f"/systems/{systemId}/datastreams", limit, offset)

    @app.get("/datastreams/{dsId}", summary="A datastream")
    async def datastream(request: Request, dsId: str = Path(...)):
        return ds_json(request, get_ds(request, dsId))

    @app.get("/datastreams/{dsId}/schema", summary="A datastream's schema")
    async def ds_schema(request: Request, dsId: str = Path(...), obsFormat: str | None = Query(None),
                        f: str | None = Query(None)):
        d = get_ds(request, dsId)
        return swe.schema_response(served_schema(d), fmt(obsFormat or f, swe.JSON, swe.OBS_FORMATS))

    @app.post("/systems/{systemId}/datastreams", status_code=201, summary="Create a datastream")
    async def post_datastream(request: Request, systemId: str = Path(...)):
        get_system(request, systemId)
        a = who(request)
        body = await json_body(request)
        sch = body.get("schema") if isinstance(body, dict) else None
        rec = sch.get("recordSchema") if isinstance(sch, dict) else None
        out = body.get("outputName") if isinstance(body, dict) else None
        if not isinstance(rec, dict) or not isinstance(rec.get("fields"), list) or not rec["fields"] or \
                not isinstance(out, str) or not out:
            raise Refusal(400, "a datastream needs an outputName and a SWE Common DataRecord")
        first = rec["fields"][0]
        if first.get("type") != "Time" or first.get("name") != "time":
            raise Refusal(400, "the first field must be a Time named time")
        for fd in rec["fields"]:
            if fd.get("type") not in ("Quantity", "Count", "Category", "Boolean", "Text", "Time") or not fd.get("name"):
                raise Refusal(400, f"field {fd.get('name')}: type {fd.get('type')} is not supported")
        d, _ = store().add_datastream(systemId, out, body.get("name", out), rec, owner=a.user)
        return Response(status_code=201, headers={"Location": base(request) + f"/datastreams/{d['id']}"})

    @app.get("/datastreams/{dsId}/observations", summary="Observations")
    async def observations(request: Request, dsId: str = Path(...), phenomenonTime: str | None = Query(None),
                           resultTime: str | None = Query(None), limit: int = Query(C.DEFAULT_LIMIT),
                           offset: int = Query(0), f: str | None = Query(None)):
        d = get_ds(request, dsId)
        of = fmt(f, swe.JSON, swe.OBS_FORMATS)
        if limit < 1 or offset < 0:
            raise Refusal(400, "limit must be at least 1 and offset zero or more")
        ser = d["series"]
        if resultTime == "latest":
            i = ser.latest()
            idx = np.array([] if i is None else [i], dtype=int)
        else:
            t0, t1 = _interval(phenomenonTime) if phenomenonTime else (-math.inf, math.inf)
            if resultTime:
                r0, r1 = _interval(resultTime)
                t0, t1 = max(t0, r0), min(t1, r1)
            i0, i1 = ser.range(t0, t1)
            idx = np.arange(i0 + offset, min(i1, i0 + offset + limit))
        rec = served_schema(d)
        cols = ser.take(idx, [x["name"] for x in rec["fields"] if x["name"] != "time"])
        return _obs_response(request, d, rec, cols, of, limit, offset, len(idx))

    @app.post("/datastreams/{dsId}/observations", status_code=201, summary="Publish one observation")
    async def post_observation(request: Request, dsId: str = Path(...)):
        d = get_ds(request, dsId, hidden=True)  # a datastream not served still takes its model's observations (FR-52)
        body = await json_body(request)
        if not isinstance(body, dict):
            raise Refusal(400, "one observation per request: the body must be one JSON object")
        if "result" in body and isinstance(body["result"], dict):  # application/json observation resource
            t, values = body.get("phenomenonTime"), body["result"]
            rtime = body.get("resultTime")
        else:  # application/swe+json record
            t, values = body.get("time"), {k: v for k, v in body.items() if k != "time"}
            rtime = None
        if not isinstance(t, str):
            raise Refusal(400, "an observation needs its time (ISO 8601, UTC)")
        try:
            tt = parse_iso(t)
            rr = parse_iso(rtime) if isinstance(rtime, str) else round(rt.real(), 3)
        except ValueError as e:
            raise Refusal(400, f"time: {e}")
        types = {fd["name"]: fd["type"] for fd in d["schema"]["fields"] if fd["name"] != "time"}
        row = {}
        for k, v in values.items():
            ty = types.get(k)
            if ty is None:
                raise Refusal(400, f"field {k} is not in the datastream's schema")
            row[k] = _decode(k, ty, v)
        store().append_row(d, tt, rr, row)
        return Response(status_code=201, headers={"Location": base(request) + f"/datastreams/{dsId}/observations"})

    # --- Part 2: control streams and commands ------------------------------------------------------
    @app.get("/controlstreams", summary="Control streams")
    async def controlstreams(request: Request, limit: int = Query(C.DEFAULT_LIMIT), offset: int = Query(0)):
        items = [cs_json(request, c) for c in store().controlstreams.values() if not c["replaced"]]
        return page(items, request, "/controlstreams", limit, offset)

    @app.get("/systems/{systemId}/controlstreams", summary="A system's control streams")
    async def system_controlstreams(request: Request, systemId: str = Path(...), limit: int = Query(C.DEFAULT_LIMIT),
                                    offset: int = Query(0)):
        get_system(request, systemId)
        items = [cs_json(request, c) for c in store().controlstreams.values() if c["system"] == systemId and not c["replaced"]]
        return page(items, request, f"/systems/{systemId}/controlstreams", limit, offset)

    @app.get("/controlstreams/{csId}", summary="A control stream")
    async def controlstream(request: Request, csId: str = Path(...)):
        return cs_json(request, get_cs(request, csId))

    @app.get("/controlstreams/{csId}/schema", summary="A control stream's schema, with its bounds")
    async def controlstream_schema(request: Request, csId: str = Path(...)):
        return {"commandFormat": swe.JSON, "parametersSchema": get_cs(request, csId)["schema"]}

    @app.post("/systems/{systemId}/controlstreams", status_code=201, summary="Create a control stream")
    async def post_controlstream(request: Request, systemId: str = Path(...)):
        get_system(request, systemId)
        a = who(request)
        body = await json_body(request)
        sch = body.get("schema") if isinstance(body, dict) else None
        rec = sch.get("parametersSchema") if isinstance(sch, dict) else None
        name = body.get("inputName") if isinstance(body, dict) else None
        if not isinstance(rec, dict) or not isinstance(rec.get("fields"), list) or not isinstance(name, str) or not name:
            raise Refusal(400, "a control stream needs an inputName and a SWE Common DataRecord of parameters")
        c, _ = store().add_controlstream(systemId, name, body.get("name", name), rec, owner=a.user)
        return Response(status_code=201, headers={"Location": base(request) + f"/controlstreams/{c['id']}"})

    def command_json(request, cmd) -> dict:
        out = {"id": cmd["id"], "controlstream@id": cmd["controlstream@id"], "issueTime": cmd["issueTime"],
               "parameters": cmd["parameters"], "sender": cmd["sender"],
               "currentStatus": cmd["status"][-1]["statusCode"] if cmd["status"] else "PENDING",
               "links": [link(request, f"/commands/{cmd['id']}/status", "status")]}
        return out

    @app.post("/controlstreams/{csId}/commands", summary="Send a command (pushed to subscribers)")
    async def post_command(request: Request, csId: str = Path(...)):
        c = get_cs(request, csId)
        a = who(request)
        body = await json_body(request)
        params = body.get("parameters") if isinstance(body, dict) else None
        if not isinstance(params, dict):
            raise Refusal(400, "a command needs a parameters object")
        names = [fd["name"] for fd in c["schema"]["fields"]]
        missing = [n for n in names if n not in params]
        unknown = [k for k in params if k not in names]
        if missing or unknown:  # every parameter, on every command (as OpenSensorHub requires)
            raise Refusal(400, f"a command carries every parameter: missing {missing}, unknown {unknown}")
        st = store()
        cid = st.ids.next("command")
        cmd = {"id": cid, "controlstream@id": csId, "issueTime": iso(round(rt.real(), 3)), "parameters": params,
               "sender": a.user, "status": []}
        pushed = {"id": cid, "parameters": params, "issueTime": cmd["issueTime"], "sender": a.user}
        if not rt.hub.subscribers(csId):
            await asyncio.sleep(rt.hold_s)  # dropped: nobody listens (§9.1)
            return Response("Accepted, but the request timed out: no receiver is subscribed", status_code=202,
                            media_type="text/plain")
        st.commands[cid] = cmd
        rt.push(c, pushed)
        await asyncio.sleep(rt.hold_s)  # the sender never waits on this answer (FR-27, AT-39)
        body = dict(command_json(request, cmd), currentStatus="PENDING")
        return JSONResponse(body, status_code=200, headers={"Location": base(request) + f"/commands/{cid}"})

    @app.get("/controlstreams/{csId}/commands", summary="Commands sent; with subscribe=1, a push subscription (NDJSON)")
    async def get_commands(request: Request, csId: str = Path(...), subscribe: str | None = Query(None),
                           limit: int = Query(C.DEFAULT_LIMIT), offset: int = Query(0)):
        c = get_cs(request, csId)
        if subscribe not in (None, "", "0", "false"):
            s = request.state
            sub = rt.hub.subscribe(Subscription(c["id"], s.account, s.who, s.model))  # registered before the answer

            async def lines():
                try:
                    while True:
                        cmd = await rt.next_push(sub)
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
        get_cs(request, csId)
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
        get_cs(request, csId)
        return page(list(store().status_reports.get(csId, [])), request, f"/controlstreams/{csId}/status", limit, offset)

    def get_cmd(request, cmdId):
        cmd = store().commands.get(cmdId)
        if cmd is None:
            raise Refusal(404, f"command {cmdId} not found")
        get_cs(request, cmd["controlstream@id"])
        return cmd

    @app.get("/commands/{cmdId}", summary="A command")
    async def command(request: Request, cmdId: str = Path(...)):
        return command_json(request, get_cmd(request, cmdId))

    @app.get("/commands/{cmdId}/status", summary="A command's status reports")
    async def command_status(request: Request, cmdId: str = Path(...)):
        return {"items": get_cmd(request, cmdId)["status"]}

    # --- scaffolding, not part of the system ------------------------------------------------------
    @app.post(REFEREE + "/{kind}", summary="Score a result against the manifest (demonstrator scaffolding)",
              tags=["demonstrator"])
    async def referee(request: Request, kind: str = Path(...)):
        """Scored here, outside the model: a model never sees the manifest (FR-37). Times are Unix seconds."""
        payload = await json_body(request)
        w = await rt.world()
        try:
            if kind == "changes":
                det = {"t": world_seconds(payload["t"]), "scale": np.asarray(payload["scale"], dtype=int)}
                r = scoring.score_changes(w, det, float(world_seconds(payload["t0"])), float(world_seconds(payload["t1"])))
                return {k: (None if v is None else float(v)) for k, v in r.items()}
            if kind == "clusters":
                t = world_seconds(payload["t"])
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
        if request.method in ("PUT", "PATCH", "DELETE", "POST", "HEAD", "OPTIONS"):
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
    return t0, t1


def _decode(name: str, ty: str, v):
    """One published value, as stored: numbers as float (NaN missing), times as Unix seconds."""
    if ty == "Quantity":
        if v == "NaN":
            return np.nan
        if v is None or isinstance(v, bool) or not isinstance(v, (int, float)):
            raise Refusal(400, f"{name}: a Quantity is a number or \"NaN\", not {json.dumps(v)}")
        return float(v)
    if ty == "Count":
        if v in ("NaN", None):
            return np.nan
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
        if v in (None, "NaN", ""):
            return np.nan
        try:
            return parse_iso(v)
        except (ValueError, TypeError):
            raise Refusal(400, f"{name}: not an ISO 8601 time")
    if v is not None and not isinstance(v, str):
        raise Refusal(400, f"{name}: a {ty} is text")
    return v


def _column(ty: str, v) -> list:
    v = np.asarray(v)
    if ty == "Quantity":
        f = v.astype(float)
        out = f.tolist()
        if np.isnan(f).any():
            out = ["NaN" if x != x else x for x in out]
        return out
    if ty == "Count":
        return ["NaN" if x != x else int(x) for x in v.astype(float).tolist()]
    if ty == "Boolean":
        return [None if x != x else bool(x) for x in v.astype(float).tolist()]
    if ty == "Time":
        f = v.astype(float)
        ok = np.isfinite(f)
        out = [None] * len(f)
        for i, s in zip(np.flatnonzero(ok).tolist(), iso_many(f[ok])):
            out[i] = s
        return out
    return v.tolist()


def _obs_response(request, d, rec, cols, of, limit, offset, n):
    fields = [x for x in rec["fields"] if x["name"] != "time"]
    times = iso_many(cols["t"])
    names = [x["name"] for x in fields]
    columns = [_column(x["type"], cols[x["name"]]) for x in fields]
    if of == swe.SWE_JSON:  # an array of records, time first; no next link (§9.1)
        rows = [dict(zip(["time"] + names, vals)) for vals in zip(times, *columns)]
        return Response(json.dumps(rows, separators=(",", ":"), allow_nan=False), media_type=swe.SWE_JSON)
    rtimes = iso_many(cols["rt"])
    root = str(request.base_url).rstrip("/")
    items = [{"id": f"{d['id']}-{offset + i}", "datastream@id": d["id"], "phenomenonTime": tt, "resultTime": rr,
              "result": dict(zip(names, vals))} for i, (tt, rr, *vals) in enumerate(zip(times, rtimes, *columns))]
    path = f"/datastreams/{d['id']}/observations"
    links = [{"href": f"{root}{path}", "rel": "self"}]
    if n == limit:
        q = dict(request.query_params)
        q.update({"limit": str(limit), "offset": str(offset + limit)})
        links.append({"href": f"{root}{path}?" + "&".join(f"{k}={v}" for k, v in q.items()), "rel": "next"})
    return JSONResponse({"items": items, "links": links})

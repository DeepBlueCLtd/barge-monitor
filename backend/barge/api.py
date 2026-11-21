"""The data server's HTTP interface (C-04 on C-06: FastAPI and Starlette).

An honest, declared subset of OGC API – Connected Systems Parts 1 and 2, with
the Features and Common prerequisites (FR-23). Everything outside the subset
is refused with the thing refused named (FR-30). The application is an
ordinary ASGI app: it runs unchanged under uvicorn and in Pyodide (NFR-03).

Models use this same interface, like any other client (FR-28): a model
creates its process system under ``/systems/models/subsystems``, then its
datastreams and control stream, then publishes observations, reads its
commands and reports their status. Creation is implemented; replacing and
deleting resources are refused, so the Create/Replace/Delete conformance
classes are not claimed.

Two things here are not Connected Systems and say so: ``PUT`` on a
datastream's observations (plain HTTP: replace the collection, for outputs
that hold the latest run only) and ``/demonstrator/referee`` (scaffolding:
the only code that reads the manifest, FR-37).
"""
from __future__ import annotations

import json
import math
from urllib.parse import urlencode

import numpy as np
from fastapi import FastAPI, Path, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response

from . import config as C
from . import swe
from . import scoring
from .fields import CATALOGUE
from .registry import NUMERIC, Series
from .server import PROFILE_URI, SOSA, iso, iso_many, parse_iso
from .tap import Tap

CS1 = "http://www.opengis.net/spec/ogcapi-connectedsystems-1/1.0/conf/"
CS2 = "http://www.opengis.net/spec/ogcapi-connectedsystems-2/1.0/conf/"
CONFORMANCE = [
    "http://www.opengis.net/spec/ogcapi-common-1/1.0/conf/core",
    "http://www.opengis.net/spec/ogcapi-common-1/1.0/conf/landing-page",
    "http://www.opengis.net/spec/ogcapi-common-1/1.0/conf/json",
    "http://www.opengis.net/spec/ogcapi-common-2/1.0/conf/collections",
    "http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/core",
    CS1 + "api-common", CS1 + "system", CS1 + "subsystem", CS1 + "property", CS1 + "sensorml",
    CS2 + "api-common", CS2 + "datastream", CS2 + "controlstream", CS2 + "json", CS2 + "swecommon-json",
]
NOT_IMPLEMENTED = {
    "deployments": "Part 1 Deployment Features", "procedures": "Part 1 Procedure Features",
    "samplingFeatures": "Part 1 Sampling Features", "featuresOfInterest": "Part 1 Sampling Features",
    "systemEvents": "Part 2 System Events", "systemHistory": "Part 2 System History",
    "feasibility": "Part 2 Command Feasibility",
}
UNSUPPORTED_PARAMS = {
    "q": "Advanced Filtering (free-text search)", "observedProperty": "Advanced Filtering by observed property",
    "foi": "Advanced Filtering by feature of interest", "bbox": "spatial filtering: no system carries a location",
    "geom": "spatial filtering: no system carries a location", "select": "property selection",
    "properties": "property selection", "parent": "Advanced Filtering by parent",
    "procedure": "Advanced Filtering by procedure", "recursive": "recursive subsystem listing",
}
UNSUPPORTED_FORMATS = {
    "application/swe+text": "SWE Common Text encoding", "application/swe+binary": "SWE Common Binary encoding",
    "application/swe+csv": "SWE Common Text encoding", "text/csv": "SWE Common Text encoding",
    "application/geo+json": "GeoJSON encoding", "text/html": "HTML encoding",
    "application/vnd.ogc.swe+json": "the preliminary SWE JSON media type (use application/swe+json)",
}
FORMAT_ALIASES = {"json": swe.JSON, "swe+json": swe.SWE_JSON, swe.JSON: swe.JSON, swe.SWE_JSON: swe.SWE_JSON,
                  "sml+json": "application/sml+json", "application/sml+json": "application/sml+json"}
PRECISION = 2


class Refusal(Exception):
    def __init__(self, status: int, code: str, description: str, refused: str | None = None, headers=None, **extra):
        super().__init__(description)
        self.status, self.code, self.description, self.refused = status, code, description, refused
        self.headers = headers or {}
        self.extra = extra

    def response(self) -> JSONResponse:
        body = {"code": self.code, "description": self.description}
        if self.refused:
            body["refused"] = self.refused
        body.update(self.extra)
        return JSONResponse(body, status_code=self.status, headers=self.headers)


SWE_TYPES = {"Quantity", "Count", "Category", "Boolean", "Text", "Time", "Matrix", "DataArray"}
COMMAND_STATUSES = ("PENDING", "ACCEPTED", "EXECUTING", "COMPLETED", "FAILED", "REJECTED")
REFEREE = "/demonstrator/referee"
SHOWN_BYTES = 4 * 4000  # what a captured message shows of a body (the tap clips it further)


def _letter_for_request(method: str, path: str) -> str:
    path = path.rstrip("/")
    if path.startswith(REFEREE):
        return "I"  # demonstrator scaffolding: no public standard
    if method == "POST" and path.endswith("/commands"):
        return "K"
    if method in ("POST", "PUT") and path.endswith("/observations"):
        return "O"
    return "Q"


def _letter_for_response(status: int, path: str, ctype: str) -> str:
    if status >= 400:
        return "H"
    if path.rstrip("/").startswith(REFEREE):
        return "I"
    if path.rstrip("/").endswith("/profile"):
        return "P"
    if "swe+json" in ctype or path.rstrip("/").endswith("/observations"):
        return "O"
    return "D"  # every other resource, commands and their status included (docs/decisions-log.md D-61)


def create_app(rt) -> FastAPI:
    """One FastAPI application over the runtime; it reaches whichever server instance is running."""
    app = FastAPI(
        title="Canal barge weather demonstrator: Connected Systems server",
        version="4.1.0",
        description=("A declared subset of OGC API – Connected Systems Parts 1 and 2 over a deliberately awkward "
                     "logger store. Everything is fictional. The facade is shown working over an awkward store, "
                     "to be confirmed against a real one (FR-19)."),
        openapi_url="/api", docs_url=None, redoc_url=None,
    )
    tap: Tap = rt.tap

    def srv():
        return rt.server

    # --- middleware: waiting mode, instance identifier, capture ------------------
    @app.middleware("http")
    async def lifecycle(request: Request, call_next):
        path = request.url.path
        root = request.scope.get("root_path", "") or ""
        rel = path[len(root):] if root and path.startswith(root) else path
        hop = request.headers.get("x-tap-hop", "1")
        token = tap.begin_chain(request.headers.get("x-tap-chain"), int(hop) if hop.isdigit() else 1)
        chain_id = tap.chain_id()
        body = await request.body()
        letter = _letter_for_request(request.method, rel)
        # Who is asking: the display client, or a model (which says so). Capture only; nothing is decided by it.
        model = request.headers.get("x-tap-model") or None
        who = "models" if model else "client"
        quiet = request.headers.get("x-tap-quiet") == "1"  # a model catching up on history: counted, not drawn
        ask = f"{request.method} {rel}{'?' + request.url.query if request.url.query else ''}"
        tap.emit(who, "fastapi", letter, f"{model}: {ask}" if model else ask,
                 _shown(body) if body else f"{request.method} {rel}?{request.url.query}", model=model, quiet=quiet)
        s = srv()
        if s is None:
            resp = Refusal(503, "ServiceUnavailable", "the server is down").response()
        elif not s.ready:
            p = s.progress()
            resp = Refusal(503, "ServiceUnavailable",
                           f"waiting mode: rebuilding the index from the store ({p['indexed']} of {p['stored']} records)",
                           headers={"Retry-After": str(C.RETRY_AFTER_S)}).response()
        else:
            tap.emit("fastapi", "server", "I", f"route {request.method} {rel}", {"path": rel, "query": str(request.url.query)},
                     model=model, quiet=quiet)
            request.state.quiet = quiet
            request.state.model = model
            resp = await call_next(request)
            tap.emit("server", "fastapi", "I", f"result {resp.status_code}", {"status": resp.status_code}, model=model, quiet=quiet)
        chunks = [c async for c in resp.body_iterator] if hasattr(resp, "body_iterator") else [resp.body]
        payload = b"".join(chunks)
        headers = dict(resp.headers)
        headers.pop("content-length", None)
        if s is not None:
            headers["x-server-instance"] = s.instance
            if rel in ("", "/"):
                headers["etag"] = f'"{s.instance}"'
        hops = tap.end_chain(token)
        headers["x-tap-hops"] = str(hops + 1)
        out = Response(content=payload, status_code=resp.status_code, headers=headers, media_type=resp.media_type)
        token2 = tap.begin_chain(chain_id, hops)
        tap.emit("fastapi", who, _letter_for_response(resp.status_code, rel, headers.get("content-type", "")),
                 f"{model}: {resp.status_code} {rel}" if model else f"{resp.status_code} {rel}", _shown(payload),
                 model=model, quiet=quiet)
        tap.end_chain(token2)
        return out

    @app.exception_handler(Refusal)
    async def refusal_handler(_request, exc: Refusal):
        return exc.response()

    @app.exception_handler(RequestValidationError)
    async def validation_handler(_request, exc: RequestValidationError):
        err = exc.errors()[0] if exc.errors() else {}
        loc = err.get("loc", ["?"])
        name = str(loc[-1])
        return Refusal(400, "InvalidParameterValue", f"{name}: {err.get('msg', 'invalid')}", name).response()

    # --- helpers ---------------------------------------------------------------
    def base(request: Request) -> str:
        return _base(request)

    def link(request, href, rel, type_="application/json", title=None):
        lk = {"href": base(request) + href, "rel": rel, "type": type_}
        if title:
            lk["title"] = title
        return lk

    def only(request: Request, allowed: set):
        for k in request.query_params.keys():
            if k in allowed:
                continue
            if k in UNSUPPORTED_PARAMS:
                raise Refusal(400, "OptionNotSupported", f"{k} is not supported ({UNSUPPORTED_PARAMS[k]})", k)
            raise Refusal(400, "InvalidParameterName", f"unknown query parameter {k}", k)

    def fmt(request: Request, f: str | None, default: str, allowed: tuple) -> str:
        want = f
        if want is None:
            # Accept is a preference, not a demand: the default when acceptable, else the first offered type.
            # An Accept naming nothing offered (a browser's text/html) gets the default (RFC 9110 §12.5.1).
            accepted = [x.split(";")[0].strip() for x in request.headers.get("accept", "").split(",")]
            if default in accepted or "*/*" in accepted:
                return default
            want = next((a for a in accepted if a in allowed), None)
        if want is None:
            return default
        if want in UNSUPPORTED_FORMATS:
            raise Refusal(400, "OptionNotSupported", f"format {want} is not supported ({UNSUPPORTED_FORMATS[want]})", f"f:{want}")
        norm = FORMAT_ALIASES.get(want)
        if norm not in allowed:
            raise Refusal(400, "OptionNotSupported", f"format {want} is not offered here; offered: {', '.join(allowed)}", f"f:{want}")
        return norm

    def page(items: list, request: Request, path: str, limit: int, offset: int, extra_links=None):
        lim = _limit(limit)
        _offset(offset)
        chunk = items[offset:offset + lim]
        links = [link(request, path, "self")]
        if offset + lim < len(items):
            q = dict(request.query_params)
            q.update({"limit": str(lim), "offset": str(offset + lim)})
            links.append(link(request, f"{path}?{urlencode(q)}", "next"))
        return {"items": chunk, "links": links + (extra_links or [])}

    def get_system(sid):
        s = srv().all_systems().get(sid)
        if s is None:
            raise Refusal(404, "NotFound", f"system {sid} does not exist", f"system:{sid}")
        return s

    def get_ds(dsid):
        d = srv().datastreams().get(dsid)
        if d is None:
            raise Refusal(404, "NotFound", f"datastream {dsid} does not exist", f"datastream:{dsid}")
        return d

    def system_json(request, s):
        sid = s["id"]
        out = {k: v for k, v in s.items() if k != "parent"}  # the parent is given as a link
        out["links"] = [link(request, f"/systems/{sid}", "self", "application/sml+json"),
                        link(request, f"/systems/{sid}/datastreams", "datastreams"),
                        link(request, f"/systems/{sid}/subsystems", "subsystems"),
                        link(request, f"/systems/{sid}/controlstreams", "controlstreams")]
        if s.get("parent"):
            out["links"].append(link(request, f"/systems/{s['parent']}", "parent"))
        return out

    def ds_json(request, d):
        s = srv()
        pt = s.time_range(d)
        props = [{"definition": f.get("definition", ""), "label": f.get("label", f["name"]), "name": f["name"]}
                 for f in d["schema"]["fields"] if not (f["type"] == "Time" and f["name"] == "time")]
        return {
            "id": d["id"], "name": d["name"], "outputName": d["outputName"],
            "system@id": d["system"], "system@link": {"href": base(request) + f"/systems/{d['system']}"},
            "validTime": [iso(pt[0]) if pt else iso(0), iso(max(rt.now(), pt[1] if pt else 0))],
            "phenomenonTime": [iso(pt[0]), iso(pt[1])] if pt else None,
            "resultTime": [iso(pt[0]), iso(pt[1])] if pt else None,
            "resultType": "record", "live": True,
            "formats": list(swe.OBS_FORMATS), "observedProperties": props,
            "links": [link(request, f"/datastreams/{d['id']}", "self"),
                      link(request, f"/datastreams/{d['id']}/schema?obsFormat={swe.SWE_JSON.replace('+', '%2B')}", "schema"),
                      link(request, f"/datastreams/{d['id']}/observations", "observations", swe.SWE_JSON)],
        }

    def cs_json(request, c):
        cid = c["id"]
        return {"id": cid, "name": c["name"], "inputName": c["inputName"], "system@id": c["system"],
                "system@link": {"href": base(request) + f"/systems/{c['system']}"}, "live": True, "async": True,
                "formats": [swe.JSON],
                "links": [link(request, f"/controlstreams/{cid}", "self"),
                          link(request, f"/controlstreams/{cid}/schema", "schema"),
                          link(request, f"/controlstreams/{cid}/commands", "commands")]}

    # --- discovery: landing, conformance, collections (FR-22) ----------------------
    @app.get("/", summary="Landing page")
    async def landing(request: Request, f: str | None = Query(None)):
        only(request, {"f"})
        s = srv()
        return {
            "title": "Canal barge weather demonstrator",
            "description": ("OGC API – Connected Systems over a deliberately awkward logger store. Everything is "
                            "fictional: canal, places and weather. Instance " + s.instance + "."),
            "links": [link(request, "/", "self"), link(request, "/api", "service-desc", "application/vnd.oai.openapi+json;version=3.1"),
                      link(request, "/conformance", "conformance"), link(request, "/collections", "data"),
                      link(request, "/systems", "systems"), link(request, "/datastreams", "datastreams"),
                      link(request, "/controlstreams", "controlstreams"), link(request, "/properties", "properties"),
                      link(request, "/profile", "profile", "application/json", "Declared profile")],
        }

    @app.get("/conformance", summary="Conformance declaration")
    async def conformance(request: Request, f: str | None = Query(None)):
        only(request, {"f"})
        claims = list(CONFORMANCE)
        if srv().claims_profile():
            claims.append(PROFILE_URI)
        return {"conformsTo": claims}

    @app.get("/profile", summary="Declared profile (FR-38)")
    async def profile(request: Request):
        only(request, set())
        return srv().profile

    COLLECTIONS = {
        "all_systems": ("All systems", "/systems", SOSA + "System"),
        "all_datastreams": ("All datastreams", "/datastreams", "http://www.opengis.net/def/x-ogc/csapi/Datastream"),
    }

    def collection_json(request, cid):
        title, href, ft = COLLECTIONS[cid]
        return {"id": cid, "title": title, "itemType": "feature" if cid == "all_systems" else "Datastream",
                "featureType": ft, "links": [link(request, f"/collections/{cid}", "self"),
                                             link(request, f"/collections/{cid}/items", "items")]}

    @app.get("/collections", summary="Collections")
    async def collections(request: Request, f: str | None = Query(None)):
        only(request, {"f"})
        return {"links": [link(request, "/collections", "self")],
                "collections": [collection_json(request, c) for c in COLLECTIONS]}

    @app.get("/collections/{collectionId}", summary="A collection")
    async def collection(request: Request, collectionId: str = Path(...)):
        only(request, {"f"})
        if collectionId not in COLLECTIONS:
            raise Refusal(404, "NotFound", f"collection {collectionId} does not exist", f"collection:{collectionId}")
        return collection_json(request, collectionId)

    @app.get("/collections/{collectionId}/items", summary="Items of a collection")
    async def collection_items(request: Request, collectionId: str = Path(...), limit: int = Query(C.DEFAULT_LIMIT),
                         offset: int = Query(0), datetime: str | None = Query(None)):
        only(request, {"limit", "offset", "datetime", "f"})
        if collectionId == "all_systems":
            return await systems(request, limit, offset, datetime)
        if collectionId == "all_datastreams":
            return await datastreams(request, limit, offset, datetime)
        raise Refusal(404, "NotFound", f"collection {collectionId} does not exist", f"collection:{collectionId}")

    # --- Part 1: systems, subsystems, properties --------------------------------
    @app.get("/systems", summary="Systems")
    async def systems(request: Request, limit: int = Query(C.DEFAULT_LIMIT), offset: int = Query(0),
                datetime: str | None = Query(None)):
        only(request, {"limit", "offset", "datetime", "f"})
        items = [system_json(request, s) for s in srv().all_systems().values() if not s.get("parent")]
        return page(items, request, "/systems", limit, offset)

    @app.get("/systems/{systemId}", summary="A system")
    async def system(request: Request, systemId: str = Path(...), f: str | None = Query(None)):
        only(request, {"f"})
        fmt(request, f, swe.JSON, (swe.JSON, "application/sml+json"))
        return system_json(request, get_system(systemId))

    @app.get("/systems/{systemId}/subsystems", summary="Subsystems")
    async def subsystems(request: Request, systemId: str = Path(...), limit: int = Query(C.DEFAULT_LIMIT), offset: int = Query(0)):
        only(request, {"limit", "offset", "f"})
        get_system(systemId)
        items = [system_json(request, s) for s in srv().all_systems().values() if s.get("parent") == systemId]
        return page(items, request, f"/systems/{systemId}/subsystems", limit, offset)

    @app.get("/properties", summary="Property definitions")
    async def properties(request: Request, limit: int = Query(C.DEFAULT_LIMIT), offset: int = Query(0)):
        only(request, {"limit", "offset", "f"})
        items = [_property(f) for f in CATALOGUE.values()]
        return page(items, request, "/properties", limit, offset)

    @app.get("/properties/{propId}", summary="A property definition")
    async def property_(request: Request, propId: str = Path(...)):
        only(request, {"f"})
        if propId not in CATALOGUE:
            raise Refusal(404, "NotFound", f"property {propId} does not exist", f"property:{propId}")
        return _property(CATALOGUE[propId])

    # --- Part 2: datastreams, schema, observations -----------------------------------
    @app.get("/datastreams", summary="Datastreams")
    async def datastreams(request: Request, limit: int = Query(C.DEFAULT_LIMIT), offset: int = Query(0),
                    datetime: str | None = Query(None)):
        only(request, {"limit", "offset", "datetime", "f"})
        items = [ds_json(request, d) for d in srv().datastreams().values()]
        return page(items, request, "/datastreams", limit, offset)

    @app.get("/systems/{systemId}/datastreams", summary="A system's datastreams")
    async def system_datastreams(request: Request, systemId: str = Path(...), limit: int = Query(C.DEFAULT_LIMIT),
                           offset: int = Query(0)):
        only(request, {"limit", "offset", "f"})
        get_system(systemId)
        items = [ds_json(request, d) for d in srv().datastreams().values() if d["system"] == systemId]
        return page(items, request, f"/systems/{systemId}/datastreams", limit, offset)

    @app.get("/datastreams/{dsId}", summary="A datastream")
    async def datastream(request: Request, dsId: str = Path(...)):
        only(request, {"f"})
        return ds_json(request, get_ds(dsId))

    @app.get("/datastreams/{dsId}/schema", summary="A datastream's schema (FR-24)")
    async def ds_schema(request: Request, dsId: str = Path(...), obsFormat: str | None = Query(None)):
        only(request, {"obsFormat", "f"})
        d = get_ds(dsId)
        if obsFormat is None:
            raise Refusal(400, "MissingParameterValue", "obsFormat is required: application/swe+json or application/json", "obsFormat")
        of = fmt(request, obsFormat, swe.SWE_JSON, swe.OBS_FORMATS)
        return swe.schema_response(d["schema"], of)

    @app.get("/datastreams/{dsId}/observations", summary="Observations (FR-25)")
    async def observations(request: Request, dsId: str = Path(...), phenomenonTime: str | None = Query(None),
                     resultTime: str | None = Query(None), limit: int = Query(C.DEFAULT_LIMIT),
                     offset: int = Query(0), f: str | None = Query(None)):
        only(request, {"phenomenonTime", "resultTime", "limit", "offset", "f"})
        d = get_ds(dsId)
        of = fmt(request, f, swe.SWE_JSON, swe.OBS_FORMATS)
        lim = _limit(limit)
        _offset(offset)
        s = srv()
        now = rt.now()
        latest = resultTime == "latest"
        t0, t1 = _interval(phenomenonTime, "phenomenonTime", now) if phenomenonTime else (-math.inf, now)
        if resultTime and not latest:
            r0, r1 = _interval(resultTime, "resultTime", now)
            t0, t1 = max(t0, r0), min(t1, r1)
        cols, total = _fetch(s, d, t0, t1, lim, offset, latest, quiet=getattr(request.state, "quiet", False),
                             why=f"{request.state.model} read" if getattr(request.state, "model", None) else "observation request")
        return _obs_response(request, d, cols, of, lim, offset, total, f"/datastreams/{dsId}/observations")

    # --- Part 2: control streams and commands (FR-27) ---------------------------
    def get_cs(csId):
        c = srv().controlstreams().get(csId)
        if c is None:
            raise Refusal(404, "NotFound", f"control stream {csId} does not exist", f"controlstream:{csId}")
        return c

    @app.get("/controlstreams", summary="Control streams")
    async def controlstreams(request: Request, limit: int = Query(C.DEFAULT_LIMIT), offset: int = Query(0)):
        only(request, {"limit", "offset", "f"})
        return page([cs_json(request, c) for c in srv().controlstreams().values()], request, "/controlstreams", limit, offset)

    @app.get("/systems/{systemId}/controlstreams", summary="A system's control streams")
    async def system_controlstreams(request: Request, systemId: str = Path(...), limit: int = Query(C.DEFAULT_LIMIT),
                                    offset: int = Query(0)):
        only(request, {"limit", "offset", "f"})
        get_system(systemId)
        items = [cs_json(request, c) for c in srv().controlstreams().values() if c["system"] == systemId]
        return page(items, request, f"/systems/{systemId}/controlstreams", limit, offset)

    @app.get("/controlstreams/{csId}", summary="A control stream")
    async def controlstream(request: Request, csId: str = Path(...)):
        only(request, {"f"})
        return cs_json(request, get_cs(csId))

    @app.get("/controlstreams/{csId}/schema", summary="A control stream's schema, with its bounds")
    async def controlstream_schema(request: Request, csId: str = Path(...)):
        only(request, {"f"})
        return {"commandFormat": swe.JSON, "parametersSchema": get_cs(csId)["schema"]}

    @app.post("/controlstreams/{csId}/commands", status_code=201, summary="Send a command")
    async def create_command(request: Request, csId: str = Path(...)):
        only(request, set())
        c = get_cs(csId)
        body = await _json_body(request)
        params = body.get("parameters") if isinstance(body, dict) else None
        if not isinstance(params, dict):
            raise Refusal(400, "InvalidParameterValue", "a command needs a parameters object", "parameters")
        s = srv()
        try:
            s.validate_command(c, params)
        except ValueError as e:
            name, msg = str(e).split("|", 1)
            raise Refusal(400, "InvalidParameterValue", msg, name)
        reg = s.registry
        reg.command_seq += 1
        cid = f"cmd-{reg.command_seq}"
        issued = iso(rt.now())
        cmd = {"id": cid, "controlstream@id": csId, "cs_key": c["key"], "issueTime": issued, "parameters": params,
               "status": [{"statusCode": "PENDING", "reportTime": issued}]}
        reg.commands[cid] = cmd
        return JSONResponse(_command_json(request, cmd), status_code=201,
                            headers={"Location": base(request) + f"/commands/{cid}"})

    @app.get("/controlstreams/{csId}/commands", summary="Commands sent to a control stream")
    async def commands(request: Request, csId: str = Path(...), limit: int = Query(C.DEFAULT_LIMIT), offset: int = Query(0),
                       statusCode: str | None = Query(None)):
        only(request, {"limit", "offset", "f", "statusCode"})
        c = get_cs(csId)
        want = None
        if statusCode is not None:
            want = [x.strip() for x in statusCode.split(",")]
            bad = [x for x in want if x not in COMMAND_STATUSES]
            if bad:
                raise Refusal(400, "InvalidParameterValue", f"statusCode {', '.join(bad)} is not one of {', '.join(COMMAND_STATUSES)}", "statusCode")
        items = [_command_json(request, x) for x in srv().registry.commands.values()
                 if x["cs_key"] == c["key"] and (want is None or x["status"][-1]["statusCode"] in want)]
        return page(items, request, f"/controlstreams/{csId}/commands", limit, offset)

    def get_cmd(cmdId):
        c = srv().registry.commands.get(cmdId)
        if c is None:
            raise Refusal(404, "NotFound", f"command {cmdId} does not exist", f"command:{cmdId}")
        return c

    @app.get("/commands/{cmdId}", summary="A command")
    async def command(request: Request, cmdId: str = Path(...)):
        only(request, {"f"})
        return _command_json(request, get_cmd(cmdId))

    @app.get("/commands/{cmdId}/status", summary="A command's status reports")
    async def command_status(request: Request, cmdId: str = Path(...)):
        only(request, {"f"})
        return {"items": get_cmd(cmdId)["status"]}

    @app.post("/commands/{cmdId}/status", status_code=201, summary="Report a command's status (the model that carries it out)")
    async def create_command_status(request: Request, cmdId: str = Path(...)):
        only(request, set())
        c = get_cmd(cmdId)
        body = await _json_body(request)
        code = body.get("statusCode") if isinstance(body, dict) else None
        if code not in COMMAND_STATUSES[1:]:
            raise Refusal(400, "InvalidParameterValue", f"statusCode must be one of {', '.join(COMMAND_STATUSES[1:])}", "statusCode")
        report = {"statusCode": code, "reportTime": iso(rt.now())}
        if body.get("message"):
            report["message"] = str(body["message"])
        c["status"].append(report)
        return JSONResponse(report, status_code=201, headers={"Location": base(request) + f"/commands/{cmdId}/status"})

    def _command_json(request, c):
        return {"id": c["id"], "controlstream@id": c["controlstream@id"], "issueTime": c["issueTime"],
                "parameters": c["parameters"], "currentStatus": c["status"][-1]["statusCode"],
                "links": [link(request, f"/commands/{c['id']}/status", "status")]}

    # --- creating resources: how a model registers (FR-28) --------------------------
    def created(request, href: str, body: dict, existing: bool = False):
        """201 with the new resource's Location; 409 with the Location of the one already there."""
        loc = {"Location": base(request) + href}
        if existing:
            return Refusal(409, "Conflict", f"{href} already exists; its Location is given", "uniqueId", headers=loc).response()
        return JSONResponse(body, status_code=201, headers=loc)

    def check_record(rec, what):
        if not isinstance(rec, dict) or rec.get("type") != "DataRecord" or not rec.get("fields"):
            raise Refusal(400, "InvalidParameterValue", f"{what} must be a SWE Common DataRecord with fields", "schema")
        for f in rec["fields"]:
            if f.get("type") not in SWE_TYPES or not isinstance(f.get("name"), str):
                raise Refusal(400, "InvalidParameterValue",
                              f"field {f.get('name')}: SWE Common type {f.get('type')} is not supported", "schema")

    def model_system(systemId):
        s = srv().registry.systems.get(systemId)
        if s is None:
            get_system(systemId)
            raise Refusal(405, "OperationNotSupported",
                          f"system {systemId} is the server's own: only a system a model created takes new datastreams", "POST")
        return s

    @app.post("/systems/{systemId}/subsystems", status_code=201, summary="Create a subsystem: a model registers its process system")
    async def create_subsystem(request: Request, systemId: str = Path(...)):
        only(request, set())
        get_system(systemId)
        if systemId != "models":
            raise Refusal(405, "OperationNotSupported", "only the Models system takes new subsystems", "POST")
        body = await _json_body(request)
        uid = body.get("uniqueId") if isinstance(body, dict) else None
        if not isinstance(uid, str) or not uid or not isinstance(body.get("label"), str):
            raise Refusal(400, "InvalidParameterValue", "a system needs a uniqueId and a label", "uniqueId")
        s = srv()
        for sid, old in s.all_systems().items():
            if old["uniqueId"] == uid:
                return created(request, f"/systems/{sid}", {}, existing=True)
        reg = s.registry
        sid = reg.system_id_for(uid)
        reg.systems[sid] = {"type": "SimpleProcess", "id": sid, "uniqueId": uid, "label": body["label"],
                            "description": body.get("description", ""), "definition": SOSA + "System",
                            "systemType": SOSA + "System", "assetType": "Process", "parent": "models"}
        return created(request, f"/systems/{sid}", system_json(request, reg.systems[sid]))

    @app.post("/systems/{systemId}/datastreams", status_code=201, summary="Create a datastream under a model's system")
    async def create_datastream(request: Request, systemId: str = Path(...)):
        only(request, set())
        model_system(systemId)
        body = await _json_body(request)
        sch = body.get("schema") if isinstance(body, dict) else None
        rec = sch.get("recordSchema") if isinstance(sch, dict) else None
        check_record(rec, "schema.recordSchema")
        if rec["fields"][0].get("type") != "Time" or rec["fields"][0].get("name") != "time":
            raise Refusal(400, "InvalidParameterValue", "the first field must be a Time named time", "schema")
        if sch.get("obsFormat", swe.SWE_JSON) != swe.SWE_JSON:
            raise Refusal(400, "OptionNotSupported", f"obsFormat {sch.get('obsFormat')} is not supported; use {swe.SWE_JSON}", "obsFormat")
        out = body.get("outputName")
        if not isinstance(out, str) or not out:
            raise Refusal(400, "InvalidParameterValue", "a datastream needs an outputName", "outputName")
        s = srv()
        key = f"{systemId}:{out}"
        old = s.registry.datastreams.get(key)
        same = old is not None and [f["name"] for f in old["schema"]["fields"]] == [f["name"] for f in rec["fields"]]
        if not same:  # new, or the same output with a new schema: a new datastream under a new identifier (FR-51)
            s.registry.datastreams[key] = {"key": key, "system": systemId, "outputName": out, "name": body.get("name", out),
                                           "schema": rec, "series": Series(rec["fields"])}
        d = next(x for x in s.datastreams(hidden=True).values() if x["key"] == key)
        return created(request, f"/datastreams/{d['id']}", {} if same else ds_json(request, d), existing=same)

    @app.post("/systems/{systemId}/controlstreams", status_code=201, summary="Create a control stream under a model's system")
    async def create_controlstream(request: Request, systemId: str = Path(...)):
        only(request, set())
        model_system(systemId)
        body = await _json_body(request)
        sch = body.get("schema") if isinstance(body, dict) else None
        rec = sch.get("parametersSchema") if isinstance(sch, dict) else None
        check_record(rec, "schema.parametersSchema")
        name = body.get("inputName") or "settings"
        key = f"{systemId}:{name}"
        s = srv()
        old = s.registry.controlstreams.get(key)
        same = old is not None and old["schema"] == rec
        if not same:
            s.registry.controlstreams[key] = {"key": key, "system": systemId, "inputName": name,
                                              "name": body.get("name", name), "schema": rec}
        c = next(x for x in s.controlstreams().values() if x["key"] == key)
        return created(request, f"/controlstreams/{c['id']}", {} if same else cs_json(request, c), existing=same)

    async def take_observations(request: Request, dsId: str, replace: bool):
        only(request, set())
        s = srv()
        d = s.datastreams(hidden=True).get(dsId)
        if d is None:
            raise Refusal(404, "NotFound", f"datastream {dsId} does not exist", f"datastream:{dsId}")
        if d["kind"] == "sensor":
            raise Refusal(405, "OperationNotSupported", "a sensor's observations come from the logger store, not from clients",
                          request.method)
        ctype = request.headers.get("content-type", swe.SWE_JSON).split(";")[0].strip()
        if ctype != swe.SWE_JSON:
            raise Refusal(415, "OptionNotSupported", f"observations are published as {swe.SWE_JSON}, not {ctype}", f"content-type:{ctype}")
        rows = await _json_body(request)
        if isinstance(rows, dict):
            rows = [rows]
        if not isinstance(rows, list) or any(not isinstance(r, dict) for r in rows):
            raise Refusal(400, "InvalidParameterValue", "the body must be a record or an array of records", "body")
        full = s.registry.datastreams[d["key"]]  # every registered field is stored; the offering applies on the way out
        cols = _rows_to_cols(rows, full["schema"]["fields"])
        ser = full["series"]
        if replace:
            ser.clear()
        n = ser.append(cols)
        return JSONResponse({"created": n}, status_code=200 if replace else 201,
                            headers={"Location": base(request) + f"/datastreams/{dsId}/observations"})

    @app.post("/datastreams/{dsId}/observations", status_code=201, summary="Publish observations")
    async def create_observations(request: Request, dsId: str = Path(...)):
        return await take_observations(request, dsId, replace=False)

    @app.put("/datastreams/{dsId}/observations", summary="Replace a datastream's observations (plain HTTP, not Connected Systems)")
    async def replace_observations(request: Request, dsId: str = Path(...)):
        return await take_observations(request, dsId, replace=True)

    # --- the demonstrator's referee: scaffolding, not part of the system (FR-37) -------
    @app.post(REFEREE + "/{kind}", summary="Score a result against the manifest (demonstrator scaffolding)", tags=["demonstrator"])
    async def referee(request: Request, kind: str = Path(...)):
        """Scored here, outside the model: a model never sees the manifest or the position."""
        only(request, set())
        payload = await _json_body(request)
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
            raise Refusal(400, "InvalidParameterValue", f"referee: {e}", "body")
        raise Refusal(404, "NotFound", f"the referee scores changes and clusters, not {kind}", f"referee:{kind}")

    # --- everything else is refused by name (FR-27) -------------------------------
    @app.api_route("/{rest:path}", methods=["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"], include_in_schema=False)
    async def refuse(request: Request, rest: str):
        first = rest.split("/")[0]
        if request.method == "PATCH":
            raise Refusal(405, "OperationNotSupported", "PATCH is not supported (Part 1 and 2 Update classes)", "PATCH")
        if request.method in ("HEAD", "OPTIONS"):
            raise Refusal(405, "OperationNotSupported", f"{request.method} is not supported", request.method)
        if request.method in ("POST", "PUT", "DELETE"):
            raise Refusal(405, "OperationNotSupported",
                          f"{request.method} /{rest} is not supported: a model creates its system under /systems/models/subsystems, "
                          "then its datastreams, control stream, observations and command status; nothing is replaced or deleted",
                          request.method)
        if first in NOT_IMPLEMENTED:
            raise Refusal(404, "OperationNotSupported", f"{first} is not implemented ({NOT_IMPLEMENTED[first]})", first)
        raise Refusal(404, "NotFound", f"no resource at /{rest}", f"path:/{rest}")

    return app


# --- module helpers -----------------------------------------------------------------

def _base(request: Request) -> str:
    """Absolute base URL of the API, from the request itself (links are absolute, RFC 8288)."""
    return str(request.base_url).rstrip("/")


def _offset(offset: int) -> int:
    if offset < 0:
        raise Refusal(400, "InvalidParameterValue", "offset must be zero or more", "offset")
    return offset


def _limit(limit: int) -> int:
    if limit < 1:
        raise Refusal(400, "InvalidParameterValue", "limit must be at least 1", "limit")
    if limit > C.MAX_LIMIT:
        raise Refusal(400, "InvalidParameterValue",
                      f"limit {limit} is over the maximum of {C.MAX_LIMIT}. Narrow the query: page with a smaller "
                      f"limit, or give a shorter phenomenonTime interval.", "limit", maximum=C.MAX_LIMIT)
    return limit


def _interval(text: str, name: str, now: float):
    try:
        if "/" in text:
            a, b = text.split("/", 1)
            t0 = -math.inf if a in ("", "..") else parse_iso(a)
            t1 = now if b in ("", "..") else parse_iso(b)
        else:
            t0 = t1 = parse_iso(text)
    except ValueError as e:
        raise Refusal(400, "InvalidParameterValue", f"{name}: {e}", name)
    if t1 < t0:
        raise Refusal(400, "InvalidParameterValue", f"{name} ends before it starts", name)
    return t0, t1


async def _json_body(request: Request):
    raw = await request.body()
    try:
        return json.loads(raw or b"null")
    except json.JSONDecodeError:
        raise Refusal(400, "InvalidParameterValue", "the request body must be JSON", "body")


def _shown(b: bytes) -> str:
    """What a captured message shows of a body: its start, never megabytes of it."""
    if len(b) <= SHOWN_BYTES:
        return b.decode("utf-8", "replace")
    return b[:SHOWN_BYTES].decode("utf-8", "replace") + f"… ({len(b)} bytes in all)"


def _rows_to_cols(rows: list, fields: list) -> dict:
    """Published SWE JSON records as columns. Every record needs its time; unknown fields are refused."""
    known = {f["name"]: f["type"] for f in fields}
    for r in rows[:1] + rows[-1:]:
        extra = [k for k in r if k not in known]
        if extra:
            raise Refusal(400, "InvalidParameterValue", f"field {extra[0]} is not in the datastream's schema", extra[0])
    try:
        cols = {"t": _times([r["time"] for r in rows])}
    except (KeyError, ValueError, TypeError) as e:
        raise Refusal(400, "InvalidParameterValue", f"every record needs a time (ISO 8601, UTC): {e}", "time")
    for name, ty in known.items():
        if name == "time":
            continue
        vals = [r.get(name) for r in rows]
        try:
            if ty == "Time":
                cols[name] = _times(vals)
            elif ty in NUMERIC:
                cols[name] = np.array([np.nan if v is None else v for v in vals], dtype=float)
            else:
                a = np.empty(len(vals), dtype=object)
                a[:] = vals
                cols[name] = a
        except (ValueError, TypeError) as e:
            raise Refusal(400, "InvalidParameterValue", f"{name}: {e}", name)
    return cols


def _times(vals: list) -> np.ndarray:
    if not vals:
        return np.empty(0)
    a = np.array([v[:-1] if v.endswith("Z") else v for v in vals], dtype="datetime64[ms]")
    return a.astype("int64") / 1000.0 - C.SIM_EPOCH_UNIX


def _property(f):
    p = {"id": f.name, "label": f.label, "definition": f.definition, "type": f.swe_type, "kind": f.kind}
    if f.uom:
        p["uom"] = f.uom
    if f.inputs:
        p["inputs"] = list(f.inputs)
    return p


def _fetch(s, d, t0, t1, lim, offset, latest, quiet=False, why="observation request"):
    """Columns for one page and the total available."""
    names = [f["name"] for f in d["schema"]["fields"] if f["name"] != "time"]
    if d["kind"] == "sensor":
        if latest:
            tr = s.adapter.time_range(d["sensor"])
            if not tr:
                return {"t": np.empty(0)}, 0
            t0 = t1 = tr[1]
        total = s.adapter.count(d["sensor"], t0, t1)
        fields = [n for n in names if not n.endswith("_qc")]
        return s.sensor_records(d["sensor"], t0, t1, lim, offset, fields=fields, why=why, quiet=quiet), total
    ser = d["series"]
    i0, i1 = ser.range(t0, t1)
    if latest and len(ser):
        i0, i1 = len(ser) - 1, len(ser)
    total = max(0, i1 - i0)
    return ser.slice(i0 + offset, min(i1, i0 + offset + lim), names), total


def _column(fd, v):
    v = np.asarray(v)
    if fd["type"] == "Time":
        out = iso_many(v.astype(float))
        return [None if not np.isfinite(x) else s for x, s in zip(v.astype(float), out)]
    if v.dtype == object:
        return [None if (isinstance(x, float) and not np.isfinite(x)) else x for x in v.tolist()]
    if fd["type"] == "Quantity":
        r = np.round(v.astype(float), PRECISION)
        return r.tolist() if not np.isnan(r).any() else [None if x != x else x for x in r.tolist()]
    if fd["type"] == "Count":
        return [None if x != x else int(x) for x in v.astype(float).tolist()]
    if fd["type"] == "Boolean":
        return [None if x != x else bool(x) for x in v.astype(float).tolist()]
    if fd["type"] == "Category":
        return v.tolist()
    return v.tolist()


def _obs_response(request, d, cols, of, lim, offset, total, path):
    fields = d["schema"]["fields"]
    t = np.asarray(cols["t"], dtype=float)
    times = iso_many(t) if len(t) else []
    columns = []
    for fd in fields:
        if fd["name"] == "time":
            continue
        if fd["name"] in cols:
            if fd["name"].endswith("_qc") and d.get("kind") == "sensor":
                flags = np.asarray(cols[fd["name"]], dtype=float)
                columns.append((fd["name"], [None if x != x else str(int(x)) for x in flags.tolist()]))
            else:
                columns.append((fd["name"], _column(fd, cols[fd["name"]])))
    if d.get("kind") == "sensor":
        cat = {fd["name"]: fd for fd in fields}
        if "precipitation_type" in cat:
            tokens = cat["precipitation_type"]["constraint"]["values"]
            pv = np.asarray(cols["precipitation_type"], dtype=float)
            columns = [(n, [None if x != x else tokens[int(x)] for x in pv.tolist()]) if n == "precipitation_type" else (n, c)
                       for n, c in columns]
    root = _base(request)
    nxt = None
    if offset + lim < total:
        q = dict(request.query_params)
        q.update({"limit": str(lim), "offset": str(offset + lim)})
        nxt = f"{root}{path}?{urlencode(q)}"
    headers = {}
    if of == swe.SWE_JSON:
        names = [n for n, _ in columns]
        rows = [dict(zip(["time"] + names, vals)) for vals in zip(times, *[c for _, c in columns])]
        if nxt:
            headers["Link"] = f'<{nxt}>; rel="next"'
        headers["x-total-count"] = str(total)
        return Response(json.dumps(rows, separators=(",", ":"), allow_nan=False), media_type=swe.SWE_JSON, headers=headers)
    names = [n for n, _ in columns]
    items = [{"id": f"{d['id']}-{tt}", "datastream@id": d["id"], "phenomenonTime": tt, "resultTime": tt,
              "result": dict(zip(names, vals))} for tt, *vals in zip(times, *[c for _, c in columns])]
    links = [{"href": f"{root}{path}", "rel": "self"}] + ([{"href": nxt, "rel": "next"}] if nxt else [])
    return JSONResponse({"items": items, "links": links, "numberMatched": total})

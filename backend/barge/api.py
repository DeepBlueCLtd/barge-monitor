"""The Connected Systems HTTP interface (B-C07 on B-C08: FastAPI and Starlette).

An honest, declared subset of OGC API – Connected Systems Parts 1 and 2, with
the Features and Common prerequisites (FR-22, FR-22a). Everything outside the
subset is refused with the thing refused named (FR-27). The application is
an ordinary ASGI app: it runs unchanged under uvicorn and in Pyodide (NFR-03).
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
from .fields import CATALOGUE
from .server import PROFILE_URI, SENSORS, SOSA, iso, iso_many, parse_iso
from .tap import Tap

CS1 = "http://www.opengis.net/spec/ogcapi-connectedsystems-1/1.0/conf/"
CS2 = "http://www.opengis.net/spec/ogcapi-connectedsystems-2/1.0/conf/"
CONFORMANCE = [
    "http://www.opengis.net/spec/ogcapi-common-1/1.0/conf/core",
    "http://www.opengis.net/spec/ogcapi-common-1/1.0/conf/landing-page",
    "http://www.opengis.net/spec/ogcapi-common-1/1.0/conf/json",
    "http://www.opengis.net/spec/ogcapi-common-2/1.0/conf/collections",
    "http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/core",
    CS1 + "api-common", CS1 + "system", CS1 + "subsystem", CS1 + "property",
    CS1 + "create-replace-delete", CS1 + "sensorml",
    CS2 + "api-common", CS2 + "datastream", CS2 + "controlstream",
    CS2 + "create-replace-delete", CS2 + "json", CS2 + "swecommon-json",
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


def _letter_for_request(method: str, path: str) -> str:
    return "K" if method == "POST" and path.rstrip("/").endswith("/commands") else "Q"


def _letter_for_response(status: int, path: str, ctype: str) -> str:
    if status >= 400:
        return "H"
    if path.rstrip("/").endswith("/profile"):
        return "P"
    if "swe+json" in ctype or path.rstrip("/").endswith("/observations"):
        return "O"
    if "/commands" in path and status in (200, 201):
        return "K"
    return "D"


def create_app(rt) -> FastAPI:
    """One FastAPI application over the runtime; it reaches whichever server instance is running."""
    app = FastAPI(
        title="Canal barge weather demonstrator: Connected Systems server",
        version="3.2.0",
        description=("A declared subset of OGC API – Connected Systems Parts 1 and 2 over a deliberately awkward "
                     "logger store. Everything is fictional. The facade is shown working over an awkward store, "
                     "to be confirmed against a real one (FR-21)."),
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
        token = tap.begin_chain(request.headers.get("x-tap-chain"), int(request.headers.get("x-tap-hop", "1")))
        body = await request.body()
        letter = _letter_for_request(request.method, rel)
        tap.emit("relay", "fastapi", letter, f"{request.method} {rel}{'?' + request.url.query if request.url.query else ''}",
                 body.decode("utf-8", "replace") if body else f"{request.method} {rel}?{request.url.query}")
        s = srv()
        if s is None:
            resp = Refusal(503, "ServiceUnavailable", "the server is down").response()
        elif not s.ready:
            p = s.progress()
            resp = Refusal(503, "ServiceUnavailable",
                           f"waiting mode: rebuilding the index from the store ({p['indexed']} of {p['stored']} records)",
                           headers={"Retry-After": str(C.RETRY_AFTER_S)}).response()
        else:
            tap.emit("fastapi", "server", "I", f"route {request.method} {rel}", {"path": rel, "query": str(request.url.query)})
            resp = await call_next(request)
            tap.emit("server", "fastapi", "I", f"result {resp.status_code}", {"status": resp.status_code})
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
        token2 = tap.begin_chain(request.headers.get("x-tap-chain"), hops)
        tap.emit("fastapi", "relay", _letter_for_response(resp.status_code, rel, headers.get("content-type", "")),
                 f"{resp.status_code} {rel}", payload.decode("utf-8", "replace"))
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
            accept = request.headers.get("accept", "")
            for a in [x.split(";")[0].strip() for x in accept.split(",")]:
                if a in allowed or a in UNSUPPORTED_FORMATS:
                    want = a
                    break
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
        d = srv().all_datastreams().get(dsid)
        if d is None:
            raise Refusal(404, "NotFound", f"datastream {dsid} does not exist", f"datastream:{dsid}")
        return d

    def system_json(request, s):
        sid = s["id"]
        out = {k: v for k, v in s.items() if k != "parent"}
        out["links"] = [link(request, f"/systems/{sid}", "self", "application/sml+json"),
                        link(request, f"/systems/{sid}/datastreams", "datastreams"),
                        link(request, f"/systems/{sid}/subsystems", "subsystems"),
                        link(request, f"/systems/{sid}/controlstreams", "controlstreams")]
        if s.get("parent"):
            out["links"].append(link(request, f"/systems/{s['parent']}", "parent"))
        return out

    def ds_json(request, d):
        s = srv()
        tr = s.time_range()
        if d.get("kind") == "promoted":
            obs = s.registry.observations.get(d["id"], [])
            pt = [obs[0]["t"], obs[-1]["t"]] if obs else None
        elif d.get("output") in ("changes", "clusters", "correlation", "runs"):
            pt = [s.run["window_start"], s.run["window_end"]] if s.run else None
        else:
            pt = list(tr) if tr else None
        props = [{"definition": f.get("definition", ""), "label": f.get("label", f["name"]), "name": f["name"]}
                 for f in d["schema"]["fields"] if not (f["type"] == "Time" and f["name"] == "time")]
        return {
            "id": d["id"], "name": d["name"], "outputName": d["outputName"],
            "system@id": d["system"], "system@link": {"href": base(request) + f"/systems/{d['system']}"},
            "validTime": [iso(pt[0]) if pt else iso(0), iso(max(rt.now(), pt[1] if pt else 0))],
            "phenomenonTime": [iso(pt[0]), iso(pt[1])] if pt else None,
            "resultTime": [iso(pt[0]), iso(pt[1])] if pt else None,
            "resultType": "record", "live": d.get("kind") != "promoted",
            "formats": list(swe.OBS_FORMATS), "observedProperties": props,
            "links": [link(request, f"/datastreams/{d['id']}", "self"),
                      link(request, f"/datastreams/{d['id']}/schema?obsFormat={swe.SWE_JSON.replace('+', '%2B')}", "schema"),
                      link(request, f"/datastreams/{d['id']}/observations", "observations", swe.SWE_JSON)],
        }

    def cs_json(request):
        s = srv()
        cid = s.controlstream_id
        return {"id": cid, "name": "Analysis settings", "inputName": "settings", "system@id": "analysis",
                "system@link": {"href": base(request) + "/systems/analysis"}, "live": True, "async": False,
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

    @app.post("/systems", status_code=201, summary="Create a system (promotion, FR-36)")
    async def create_system(request: Request):
        only(request, set())
        body = await _json_body(request)
        stype = body.get("systemType") or body.get("definition")
        allowed = [SOSA + t for t in ("Sensor", "Actuator", "Sampler", "Platform", "System")]
        if stype not in allowed:
            raise Refusal(400, "InvalidParameterValue",
                          f"systemType must be one of the five SOSA types: {', '.join(allowed)}", "systemType")
        for k in ("uniqueId", "label"):
            if not isinstance(body.get(k), str) or not body[k]:
                raise Refusal(400, "InvalidParameterValue", f"{k} is required", k)
        reg = srv().registry
        if any(s["uniqueId"] == body["uniqueId"] for s in srv().all_systems().values()):
            raise Refusal(409, "Conflict", f"a system with uniqueId {body['uniqueId']} exists", "uniqueId")
        sid = reg.new_id("product")
        reg.systems[sid] = {"type": body.get("type", "SimpleProcess"), "id": sid, "uniqueId": body["uniqueId"],
                            "label": body["label"], "description": body.get("description", ""),
                            "definition": stype, "systemType": stype, "assetType": body.get("assetType", "Process"),
                            "createdBy": "client"}
        return JSONResponse(system_json(request, reg.systems[sid]), status_code=201,
                            headers={"Location": base(request) + f"/systems/{sid}"})

    @app.get("/systems/{systemId}", summary="A system")
    async def system(request: Request, systemId: str = Path(...), f: str | None = Query(None)):
        only(request, {"f"})
        fmt(request, f, swe.JSON, (swe.JSON, "application/sml+json"))
        return system_json(request, get_system(systemId))

    @app.delete("/systems/{systemId}", status_code=204, summary="Delete a created system")
    async def delete_system(request: Request, systemId: str = Path(...)):
        only(request, set())
        get_system(systemId)
        reg = srv().registry
        if systemId not in reg.systems:
            raise Refusal(403, "Forbidden", f"system {systemId} is built in and cannot be deleted", f"system:{systemId}")
        for dsid in [d for d, v in reg.datastreams.items() if v["system"] == systemId]:
            reg.datastreams.pop(dsid)
            reg.observations.pop(dsid, None)
        reg.systems.pop(systemId)
        return Response(status_code=204)

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
        items = [ds_json(request, d) for d in srv().all_datastreams().values()]
        return page(items, request, "/datastreams", limit, offset)

    @app.get("/systems/{systemId}/datastreams", summary="A system's datastreams")
    async def system_datastreams(request: Request, systemId: str = Path(...), limit: int = Query(C.DEFAULT_LIMIT),
                           offset: int = Query(0)):
        only(request, {"limit", "offset", "f"})
        get_system(systemId)
        items = [ds_json(request, d) for d in srv().all_datastreams().values() if d["system"] == systemId]
        return page(items, request, f"/systems/{systemId}/datastreams", limit, offset)

    @app.post("/systems/{systemId}/datastreams", status_code=201, summary="Create a datastream (promotion)")
    async def create_datastream(request: Request, systemId: str = Path(...)):
        only(request, set())
        get_system(systemId)
        reg = srv().registry
        if systemId not in reg.systems:
            raise Refusal(403, "Forbidden", "datastreams can be created only under created systems", f"system:{systemId}")
        body = await _json_body(request)
        sch = body.get("schema") or {}
        if sch.get("obsFormat") != swe.SWE_JSON:
            raise Refusal(400, "InvalidParameterValue", "schema.obsFormat must be application/swe+json", "schema.obsFormat")
        rec = sch.get("recordSchema") or {}
        _check_record(rec)
        for k in ("name", "outputName"):
            if not isinstance(body.get(k), str) or not body[k]:
                raise Refusal(400, "InvalidParameterValue", f"{k} is required", k)
        dsid = reg.new_id("ds")
        reg.datastreams[dsid] = {"id": dsid, "name": body["name"], "outputName": body["outputName"],
                                 "system": systemId, "kind": "promoted", "schema": rec}
        reg.observations[dsid] = []
        return JSONResponse(ds_json(request, reg.datastreams[dsid]), status_code=201,
                            headers={"Location": base(request) + f"/datastreams/{dsid}"})

    @app.get("/datastreams/{dsId}", summary="A datastream")
    async def datastream(request: Request, dsId: str = Path(...)):
        only(request, {"f"})
        return ds_json(request, get_ds(dsId))

    @app.delete("/datastreams/{dsId}", status_code=204, summary="Delete a created datastream")
    async def delete_datastream(request: Request, dsId: str = Path(...)):
        only(request, set())
        get_ds(dsId)
        reg = srv().registry
        if dsId not in reg.datastreams:
            raise Refusal(403, "Forbidden", f"datastream {dsId} is built in and cannot be deleted", f"datastream:{dsId}")
        reg.datastreams.pop(dsId)
        reg.observations.pop(dsId, None)
        return Response(status_code=204)

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
        s = srv()
        now = rt.now()
        latest = resultTime == "latest"
        t0, t1 = _interval(phenomenonTime, "phenomenonTime", now) if phenomenonTime else (-math.inf, now)
        if resultTime and not latest:
            r0, r1 = _interval(resultTime, "resultTime", now)
            t0, t1 = max(t0, r0), min(t1, r1)
        cols, total = _fetch(s, d, t0, t1, lim, offset, latest)
        return _obs_response(request, d, cols, of, lim, offset, total, f"/datastreams/{dsId}/observations")

    @app.post("/datastreams/{dsId}/observations", status_code=201, summary="Create observations (promotion)")
    async def create_observations(request: Request, dsId: str = Path(...)):
        only(request, set())
        d = get_ds(dsId)
        reg = srv().registry
        if dsId not in reg.datastreams:
            raise Refusal(403, "Forbidden", f"observations can be created only in created datastreams", f"datastream:{dsId}")
        body = await _json_body(request)
        items = body if isinstance(body, list) else [body]
        names = {fd["name"]: fd for fd in d["schema"]["fields"]}
        added = []
        for it in items:
            if "result" in it:  # application/json observation
                rec = dict(it["result"])
                rec["time"] = it.get("phenomenonTime")
            else:  # application/swe+json record
                rec = dict(it)
            try:
                t = parse_iso(rec.get("time") or "")
            except ValueError:
                raise Refusal(400, "InvalidParameterValue", "each observation needs a UTC time", "time")
            for k, v in rec.items():
                if k == "time":
                    continue
                if k not in names:
                    raise Refusal(400, "InvalidParameterValue", f"field {k} is not in the datastream's schema", f"field:{k}")
                _check_value(names[k], v)
            reg.observations[dsId].append({"t": t, "record": {k: v for k, v in rec.items() if k != "time"}})
            added.append(t)
        reg.observations[dsId].sort(key=lambda o: o["t"])
        return JSONResponse({"created": len(added)}, status_code=201)

    # --- Part 2: control streams and commands (FR-26) ---------------------------
    @app.get("/controlstreams", summary="Control streams")
    async def controlstreams(request: Request, limit: int = Query(C.DEFAULT_LIMIT), offset: int = Query(0)):
        only(request, {"limit", "offset", "f"})
        return page([cs_json(request)], request, "/controlstreams", limit, offset)

    @app.get("/systems/{systemId}/controlstreams", summary="A system's control streams")
    async def system_controlstreams(request: Request, systemId: str = Path(...)):
        only(request, {"limit", "offset", "f"})
        get_system(systemId)
        return {"items": [cs_json(request)] if systemId == "analysis" else [],
                "links": [link(request, f"/systems/{systemId}/controlstreams", "self")]}

    def get_cs(csId):
        if csId != srv().controlstream_id:
            raise Refusal(404, "NotFound", f"control stream {csId} does not exist", f"controlstream:{csId}")

    @app.get("/controlstreams/{csId}", summary="A control stream")
    async def controlstream(request: Request, csId: str = Path(...)):
        only(request, {"f"})
        get_cs(csId)
        return cs_json(request)

    @app.get("/controlstreams/{csId}/schema", summary="A control stream's schema, with its bounds")
    async def controlstream_schema(request: Request, csId: str = Path(...), obsFormat: str | None = Query(None)):
        only(request, {"obsFormat", "f"})
        get_cs(csId)
        return {"commandFormat": swe.JSON, "parametersSchema": srv().control_schema}

    @app.post("/controlstreams/{csId}/commands", status_code=201, summary="Send a command")
    async def create_command(request: Request, csId: str = Path(...)):
        only(request, set())
        get_cs(csId)
        body = await _json_body(request)
        params = body.get("parameters") if isinstance(body, dict) else None
        if not isinstance(params, dict):
            raise Refusal(400, "InvalidParameterValue", "a command needs a parameters object", "parameters")
        s = srv()
        try:
            settings = s.validate_command(params)
        except ValueError as e:
            name, msg = str(e).split("|", 1)
            raise Refusal(400, "InvalidParameterValue", msg, name)
        cid = f"cmd-{s.instance}-{len(s.commands) + 1}"
        issued = iso(rt.now())
        cmd = {"id": cid, "controlstream@id": csId, "issueTime": issued, "parameters": params,
               "status": [{"statusCode": "PENDING", "reportTime": issued}]}
        s.commands[cid] = cmd
        cmd["status"].append({"statusCode": "ACCEPTED", "reportTime": issued})
        try:
            run = s.run_analysis(settings, cid)
            cmd["status"].append({"statusCode": "COMPLETED", "reportTime": iso(rt.now()),
                                  "message": f"{run['run_id']} over {run['records']} records"})
        except Exception as e:  # noqa: BLE001 - reported as the command's status
            cmd["status"].append({"statusCode": "FAILED", "reportTime": iso(rt.now()), "message": str(e)})
        return JSONResponse(_command_json(request, cmd), status_code=201,
                            headers={"Location": base(request) + f"/commands/{cid}"})

    @app.get("/controlstreams/{csId}/commands", summary="Commands sent to a control stream")
    async def commands(request: Request, csId: str = Path(...), limit: int = Query(C.DEFAULT_LIMIT), offset: int = Query(0)):
        only(request, {"limit", "offset", "f"})
        get_cs(csId)
        items = [_command_json(request, c) for c in srv().commands.values()]
        return page(items, request, f"/controlstreams/{csId}/commands", limit, offset)

    def get_cmd(cmdId):
        c = srv().commands.get(cmdId)
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

    def _command_json(request, c):
        return {"id": c["id"], "controlstream@id": c["controlstream@id"], "issueTime": c["issueTime"],
                "parameters": c["parameters"], "currentStatus": c["status"][-1]["statusCode"],
                "links": [link(request, f"/commands/{c['id']}/status", "status")]}

    # --- everything else is refused by name (FR-27) -------------------------------
    @app.api_route("/{rest:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"], include_in_schema=False)
    async def refuse(request: Request, rest: str):
        first = rest.split("/")[0]
        if request.method == "PATCH":
            raise Refusal(405, "OperationNotSupported", "PATCH is not supported (Part 1 and 2 Update classes)", "PATCH")
        if first in NOT_IMPLEMENTED:
            raise Refusal(404, "OperationNotSupported", f"{first} is not implemented ({NOT_IMPLEMENTED[first]})", first)
        raise Refusal(404, "NotFound", f"no resource at /{rest}", f"path:/{rest}")

    return app


# --- module helpers -----------------------------------------------------------------

def _base(request: Request) -> str:
    """Absolute base URL of the API, from the request itself (links are absolute, RFC 8288)."""
    return str(request.base_url).rstrip("/")


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


def _property(f):
    p = {"id": f.name, "label": f.label, "definition": f.definition, "type": f.swe_type, "kind": f.kind}
    if f.uom:
        p["uom"] = f.uom
    if f.inputs:
        p["inputs"] = list(f.inputs)
    return p


_TYPES = {"Quantity", "Count", "Category", "Boolean", "Text", "Time", "Matrix", "DataArray"}


def _check_record(rec):
    if rec.get("type") != "DataRecord" or not isinstance(rec.get("fields"), list) or not rec["fields"]:
        raise Refusal(400, "InvalidParameterValue", "recordSchema must be a SWE Common DataRecord with fields", "schema.recordSchema")
    first = rec["fields"][0]
    if first.get("type") != "Time" or first.get("name") != "time":
        raise Refusal(400, "InvalidParameterValue", "the first field must be a Time named time", "schema.recordSchema.fields[0]")
    for fd in rec["fields"]:
        if fd.get("type") not in _TYPES:
            raise Refusal(400, "OptionNotSupported", f"SWE Common type {fd.get('type')} is not supported", f"type:{fd.get('type')}")
        if not isinstance(fd.get("name"), str):
            raise Refusal(400, "InvalidParameterValue", "every field needs a name", "name")


def _check_value(fd, v):
    t = fd["type"]
    if v is None:
        return
    ok = {"Quantity": isinstance(v, (int, float)) and not isinstance(v, bool),
          "Count": isinstance(v, int) and not isinstance(v, bool),
          "Boolean": isinstance(v, bool), "Text": isinstance(v, str), "Time": isinstance(v, str),
          "Category": isinstance(v, str), "Matrix": isinstance(v, list), "DataArray": isinstance(v, list)}.get(t, True)
    if not ok:
        raise Refusal(400, "InvalidParameterValue", f"field {fd['name']} must be a {t}", f"field:{fd['name']}")
    if t == "Category":
        allowed = (fd.get("constraint") or {}).get("values")
        if allowed and v not in allowed:
            raise Refusal(400, "InvalidParameterValue", f"{fd['name']}={v} is not one of {allowed}", f"field:{fd['name']}")


def _fetch(s, d, t0, t1, lim, offset, latest):
    """Columns for one page and the total available."""
    kind = d.get("kind")
    if kind == "sensor":
        if latest:
            tr = s.adapter.time_range(d["sensor"])
            if not tr:
                return {"t": np.empty(0)}, 0
            t0 = t1 = tr[1]
        total = s.sensor_count(d["sensor"], t0, t1)
        return s.sensor_records(d["sensor"], t0, t1, lim, offset), total
    if kind == "analysis" and d["output"] == "derived":
        if latest:
            tr = s.time_range()
            t0 = t1 = tr[1] if tr else 0.0
        total = s.derived_count(t0, t1)
        return s.derived_records(t0, t1, lim, offset), total
    if kind == "analysis":
        cols = s.analysis_records(d["output"], t0, t1)
    else:
        obs = [o for o in s.registry.observations.get(d["id"], []) if t0 <= o["t"] <= t1]
        names = [fd["name"] for fd in d["schema"]["fields"] if fd["name"] != "time"]
        cols = {"t": np.array([o["t"] for o in obs])}
        for n in names:
            col = np.empty(len(obs), dtype=object)
            col[:] = [o["record"].get(n) for o in obs]
            cols[n] = col
    if latest and len(cols["t"]):
        cols = {k: v[-1:] for k, v in cols.items()}
    total = len(cols["t"])
    return {k: v[offset:offset + lim] for k, v in cols.items()}, total


def _column(fd, v):
    v = np.asarray(v)
    if fd["type"] == "Time":
        out = iso_many(v.astype(float))
        return [None if not np.isfinite(x) else s for x, s in zip(v.astype(float), out)]
    if v.dtype == object:
        return [None if (isinstance(x, float) and not np.isfinite(x)) else x for x in v.tolist()]
    if fd["type"] == "Quantity":
        return [None if x != x else x for x in np.round(v.astype(float), PRECISION).tolist()]
    if fd["type"] == "Count":
        return [None if x != x else int(x) for x in v.astype(float).tolist()]
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
            columns.append((fd["name"], _column(fd, cols[fd["name"]])))
        elif fd["type"] == "Category" and fd["name"].endswith("_qc"):
            columns.append((fd["name"], [None] * len(t)))
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

"""EDR server (B-C07) and analysis endpoints, as one plain ASGI application.

An honest subset of OGC API - Environmental Data Retrieval (FR-16, FR-17):
discovery, trajectory and corridor queries, CoverageJSON only. Everything not
supported is refused with the thing refused named. The same application runs
in Pyodide behind the Service Worker and under any ASGI server (NFR-03).
"""
from __future__ import annotations

import json
import math
import re
import time
from pathlib import Path
from urllib.parse import parse_qsl

import numpy as np

from . import analysis as A
from . import config as C
from . import covjson as CJ
from . import qc as Q
from . import scoring as S
from .clock import SimClock
from .world import PARAM_META, PARAMS, lonlat_to_local, public_canal

SENSOR_COLLECTIONS = {
    "bow": "Bow weather sensor",
    "stern": "Stern weather sensor",
}
ANALYSIS_COLLECTIONS = {
    "analysis-derived": "Derived values: true wind, pressure at datum, dew point, bow minus stern with lag correction",
    "analysis-changes": "Detected changes, each attributed to place or weather",
    "analysis-clusters": "Readings clustered into regimes",
    "analysis-correlation": "Correlation matrix over a window",
    "analysis-reach-offsets": "Standing offset of each reach, estimated from revisits",
}
CONFORMANCE = [
    "http://www.opengis.net/spec/ogcapi-common-1/1.0/conf/core",
    "http://www.opengis.net/spec/ogcapi-common-2/1.0/conf/collections",
    "http://www.opengis.net/spec/ogcapi-edr-1/1.1/conf/core",
    "http://www.opengis.net/spec/ogcapi-edr-1/1.1/conf/collections",
    "http://www.opengis.net/spec/ogcapi-edr-1/1.1/conf/json",
    "http://www.opengis.net/spec/ogcapi-edr-1/1.1/conf/covjson",
]
COVJSON_MEDIA = "application/prs.coverage+json"
CRS_ACCEPTED = {"CRS84", "OGC:CRS84", CJ.CRS84}
F_ACCEPTED = {"CoverageJSON", "covjson", COVJSON_MEDIA}
COMMON_QUERY = {"coords", "datetime", "parameter-name", "crs", "f"}
CORRIDOR_QUERY = COMMON_QUERY | {"corridor-width", "width-units"}
ANALYSIS_QUERY = COMMON_QUERY | {"window-hours", "sensor", "clusters", "sensitivity"}
KNOWN_BUT_UNSUPPORTED = {
    "z": "vertical selection: the sensors are at the surface",
    "corridor-height": "corridor height: the sensors are at the surface",
    "height-units": "corridor height: the sensors are at the surface",
    "resolution-x": "resampling", "resolution-y": "resampling", "resolution-z": "resampling",
    "bbox": "bbox on trajectory or corridor queries",
    "limit": "paging of coverages",
}
DERIVED_PARAMS = {
    "true_wind_speed": ("True wind speed", "m/s"),
    "true_wind_direction": ("True wind direction (from, degrees true)", "deg"),
    "pressure_reduced": ("Pressure reduced to sea-level datum", "hPa"),
    "dew_point": ("Dew point", "Cel"),
    "air_minus_water": ("Air minus water temperature", "Cel"),
    "bow_minus_stern_air_temperature": ("Bow minus stern air temperature, same instant", "Cel"),
    "bow_minus_stern_air_temperature_lag_corrected": ("Bow minus stern air temperature, lag corrected", "Cel"),
    "bow_minus_stern_relative_humidity": ("Bow minus stern humidity, same instant", "%"),
    "bow_minus_stern_relative_humidity_lag_corrected": ("Bow minus stern humidity, lag corrected", "%"),
    "speed": ("Boat speed over ground", "m/s"),
    "heading": ("Boat heading (degrees true)", "deg"),
}
DECIMALS = {"air_temperature": 1, "relative_humidity": 0, "pressure": 1, "apparent_wind_speed": 1,
            "apparent_wind_direction": 0, "solar_irradiance": 0, "water_temperature": 1}
DERIVED_STEP = 10  # derived series are served every tenth second


def _contracts_dir() -> Path:
    here = Path(__file__).resolve().parent
    for cand in (here.parent / "contracts", here.parent.parent / "contracts"):
        if cand.is_dir():
            return cand
    raise FileNotFoundError("contracts directory not found")


class Refusal(Exception):
    def __init__(self, status: int, code: str, description: str, refused: str | None = None, **extra):
        super().__init__(description)
        self.status, self.code, self.description, self.refused, self.extra = status, code, description, refused, extra

    def body(self) -> dict:
        b = {"code": self.code, "description": self.description}
        if self.refused:
            b["refused"] = self.refused
        b.update(self.extra)
        return b


# --- query parsing -----------------------------------------------------------

_NUM = r"[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?"


def parse_coords(text: str):
    """WKT LINESTRING or LINESTRINGM; anything else is refused by name."""
    m = re.fullmatch(r"\s*(LINESTRING\s*M?|[A-Z]+[A-Z ]*?)\s*\((.*)\)\s*", text, re.I | re.S)
    if not m:
        raise Refusal(400, "InvalidParameterValue", "coords must be WKT, e.g. LINESTRING(x y, x y)", "coords")
    kind = re.sub(r"\s+", "", m.group(1).upper())
    if kind not in ("LINESTRING", "LINESTRINGM"):
        raise Refusal(400, "OperationNotSupported",
                      f"coords geometry {kind} is not supported: use LINESTRING or LINESTRINGM", f"coords:{kind}")
    pts = []
    for part in m.group(2).split(","):
        nums = re.findall(_NUM, part)
        want = 3 if kind == "LINESTRINGM" else 2
        if len(nums) != want:
            raise Refusal(400, "InvalidParameterValue",
                          f"each {kind} vertex needs {want} numbers; got '{part.strip()}'", "coords")
        pts.append([float(n) for n in nums])
    if len(pts) < 2:
        raise Refusal(400, "InvalidParameterValue", "a LINESTRING needs at least two vertices", "coords")
    arr = np.array(pts)
    if kind == "LINESTRINGM":
        arr[:, 2] -= C.SIM_EPOCH_UNIX  # M is epoch seconds; work in simulated seconds
        if np.any(np.diff(arr[:, 2]) < 0):
            raise Refusal(400, "InvalidParameterValue", "LINESTRINGM times must not decrease", "coords")
    return kind, arr


def parse_datetime(text: str | None, now: float):
    if text is None:
        return None
    try:
        if "/" in text:
            a, b = text.split("/", 1)
            t0 = -math.inf if a in ("", "..") else CJ.parse_iso(a)
            t1 = now if b in ("", "..") else CJ.parse_iso(b)
        else:
            t0 = t1 = CJ.parse_iso(text)
    except ValueError as e:
        raise Refusal(400, "InvalidParameterValue", f"datetime: {e}", "datetime")
    if t1 < t0:
        raise Refusal(400, "InvalidParameterValue", "datetime interval ends before it starts", "datetime")
    return t0, t1


def _dist_to_path(px, py, vx, vy):
    best = np.full(len(px), np.inf)
    for i in range(len(vx) - 1):
        ax, ay, bx, by = vx[i], vy[i], vx[i + 1], vy[i + 1]
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy
        if L2 == 0:
            d = np.hypot(px - ax, py - ay)
        else:
            u = np.clip(((px - ax) * dx + (py - ay) * dy) / L2, 0, 1)
            d = np.hypot(px - (ax + u * dx), py - (ay + u * dy))
        np.minimum(best, d, out=best)
    return best


# --- the application -----------------------------------------------------------

class App:
    """ASGI application. ``sim`` provides tick(), adapter, clock, manifest, world."""

    def __init__(self, sim):
        self.sim = sim
        self.canal = public_canal(sim.manifest)
        self.chart = A.Chart(self.canal)
        cdir = _contracts_dir()
        self.openapi = json.loads((cdir / "openapi.json").read_text())

    # ASGI entry point
    async def __call__(self, scope, receive, send):
        if scope["type"] == "lifespan":
            while True:
                msg = await receive()
                if msg["type"] == "lifespan.startup":
                    await send({"type": "lifespan.startup.complete"})
                elif msg["type"] == "lifespan.shutdown":
                    await send({"type": "lifespan.shutdown.complete"})
                    return
        if scope["type"] != "http":
            return
        body = b""
        while True:
            msg = await receive()
            body += msg.get("body", b"")
            if not msg.get("more_body"):
                break
        root = scope.get("root_path", "") or ""
        path = scope["path"]
        if root and path.startswith(root):
            path = path[len(root):]
        query = scope.get("query_string", b"").decode("latin-1")
        status, ctype, payload, headers = self.handle(scope["method"], path or "/", query, body, root)
        hdrs = [(b"content-type", ctype.encode()), (b"content-length", str(len(payload)).encode()),
                (b"cache-control", b"no-store")]
        hdrs += [(k.encode(), v.encode()) for k, v in headers.items()]
        await send({"type": "http.response.start", "status": status, "headers": hdrs})
        await send({"type": "http.response.body", "body": payload})

    def handle(self, method, path, query, body, root=""):
        started = time.perf_counter()
        try:
            status, ctype, payload = self._route(method, path.rstrip("/") or "/", query, body, root)
        except Refusal as r:
            status, ctype, payload = r.status, "application/json", json.dumps(r.body()).encode()
        except A.BoundError as e:
            status, ctype, payload = 400, "application/json", json.dumps(
                {"code": "InvalidParameterValue", "description": str(e), "refused": e.name.replace("_", "-")}).encode()
        ms = (time.perf_counter() - started) * 1000.0
        return status, ctype, payload, {"x-elapsed-ms": f"{ms:.1f}"}

    # --- routing -----------------------------------------------------------
    def _route(self, method, path, query, body, root):
        q = self._query(query)
        parts = [p for p in path.split("/") if p]
        if method == "PUT" and parts == ["sim", "clock"]:
            return self._json(self._set_clock(body))
        if method == "DELETE" and parts == ["sim", "index"]:
            self.sim.adapter.reset()
            return self._json({"index": "dropped; it is rebuilt from the store on the next request"})
        if method not in ("GET", "HEAD"):
            raise Refusal(405, "MethodNotAllowed", f"method {method} is not supported on {path}", method)
        self._sync()
        if parts == []:
            self._only(q, {"f"})
            return self._json(self._landing(root))
        if parts == ["conformance"]:
            self._only(q, {"f"})
            return self._json({"conformsTo": CONFORMANCE})
        if parts == ["api"]:
            return 200, "application/vnd.oai.openapi+json;version=3.1", json.dumps(self.openapi).encode()
        if parts == ["collections"]:
            self._only(q, {"f"})
            return self._json({"links": [self._link(root, "/collections", "self")],
                               "collections": [self._collection(c, root) for c in self._collection_ids()]})
        if len(parts) >= 2 and parts[0] == "collections":
            cid = parts[1]
            if cid not in self._collection_ids():
                raise Refusal(404, "NotFound", f"collection {cid} does not exist", f"collection:{cid}")
            if len(parts) == 2:
                self._only(q, {"f"})
                return self._json(self._collection(cid, root))
            if len(parts) == 3:
                qt = parts[2]
                if cid in SENSOR_COLLECTIONS:
                    if qt == "trajectory":
                        return self._cov(self._sensor_query(cid, q, corridor=False))
                    if qt == "corridor":
                        return self._cov(self._sensor_query(cid, q, corridor=True))
                elif qt == "trajectory":
                    return self._cov(self._analysis_query(cid, q))
                raise Refusal(400, "OperationNotSupported",
                              f"query type {qt} is not supported on {cid}", f"query:{qt}")
        if parts == ["sim", "clock"]:
            return self._json(self._clock_state())
        if parts == ["sim", "canal"]:
            return self._json(self.canal)
        if parts == ["sim", "manifest"]:
            return self._json(self.sim.manifest)
        if parts == ["sim", "boat"]:
            return self._json(self._boat_now())
        raise Refusal(404, "NotFound", f"no resource at {path}", f"path:{path}")

    def _sync(self):
        self.sim.tick()
        self.sim.adapter.refresh()

    @staticmethod
    def _json(obj, status=200):
        return status, "application/json", CJ.dumps(obj)

    @staticmethod
    def _cov(obj):
        return 200, COVJSON_MEDIA, CJ.dumps(obj)

    @staticmethod
    def _query(query: str) -> dict:
        out = {}
        for k, v in parse_qsl(query, keep_blank_values=True):
            if k in out:
                raise Refusal(400, "InvalidParameterValue", f"query parameter {k} given more than once", k)
            out[k] = v
        return out

    @staticmethod
    def _only(q: dict, allowed: set):
        for k in q:
            if k in allowed:
                continue
            if k in KNOWN_BUT_UNSUPPORTED:
                raise Refusal(400, "OptionNotSupported",
                              f"{k} is not supported ({KNOWN_BUT_UNSUPPORTED[k]})", k)
            raise Refusal(400, "InvalidParameterName", f"unknown query parameter {k}", k)
        if "f" in q and q["f"] not in F_ACCEPTED | {"json", "application/json"}:
            raise Refusal(400, "OptionNotSupported", f"format f={q['f']} is not supported; only JSON and CoverageJSON", "f")
        if "crs" in q and q["crs"] not in CRS_ACCEPTED:
            raise Refusal(400, "OptionNotSupported", f"crs {q['crs']} is not supported; only CRS84", "crs")

    @staticmethod
    def _link(root, href, rel, type_="application/json", title=None):
        lk = {"href": root + href, "rel": rel, "type": type_}
        if title:
            lk["title"] = title
        return lk

    def _collection_ids(self):
        return list(SENSOR_COLLECTIONS) + list(ANALYSIS_COLLECTIONS)

    def _landing(self, root):
        return {
            "title": "Canal barge weather demonstrator: EDR facade",
            "description": ("An OGC API-EDR facade over a deliberately awkward logger stand-in. "
                            "Everything is fictional: canal, places and weather. The facade is shown "
                            "working over an awkward store, to be confirmed against a real one."),
            "links": [
                self._link(root, "/", "self"),
                self._link(root, "/api", "service-desc", "application/vnd.oai.openapi+json;version=3.1"),
                self._link(root, "/conformance", "conformance"),
                self._link(root, "/collections", "data"),
            ],
        }

    # --- collection metadata ---------------------------------------------
    def _extent(self):
        tr = [self.sim.adapter.time_range(s) for s in SENSOR_COLLECTIONS]
        tr = [x for x in tr if x]
        cl = self.canal["centreline"]
        pad = 0.002
        bbox = [min(cl["lon"]) - pad, min(cl["lat"]) - pad, max(cl["lon"]) + pad, max(cl["lat"]) + pad]
        temporal = [CJ.iso1(min(a for a, _ in tr)), CJ.iso1(max(b for _, b in tr))] if tr else [None, None]
        return {"spatial": {"bbox": [bbox], "crs": CJ.CRS84},
                "temporal": {"interval": [temporal], "trs": "http://www.opengis.net/def/uom/ISO-8601/0/Gregorian"}}

    def _collection(self, cid, root):
        base = f"/collections/{cid}"
        links = [self._link(root, base, "self")]
        dq = {}
        if cid in SENSOR_COLLECTIONS:
            title = SENSOR_COLLECTIONS[cid]
            params = {p: self._param_def(p) for p in PARAMS}
            for qt, variables in (("trajectory", sorted(COMMON_QUERY)), ("corridor", sorted(CORRIDOR_QUERY))):
                dq[qt] = {"link": {"href": root + f"{base}/{qt}", "rel": "data",
                                   "variables": {"query_type": qt, "output_formats": ["CoverageJSON"],
                                                 "default_output_format": "CoverageJSON",
                                                 "crs_details": [{"crs": "CRS84", "wkt": "GEOGCS[\"WGS 84\"]"}],
                                                 "barge:accepted_query_parameters": variables}}}
        else:
            title = ANALYSIS_COLLECTIONS[cid]
            params = self._analysis_param_defs(cid)
            dq["trajectory"] = {"link": {"href": root + f"{base}/trajectory", "rel": "data",
                                         "variables": {"query_type": "trajectory", "output_formats": ["CoverageJSON"],
                                                       "default_output_format": "CoverageJSON",
                                                       "barge:accepted_query_parameters": sorted(ANALYSIS_QUERY)}}}
        out = {
            "id": cid,
            "title": title,
            "links": links,
            "extent": self._extent(),
            "data_queries": dq,
            "crs": ["CRS84"],
            "output_formats": ["CoverageJSON"],
            "parameter_names": params,
            "barge:limits": {
                "max_response_points": C.MAX_RESPONSE_POINTS,
                "trajectory_tolerance_m": C.TRAJECTORY_TOLERANCE_M,
                "query_budget_ms": C.QUERY_BUDGET_MS,
            },
        }
        if cid not in SENSOR_COLLECTIONS:
            out["barge:analysis_parameters"] = self._analysis_schema()
        return out

    @staticmethod
    def _param_def(p):
        meta = PARAM_META[p]
        return CJ.parameter(meta["label"], meta["symbol"], meta["unit"])

    def _analysis_param_defs(self, cid):
        if cid == "analysis-derived":
            return {k: CJ.parameter(lbl, sym) for k, (lbl, sym) in DERIVED_PARAMS.items()}
        if cid == "analysis-changes":
            return {"cause": CJ.parameter("Attributed cause", categories={"place": 0, "weather": 1}),
                    "strength": CJ.parameter("Strength of the change", "1"),
                    "scale": CJ.parameter("Scale of the change", categories={"minutes": 0, "hours": 1})}
        if cid == "analysis-clusters":
            return {"cluster": CJ.parameter("Regime (cluster)", categories={f"c{i}": i for i in range(C.ANALYSIS_BOUNDS['clusters']['maximum'])})}
        if cid == "analysis-correlation":
            return {"correlation": CJ.parameter("Pearson correlation", "1")}
        if cid == "analysis-reach-offsets":
            out = {"passes": CJ.parameter("Passes the estimate rests on", "1")}
            for p in A.OFFSET_PARAMS:
                meta = PARAM_META[p]
                out[f"offset_{p}"] = CJ.parameter(f"Standing offset: {meta['label']}", meta["symbol"])
                out[f"se_{p}"] = CJ.parameter(f"Standard error: {meta['label']}", meta["symbol"])
            return out
        return {}

    @staticmethod
    def _analysis_schema():
        b = C.ANALYSIS_BOUNDS
        choices = A.CLUSTER_FEATURES + [p for p in PARAMS if p not in A.CLUSTER_FEATURES] + ["true_wind_direction", "air_minus_water"]
        return {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "type": "object",
            "properties": {
                "window-hours": {"type": "number", **{k: b["window_hours"][k] for k in ("minimum", "maximum", "default")},
                                 "description": "length of the window, ending now; exclusive with datetime"},
                "sensor": {"type": "string", "enum": ["bow", "stern"], "default": "bow"},
                "parameter-name": {"type": "array", "items": {"type": "string", "enum": choices},
                                   "description": "parameters for correlation and clustering"},
                "clusters": {"type": "integer", **{k: b["clusters"][k] for k in ("minimum", "maximum", "default")}},
                "sensitivity": {"type": "number", **{k: b["sensitivity"][k] for k in ("minimum", "maximum", "default")}},
            },
        }

    # --- clock -----------------------------------------------------------------
    def _clock_state(self):
        now = self.sim.now()
        return {
            "now": CJ.iso1(now),
            "t": now,
            "rate": self.sim.clock.rate,
            "statement": SimClock.statement(),
            "records": {s: self.sim.adapter.count(s) for s in SENSOR_COLLECTIONS},
            "store_bytes": self.sim.logger.total_bytes(),
            "files": len(self.sim.logger.list_files()),
            "seed": self.sim.seed,
        }

    def _set_clock(self, body: bytes):
        try:
            req = json.loads(body or b"{}")
        except json.JSONDecodeError:
            raise Refusal(400, "InvalidParameterValue", "body must be JSON", "body")
        for k in req:
            if k != "rate":
                raise Refusal(400, "InvalidParameterName", f"unknown clock field {k}", k)
        if "rate" in req:
            if req["rate"] not in C.CLOCK_RATES:
                raise Refusal(400, "InvalidParameterValue",
                              f"rate {req['rate']} is not accepted; accepted rates are {C.CLOCK_RATES}", "rate")
            self.sim.clock.set_rate(req["rate"])
        self._sync()
        return self._clock_state()

    def _boat_now(self):
        # The boat's last reported position, as the store holds it.
        cols = self.sim.adapter.columns("bow")
        if len(cols["t"]) == 0:
            return {}
        i = len(cols["t"]) - 1
        lat, lon, flag = Q.fill_positions(cols["t"][-3000:], cols["lat"][-3000:], cols["lon"][-3000:])
        return {"t": CJ.iso1(cols["t"][i]), "lon": float(lon[-1]), "lat": float(lat[-1]),
                "position_qc": int(flag[-1])}

    # --- data selection ---------------------------------------------------------
    def _records(self, sensor, t0, t1):
        ad = self.sim.adapter
        n = ad.count(sensor)
        i0, i1 = ad.slice_by_time(sensor, t0, t1)
        pad = 2000
        p0, p1 = max(0, i0 - pad), min(n, i1 + pad)
        cols = {k: v[p0:p1] for k, v in ad.columns(sensor).items()}
        lat, lon, pflag = Q.fill_positions(cols["t"], cols["lat"], cols["lon"])
        a, b = i0 - p0, i1 - p0
        out = {k: v[a:b] for k, v in cols.items()}
        out["raw_lat"], out["raw_lon"] = out["lat"], out["lon"]
        out["lat"], out["lon"], out["position_qc"] = lat[a:b], lon[a:b], pflag[a:b]
        for p in PARAMS:
            f = Q.flags(p, cols[p], cols["wd_code"] if p == "apparent_wind_direction" else None)
            out[f"{p}_qc"] = f[a:b]
        return out

    def _match(self, rec, kind, coords, corridor_m=None):
        px, py = lonlat_to_local(rec["lon"], rec["lat"])
        vx, vy = lonlat_to_local(coords[:, 0], coords[:, 1])
        if kind == "LINESTRINGM":
            tm = coords[:, 2]
            inside = (rec["t"] >= tm[0]) & (rec["t"] <= tm[-1])
            ex = np.interp(rec["t"], tm, vx)
            ey = np.interp(rec["t"], tm, vy)
            d = np.hypot(px - ex, py - ey)
            return inside & (d <= (corridor_m or C.TRAJECTORY_TOLERANCE_M))
        d = _dist_to_path(px, py, vx, vy)
        return d <= (corridor_m if corridor_m is not None else C.TRAJECTORY_TOLERANCE_M)

    def _common(self, q):
        if "coords" not in q:
            raise Refusal(400, "MissingParameterValue", "coords is required", "coords")
        kind, coords = parse_coords(q["coords"])
        now = self.sim.now()
        dt = parse_datetime(q.get("datetime"), now)
        if kind == "LINESTRINGM":
            t0, t1 = coords[0, 2], coords[-1, 2]
            if dt:
                t0, t1 = max(t0, dt[0]), min(t1, dt[1])
        elif dt:
            t0, t1 = dt
        else:
            t0, t1 = -math.inf, now
        return kind, coords, t0, t1

    def _param_names(self, q, available):
        if "parameter-name" not in q:
            return list(available)
        names = [n.strip() for n in q["parameter-name"].split(",") if n.strip()]
        for n in names:
            if n not in available:
                raise Refusal(400, "InvalidParameterValue", f"parameter {n} is not served here", f"parameter-name:{n}")
        return names

    def _size_check(self, n, what="points"):
        if n > C.MAX_RESPONSE_POINTS:
            raise Refusal(413, "ResponseTooLarge",
                          f"the result would hold {n} {what}, over the limit of {C.MAX_RESPONSE_POINTS}. "
                          "Narrow it: give a shorter datetime interval or a shorter path.",
                          "size", limit=C.MAX_RESPONSE_POINTS, matched=int(n),
                          advice="shorten datetime, or query a shorter stretch of canal")

    def _sensor_query(self, sensor, q, corridor: bool):
        self._only(q, CORRIDOR_QUERY if corridor else COMMON_QUERY)
        kind, coords, t0, t1 = self._common(q)
        width = None
        if corridor:
            if kind != "LINESTRING":
                raise Refusal(400, "OperationNotSupported", "corridor coords must be a LINESTRING", "coords")
            if "corridor-width" not in q:
                raise Refusal(400, "MissingParameterValue", "corridor-width is required", "corridor-width")
            units = q.get("width-units", "m")
            if units not in ("m", "metre", "meter"):
                raise Refusal(400, "OptionNotSupported", f"width-units {units} is not supported; only m", "width-units")
            try:
                width = float(q["corridor-width"]) / 2.0
            except ValueError:
                raise Refusal(400, "InvalidParameterValue", "corridor-width must be a number", "corridor-width")
            if not 0 < width <= 5000:
                raise Refusal(400, "InvalidParameterValue", "corridor-width must be between 0 and 10000 m", "corridor-width")
        names = self._param_names(q, PARAMS)
        rec = self._records(sensor, t0, t1)
        mask = self._match(rec, kind, coords, width)
        n = int(mask.sum())
        self._size_check(n)
        params, ranges = {}, {}
        for p in names:
            params[p] = self._param_def(p)
            ranges[p] = CJ.ndarray(rec[p][mask], decimals=DECIMALS[p])
            params[f"{p}_qc"] = CJ.parameter(f"QC flag: {PARAM_META[p]['label']}", categories=Q.QC_CATEGORIES)
            ranges[f"{p}_qc"] = CJ.ndarray(rec[f"{p}_qc"][mask], "integer")
        params["position_qc"] = CJ.parameter("QC flag: position", categories=Q.POSITION_CATEGORIES)
        ranges["position_qc"] = CJ.ndarray(rec["position_qc"][mask], "integer")
        return CJ.trajectory(rec["t"][mask], rec["lon"][mask], rec["lat"][mask], params, ranges,
                             {"barge:query": {"sensor": sensor, "matched": n, "records_considered": int(len(rec["t"]))}})

    # --- analysis --------------------------------------------------------------
    def _analysis_inputs(self, q):
        self._only(q, ANALYSIS_QUERY)
        if "datetime" in q and "window-hours" in q:
            raise Refusal(400, "InvalidParameterValue", "give either datetime or window-hours, not both", "window-hours")
        bounds = A.check_bounds({
            "window_hours": q.get("window-hours", C.ANALYSIS_BOUNDS["window_hours"]["default"]),
            "clusters": q.get("clusters", C.ANALYSIS_BOUNDS["clusters"]["default"]),
            "sensitivity": q.get("sensitivity", C.ANALYSIS_BOUNDS["sensitivity"]["default"]),
        })
        sensor = q.get("sensor", "bow")
        if sensor not in SENSOR_COLLECTIONS:
            raise Refusal(400, "InvalidParameterValue", f"sensor {sensor} is not one of bow, stern", "sensor")
        kind, coords, t0, t1 = self._common(q)
        if "datetime" not in q and kind == "LINESTRING":
            t0 = max(t0, t1 - bounds["window_hours"] * 3600.0)
        if not math.isfinite(t0):
            tr = self.sim.adapter.time_range("bow")
            t0 = tr[0] if tr else 0.0
        if t1 - t0 > C.ANALYSIS_BOUNDS["window_hours"]["maximum"] * 3600.0 + 1:
            raise Refusal(400, "InvalidParameterValue",
                          f"analysis window longer than the maximum of {C.ANALYSIS_BOUNDS['window_hours']['maximum']} hours",
                          "datetime")
        sets = {}
        for s in SENSOR_COLLECTIONS:
            rec = self._records(s, t0, t1)
            mask = self._match(rec, kind, coords)
            clean = {"t": rec["t"][mask], "lon": rec["lon"][mask], "lat": rec["lat"][mask],
                     "alt": self._fill_alt(rec)[mask]}
            for p in PARAMS:
                v = rec[p][mask].copy()
                v[rec[f"{p}_qc"][mask] != Q.GOOD] = np.nan
                clean[p] = v
            sets[s] = clean
        if len(sets["bow"]["t"]) < 60 or len(sets["stern"]["t"]) < 60:
            raise Refusal(400, "InvalidParameterValue", "too few records in the window for analysis (need 60)", "window-hours")
        d = A.derived(sets["bow"], sets["stern"], self.chart)
        if sensor == "stern":
            _, ib, is_ = A.align(sets["bow"], sets["stern"])
            for p in PARAMS:
                d[p] = sets["stern"][p][is_]
        params = {"window_hours": bounds["window_hours"] if "datetime" not in q else None,
                  "sensor": sensor, "clusters": bounds["clusters"], "sensitivity": bounds["sensitivity"],
                  "datetime": q.get("datetime"), "coords_kind": kind}
        data_range = {"start": CJ.iso1(d["t"][0]), "end": CJ.iso1(d["t"][-1]), "records": int(len(d["t"]))}
        return d, params, data_range, q

    @staticmethod
    def _fill_alt(rec):
        alt = rec["alt"]
        ok = ~np.isnan(alt)
        if ok.all() or not ok.any():
            return alt
        return np.interp(rec["t"], rec["t"][ok], alt[ok])

    def _analysis_query(self, cid, q):
        d, params, data_range, q = self._analysis_inputs(q)
        world = self.sim.world
        meta = {"parameters": params, "data_range": data_range}
        if cid == "analysis-derived":
            names = self._param_names(q, list(DERIVED_PARAMS))
            idx = np.arange(0, len(d["t"]), DERIVED_STEP)
            self._size_check(len(idx))
            meta["scores"] = {"true_wind": S.score_true_wind(world, d["t"][idx], d["true_wind_speed"][idx],
                                                             d["true_wind_direction"][idx]),
                              "lag_correction": S.score_lag(world, d)}
            meta["method"] = ("Heading from the stern-to-bow GPS baseline; velocity from the smoothed track; "
                              "true wind = apparent wind + boat velocity; pressure reduced with 0.12 hPa/m "
                              "using GPS altitude; lag correction shifts the stern by measured separation / speed.")
            params_out = {n: CJ.parameter(*DERIVED_PARAMS[n]) for n in names}
            ranges = {n: CJ.ndarray(d[n][idx], decimals=2) for n in names}
            return CJ.trajectory(d["t"][idx], d["lon"][idx], d["lat"][idx], params_out, ranges, {"barge:analysis": meta})
        if cid == "analysis-correlation":
            names = self._feature_names(q, d)
            R, n = A.correlation(d, names)
            meta["data_range"]["complete_rows"] = n
            meta["parameters"]["parameter-name"] = names
            return CJ.categorical_grid({"row": names, "col": names},
                                       {"correlation": CJ.parameter("Pearson correlation", "1")},
                                       {"correlation": {"type": "NdArray", "dataType": "float", "axisNames": ["row", "col"],
                                                        "shape": [len(names), len(names)],
                                                        "values": [None if np.isnan(x) else round(float(x), 4) for x in R.ravel()]}},
                                       {"barge:analysis": meta})
        if cid == "analysis-clusters":
            names = self._feature_names(q, d)
            idx, labels = A.cluster(d, params["clusters"], names)
            meta["parameters"]["parameter-name"] = names
            meta["scores"] = S.score_clusters(world, d["t"][idx], labels)
            return CJ.trajectory(d["t"][idx], d["lon"][idx], d["lat"][idx],
                                 {"cluster": self._analysis_param_defs(cid)["cluster"]},
                                 {"cluster": CJ.ndarray(labels, "integer")}, {"barge:analysis": meta})
        if cid == "analysis-changes":
            det = A.detect_changes(d, self.chart, params["sensitivity"])
            meta["scores"] = S.score_changes(world, det, d["t"][0], d["t"][-1])
            meta["method"] = A.detect_changes.__doc__.strip().replace("\n    ", " ")
            pd = self._analysis_param_defs(cid)
            return CJ.trajectory(det["t"], det["lon"], det["lat"], pd,
                                 {"cause": CJ.ndarray(det["cause"], "integer"),
                                  "strength": CJ.ndarray(det["strength"], decimals=1),
                                  "scale": CJ.ndarray(det["scale"], "integer")}, {"barge:analysis": meta})
        if cid == "analysis-reach-offsets":
            res = A.reach_offsets(d, self.chart)
            meta["scores"] = S.score_offsets(world, res)
            ranges = {"passes": {"type": "NdArray", "dataType": "integer", "axisNames": ["reach"],
                                 "shape": [len(res["reach"])], "values": [int(x) for x in res["passes"]]}}
            for p in A.OFFSET_PARAMS:
                for pre, key in (("offset", p), ("se", f"{p}_se")):
                    ranges[f"{pre}_{p}"] = {"type": "NdArray", "dataType": "float", "axisNames": ["reach"],
                                            "shape": [len(res["reach"])],
                                            "values": [None if np.isnan(x) else round(float(x), 3) for x in res[key]]}
            return CJ.categorical_grid({"reach": res["reach"]}, self._analysis_param_defs(cid), ranges,
                                       {"barge:analysis": meta})
        raise Refusal(404, "NotFound", f"collection {cid} does not exist", cid)

    def _feature_names(self, q, d):
        schema = self._analysis_schema()["properties"]["parameter-name"]["items"]["enum"]
        if "parameter-name" not in q:
            return list(A.CLUSTER_FEATURES)
        names = [n.strip() for n in q["parameter-name"].split(",") if n.strip()]
        for n in names:
            if n not in schema:
                raise Refusal(400, "InvalidParameterValue", f"parameter {n} is not available for analysis", f"parameter-name:{n}")
        if len(names) < 2:
            raise Refusal(400, "InvalidParameterValue", "give at least two parameters", "parameter-name")
        return names


def create_app(seed: int = 1, clock=None, warm_start: float = C.WARM_START_S) -> App:
    from .sim import Simulation

    return App(Simulation(seed=seed, clock=clock, warm_start=warm_start))


def app_factory():
    """For ordinary ASGI servers: ``uvicorn --factory barge.edr:app_factory``."""
    import os

    return create_app(seed=int(os.environ.get("BARGE_SEED", "1")))

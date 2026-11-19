"""Helpers for the analyst's workspace: an ordinary EDR client.

Scripts reach the backend only through the seam (FR-27): ``get`` fetches a
relative URL, which the Service Worker hands to the backend worker. Nothing
here imports the backend.

    import edr
    cov = await edr.get("collections/bow/trajectory", coords=await edr.route(), datetime="2031-04-07T03:00:00Z/..")
    df = edr.to_frame(cov)
    edr.promote("my-series", edr.trajectory(df.index, df.lon, df.lat, {"x": df.x}))
"""
from __future__ import annotations

import json
from urllib.parse import urlencode

API_BASE = None  # set by the worker at start-up: the page's api/ URL
_promoted: dict = {}
_route = None


async def get(path: str, **params):
    from pyodide.http import pyfetch

    q = urlencode({k.replace("_", "-"): v for k, v in params.items()})
    r = await pyfetch(API_BASE + path + ("?" + q if q else ""))
    body = await r.json()
    if r.status >= 400:
        raise RuntimeError(f"{r.status}: {body.get('description', body)}")
    return body


async def get_raw(path: str, params=None):
    """(status, json) without raising: for the contract suite."""
    from pyodide.http import pyfetch

    q = urlencode(params or {})
    r = await pyfetch(API_BASE + path + ("?" + q if q else ""))
    try:
        body = await r.json()
    except Exception:  # noqa: BLE001
        body = {}
    return r.status, body


async def put_raw(path: str, body: dict):
    from pyodide.http import pyfetch

    r = await pyfetch(API_BASE + path, method="PUT", body=json.dumps(body),
                      headers={"content-type": "application/json"})
    return r.status, await r.json()


async def route() -> str:
    """The canal's centreline as a WKT LINESTRING, for trajectory queries."""
    global _route
    if _route is None:
        canal = await get("sim/canal")
        cl = canal["centreline"]
        _route = "LINESTRING(" + ",".join(f"{x} {y}" for x, y in zip(cl["lon"], cl["lat"])) + ")"
    return _route


async def recent(hours: float) -> str:
    """A datetime interval covering the last `hours` of simulated time."""
    import datetime as dt

    clock = await get("sim/clock")
    now = dt.datetime.fromisoformat(clock["now"].replace("Z", "+00:00"))
    return (now - dt.timedelta(hours=hours)).strftime("%Y-%m-%dT%H:%M:%SZ") + "/.."


def to_frame(cov):
    """A CoverageJSON trajectory as a pandas DataFrame indexed by time."""
    import pandas as pd

    vals = cov["domain"]["axes"]["composite"]["values"]
    df = pd.DataFrame({
        "t": pd.to_datetime([v[0] for v in vals]),
        "lon": [v[1] for v in vals],
        "lat": [v[2] for v in vals],
    })
    for name, r in cov["ranges"].items():
        df[name] = pd.Series(r["values"], dtype="float64")
    return df.set_index("t")


def trajectory(times, lon, lat, series: dict, units: dict | None = None, title: str = "", notes: dict | None = None):
    """Build a coverage in the promotion contract's shape (FR-25)."""
    import numpy as np

    times = [str(t).replace(" ", "T").split("+")[0].split(".")[0] + "Z" if not str(t).endswith("Z") else str(t)
             for t in times]
    lon = [float(x) for x in lon]
    lat = [float(x) for x in lat]
    params, ranges = {}, {}
    for name, values in series.items():
        v = np.asarray(values, dtype=float)
        params[name] = {"type": "Parameter", "observedProperty": {"label": {"en": name}},
                        "unit": {"symbol": (units or {}).get(name, "")}}
        ranges[name] = {"type": "NdArray", "dataType": "float", "axisNames": ["composite"], "shape": [len(v)],
                        "values": [None if x != x else round(float(x), 4) for x in v]}
    cov = {
        "type": "Coverage",
        "domain": {"type": "Domain", "domainType": "Trajectory",
                   "axes": {"composite": {"dataType": "tuple", "coordinates": ["t", "x", "y"],
                                          "values": [[t, x, y] for t, x, y in zip(times, lon, lat)]}}},
        "parameters": params, "ranges": ranges,
    }
    if title or notes:
        cov["barge:analysis"] = {"parameters": {"title": title}, "data_range": {
            "start": times[0] if times else None, "end": times[-1] if times else None, "records": len(times)},
            "scores": notes or {}}
    return cov


def promote(name: str, coverage: dict, title: str | None = None):
    """Serve a coverage at ws/collections/<name> (FR-29). The display picks it up."""
    if coverage.get("type") != "Coverage" or "domain" not in coverage or "ranges" not in coverage:
        raise ValueError("promote() takes a CoverageJSON Coverage")
    _promoted[name] = {"title": title or name, "coverage": coverage}
    print(f"promoted {name}: ws/collections/{name}")


def unpromote(name: str):
    _promoted.pop(name, None)


def serve(path: str):
    """Answer a request under ws/ from the promoted outputs (called by the worker)."""
    parts = [p for p in path.split("/") if p]
    if parts == ["collections"]:
        return 200, {"collections": [{"id": k, "title": v["title"]} for k, v in _promoted.items()]}
    if len(parts) == 2 and parts[0] == "collections" and parts[1] in _promoted:
        return 200, _promoted[parts[1]]["coverage"]
    return 404, {"code": "NotFound", "description": f"nothing promoted at {path}", "refused": f"path:{path}"}

"""CoverageJSON building blocks, shared by sensor data and analysis results.

The *promotion contract* (FR-25): anything served in these shapes is rendered
by the display with no code specific to it.
"""
from __future__ import annotations

import json

import numpy as np

from . import config as C

CRS84 = "http://www.opengis.net/def/crs/OGC/1.3/CRS84"
NS = {"barge": "https://deepbluecltd.github.io/barge-monitor/ns#"}


def iso(t) -> list[str]:
    t = np.asarray(t, dtype=float)
    secs = (C.SIM_EPOCH_UNIX + np.round(t)).astype("int64").astype("datetime64[s]")
    return [s + "Z" for s in secs.astype(str).tolist()]


def iso1(t: float) -> str:
    return iso([t])[0]


def parse_iso(s: str) -> float:
    s = s.strip()
    if s.endswith("Z"):
        s = s[:-1]
    if "+" in s[10:]:
        raise ValueError("only UTC (Z) times are supported")
    v = np.datetime64(s, "ms").astype("int64") / 1000.0
    return float(v - C.SIM_EPOCH_UNIX)


def parameter(label: str, unit_symbol: str | None = None, unit_label: str | None = None,
              description: str | None = None, categories: dict | None = None,
              barge: dict | None = None) -> dict:
    p = {"type": "Parameter", "observedProperty": {"label": {"en": label}}}
    if description:
        p["description"] = {"en": description}
    if categories is not None:
        p["observedProperty"]["categories"] = [
            {"id": f"barge:{k}", "label": {"en": k}} for k in categories
        ]
        p["categoryEncoding"] = {f"barge:{k}": v for k, v in categories.items()}
    else:
        p["unit"] = {"label": {"en": unit_label or unit_symbol or ""}, "symbol": unit_symbol or ""}
    if barge:
        p["barge:meta"] = barge
    return p


def ndarray(values, data_type="float", axis="composite", decimals: int | None = None) -> dict:
    v = np.asarray(values)
    if decimals is not None and v.dtype.kind == "f":
        v = np.round(v, decimals)
    return {"type": "NdArray", "dataType": data_type, "axisNames": [axis], "shape": [int(len(v))],
            "values": _RawList(v)}


def trajectory(t, lon, lat, parameters: dict, ranges: dict, extra: dict | None = None) -> dict:
    lon = np.round(np.asarray(lon, dtype=float), 6)
    lat = np.round(np.asarray(lat, dtype=float), 6)
    times = iso(t)
    cov = {
        "type": "Coverage",
        "@context": [NS],
        "domain": {
            "type": "Domain",
            "domainType": "Trajectory",
            "axes": {
                "composite": {
                    "dataType": "tuple",
                    "coordinates": ["t", "x", "y"],
                    "values": _RawTuples(times, lon, lat),
                }
            },
            "referencing": [
                {"coordinates": ["x", "y"], "system": {"type": "GeographicCRS", "id": CRS84}},
                {"coordinates": ["t"], "system": {"type": "TemporalRS", "calendar": "Gregorian"}},
            ],
        },
        "parameters": parameters,
        "ranges": ranges,
    }
    if extra:
        cov.update(extra)
    return cov


def categorical_grid(axes: dict, parameters: dict, ranges: dict, extra: dict | None = None) -> dict:
    """A coverage over named categorical axes (for example a correlation matrix)."""
    cov = {
        "type": "Coverage",
        "@context": [NS],
        "domain": {
            "type": "Domain",
            "domainType": "barge:Categorical",
            "axes": {k: {"dataType": "string", "values": list(v)} for k, v in axes.items()},
        },
        "parameters": parameters,
        "ranges": ranges,
    }
    if extra:
        cov.update(extra)
    return cov


# --- Fast JSON encoding of large arrays ------------------------------------
class _RawList:
    def __init__(self, arr):
        self.arr = arr


class _RawTuples:
    def __init__(self, times, lon, lat):
        self.times, self.lon, self.lat = times, lon, lat


def _encode_list(arr: np.ndarray) -> str:
    if arr.dtype.kind in "iub":
        return json.dumps(arr.astype(int).tolist())
    s = json.dumps(arr.astype(float).tolist(), allow_nan=True)
    return s.replace("NaN", "null").replace("Infinity", "null")


def dumps(obj) -> bytes:
    """json.dumps that streams the big arrays without building Python lists of floats twice."""
    placeholders = {}

    def walk(o):
        if isinstance(o, dict):
            return {k: walk(v) for k, v in o.items()}
        if isinstance(o, list):
            return [walk(v) for v in o]
        if isinstance(o, _RawList):
            key = f"@@raw{len(placeholders)}@@"
            placeholders[key] = _encode_list(o.arr)
            return key
        if isinstance(o, _RawTuples):
            key = f"@@raw{len(placeholders)}@@"
            lon = _encode_list(o.lon)[1:-1].split(", ") if len(o.lon) else []
            lat = _encode_list(o.lat)[1:-1].split(", ") if len(o.lat) else []
            placeholders[key] = "[" + ",".join(
                f'["{t}",{x},{y}]' for t, x, y in zip(o.times, lon, lat)
            ) + "]"
            return key
        if isinstance(o, (np.floating,)):
            v = float(o)
            return None if v != v else v
        if isinstance(o, (np.integer,)):
            return int(o)
        if isinstance(o, np.ndarray):
            return walk(o.tolist())
        if isinstance(o, float) and o != o:
            return None
        return o

    text = json.dumps(walk(obj), separators=(",", ":"))
    for key, raw in placeholders.items():
        text = text.replace(f'"{key}"', raw, 1)
    return text.encode("utf-8")

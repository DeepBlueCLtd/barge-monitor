"""A small Connected Systems client for the analyst's workspace.

Scripts reach the backend only through the relay (FR-35): every call here is
an HTTP request to a relative API path. ``promote`` registers a product by
standard resource creation only (FR-36): a System, then a datastream with a
SWE Common schema, then observations.

    import csapi
    ds = await csapi.datastream("bow", "weather")
    obs = await csapi.observations(ds["id"], phenomenonTime=await csapi.recent(1))
    await csapi.promote("smoothed-temperature", "Smoothed air temperature",
                        [csapi.quantity("t_smooth", "Air temperature, 5 min mean", "Cel")], rows)
"""
from __future__ import annotations

import itertools
import json
from urllib.parse import urlencode

API_BASE = None  # set by the worker: the page's api/ URL
TAP = None  # set by the worker: reports a message to the flowchart
SOSA = "http://www.w3.org/ns/sosa/"
SAMPLING_TIME = "http://www.opengis.net/def/property/OGC/0/SamplingTime"
DEF = "https://deepbluecltd.github.io/barge-monitor/def/product/"
_ids = itertools.count(1)
_source = "workspace"


def tap(src, dst, letter, summary, content=""):
    if TAP is not None:
        TAP({"src": src, "dst": dst, "letter": letter, "summary": summary, "content": str(content)[:4000]})


async def request(method: str, path: str, params=None, body=None, headers=None):
    """(status, headers, body) for one request through the relay."""
    from pyodide.http import pyfetch

    q = urlencode(params or {})
    chain = f"w{next(_ids)}"
    letter = "K" if method == "POST" and path.endswith("/commands") else "Q"
    hdrs = {"x-tap-chain": chain, "x-tap-hop": "1", **(headers or {})}
    kw = {"method": method, "headers": hdrs}
    if body is not None:
        kw["body"] = json.dumps(body)
        hdrs["content-type"] = "application/json"
    tap(_source, "relay", letter, f"{method} {path}{'?' + q if q else ''}", kw.get("body", ""))
    try:
        r = await pyfetch(API_BASE + path + ("?" + q if q else ""), **kw)
    except Exception as e:  # network failure: the server is down
        tap("relay", _source, "H", "network failure", str(e))
        raise ConnectionError(f"{method} {path}: the server did not answer") from e
    text = await r.string()
    h = {k.lower(): v for k, v in r.headers.items()}
    ctype = h.get("content-type", "")
    data = json.loads(text) if ("json" in ctype and text) else text
    if r.status >= 400:
        resp_letter = "H"
    elif path.endswith("/observations") and method == "GET":
        resp_letter = "O"
    elif path.endswith("profile"):
        resp_letter = "P"
    else:
        resp_letter = "D"
    tap("relay", _source, resp_letter, f"{r.status} {path}", text)
    return r.status, h, data


async def get(path: str, **params):
    st, _, body = await request("GET", path, params)
    if st >= 400:
        raise RuntimeError(f"{st}: {body.get('description', body) if isinstance(body, dict) else body}")
    return body


async def post(path: str, body):
    st, h, data = await request("POST", path, body=body)
    if st >= 400:
        raise RuntimeError(f"{st}: {data.get('description', data) if isinstance(data, dict) else data}")
    return data


async def datastream(system_id: str, output: str) -> dict:
    page = await get(f"systems/{system_id}/datastreams")
    for d in page["items"]:
        if d["outputName"] == output:
            return d
    raise KeyError(f"{system_id} has no {output} datastream")


async def observations(ds_id: str, **params) -> list:
    """Every page of observations, as SWE JSON records."""
    out = []
    params = {k.replace("_", "-") if k != "phenomenonTime" else k: v for k, v in params.items()}
    params.setdefault("limit", "100000")
    offset = 0
    while True:
        st, h, body = await request("GET", f"datastreams/{ds_id}/observations", {**params, "offset": str(offset)})
        if st >= 400:
            raise RuntimeError(f"{st}: {body}")
        out += body
        if 'rel="next"' not in h.get("link", ""):
            return out
        offset += len(body)


async def recent(hours: float) -> str:
    """A phenomenonTime interval covering the last `hours` of the store."""
    import datetime as dt

    ds = await datastream("bow", "weather")
    last = (await get(f"datastreams/{ds['id']}/observations", resultTime="latest"))[0]["time"]
    end = dt.datetime.fromisoformat(last.replace("Z", "+00:00"))
    return (end - dt.timedelta(hours=hours)).strftime("%Y-%m-%dT%H:%M:%SZ") + "/.."


# --- schema helpers for promoted products ------------------------------------------
def quantity(name, label, uom):
    return {"type": "Quantity", "name": name, "label": label, "definition": DEF + name, "uom": {"code": uom}}


def count(name, label):
    return {"type": "Count", "name": name, "label": label, "definition": DEF + name}


def category(name, label, values):
    return {"type": "Category", "name": name, "label": label, "definition": DEF + name,
            "codeSpace": DEF + name, "constraint": {"type": "AllowedTokens", "values": list(values)}}


def text(name, label):
    return {"type": "Text", "name": name, "label": label, "definition": DEF + name}


async def promote(product_id: str, label: str, fields: list, rows: list) -> dict:
    """Register a product: POST a System, a datastream, then its observations (FR-36).

    `rows` are dicts with a "time" (ISO 8601, UTC) and one value per field.
    The product appears to the display client at its next handshake (FR-37).
    """
    global _source
    _source = "products"
    try:
        uid = f"urn:x-barge:process:{product_id}"
        systems = await get("systems")
        for s in systems["items"]:
            if s["uniqueId"] == uid:  # re-promotion replaces the product
                await request("DELETE", f"systems/{s['id']}")
        sysm = await post("systems", {"type": "SimpleProcess", "uniqueId": uid, "label": label,
                                      "systemType": SOSA + "System", "assetType": "Process",
                                      "description": "Promoted from the analyst's workspace"})
        rec = {"type": "DataRecord", "label": label,
               "fields": [{"type": "Time", "name": "time", "label": "Time", "definition": SAMPLING_TIME,
                           "uom": {"href": "http://www.opengis.net/def/uom/ISO-8601/0/Gregorian"}}] + fields}
        ds = await post(f"systems/{sysm['id']}/datastreams", {
            "name": label, "outputName": product_id, "schema": {"obsFormat": "application/swe+json", "recordSchema": rec}})
        for i in range(0, len(rows), 5000):
            await post(f"datastreams/{ds['id']}/observations", rows[i:i + 5000])
        print(f"promoted {product_id}: system {sysm['id']}, datastream {ds['id']}, {len(rows)} observations. "
              "Restart the client to see it.")
        return ds
    finally:
        _source = "workspace"


class SuiteClient:
    """The contract suite's client interface, through the relay (AT-02)."""

    async def request(self, method, path, params=None, body=None, headers=None):
        return await request(method, path, params, body, headers)

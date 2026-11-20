"""SWE Common Data Model 3.0, JSON encoding: the record schemas the server serves.

Each sensor's record carries its measurements and, for each Quantity, a
separate Category field holding its QARTOD flag; the measurement's ``quality``
refers to that field, as SWE Common 3.0 prescribes for quality that varies per
value (FR-24).
"""
from __future__ import annotations

from .fields import DEF, QARTOD_FLAGS, Field

SAMPLING_TIME = "http://www.opengis.net/def/property/OGC/0/SamplingTime"
UTC = "http://www.opengis.net/def/trs/BIPM/0/UTC"
ISO8601 = "http://www.opengis.net/def/uom/ISO-8601/0/Gregorian"
QARTOD = "https://ioos.github.io/qartod/"
SWE_JSON = "application/swe+json"
JSON = "application/json"
OBS_FORMATS = (SWE_JSON, JSON)


def time_field(name="time", label="Sampling time") -> dict:
    return {"type": "Time", "name": name, "label": label, "definition": SAMPLING_TIME,
            "referenceFrame": UTC, "uom": {"href": ISO8601}}


def component(f: Field, quality: bool = False) -> dict:
    c = {"type": f.swe_type, "name": f.name, "label": f.label, "definition": f.definition}
    if f.description:
        c["description"] = f.description
    if f.swe_type == "Quantity":
        c["uom"] = {"code": f.uom}
        if quality:
            c["quality"] = [{"href": f"#{f.name}_qc"}]
    elif f.swe_type == "Category":
        c["codeSpace"] = DEF + f.name
        c["constraint"] = {"type": "AllowedTokens", "values": list(f.tokens)}
    elif f.swe_type == "Count" and f.uom:
        c["uom"] = {"code": f.uom}
    return c


def qc_field(f: Field) -> dict:
    return {"type": "Category", "name": f"{f.name}_qc", "id": f"{f.name}_qc",
            "label": f"QC flag: {f.label}", "definition": QARTOD + "flag",
            "codeSpace": QARTOD, "constraint": {"type": "AllowedTokens", "values": list(QARTOD_FLAGS)},
            "description": "QARTOD: 1 pass, 2 not evaluated, 3 suspect, 4 fail, 9 missing"}


def record(fields: list[dict], label: str, name: str = "record") -> dict:
    return {"type": "DataRecord", "name": name, "label": label, "fields": fields}


def text(name, label, definition=None) -> dict:
    return {"type": "Text", "name": name, "label": label, "definition": definition or DEF + name}


def quantity(name, label, uom, lo=None, hi=None, definition=None) -> dict:
    c = {"type": "Quantity", "name": name, "label": label, "definition": definition or DEF + name, "uom": {"code": uom}}
    if lo is not None:
        c["constraint"] = {"type": "AllowedValues", "intervals": [[lo, hi]]}
    return c


def count(name, label, lo=None, hi=None) -> dict:
    c = {"type": "Count", "name": name, "label": label, "definition": DEF + name}
    if lo is not None:
        c["constraint"] = {"type": "AllowedValues", "intervals": [[lo, hi]]}
    return c


def category(name, label, tokens) -> dict:
    return {"type": "Category", "name": name, "label": label, "definition": DEF + name,
            "codeSpace": DEF + name, "constraint": {"type": "AllowedTokens", "values": list(tokens)}}


def boolean(name, label) -> dict:
    return {"type": "Boolean", "name": name, "label": label, "definition": DEF + name}


def matrix(name, label) -> dict:
    return {"type": "Matrix", "name": name, "label": label, "definition": DEF + name,
            "elementCount": {"type": "Count"},
            "elementType": {"type": "DataArray", "name": "row", "elementCount": {"type": "Count"},
                            "elementType": {"type": "Quantity", "name": "r", "uom": {"code": "1"}}}}


def schema_response(rec: dict, obs_format: str) -> dict:
    """The body of GET /datastreams/{id}/schema?obsFormat=…"""
    if obs_format == SWE_JSON:
        return {"obsFormat": SWE_JSON, "recordSchema": rec, "encoding": {"type": "JSONEncoding"}}
    result = dict(rec, fields=[f for f in rec["fields"] if f["type"] != "Time" or f["name"] != "time"])
    return {"obsFormat": JSON, "resultSchema": result}


def leaf_fields(rec: dict) -> list[dict]:
    return [f for f in rec["fields"]]

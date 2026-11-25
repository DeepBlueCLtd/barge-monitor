"""SWE Common Data Model 3.0, JSON encoding: the record schemas the server holds and serves.

Each sensor's record carries its measurements and, for each Quantity, a separate Category
field holding its QARTOD flag; the measurement's ``quality`` refers to that field, as SWE
Common 3.0 prescribes for quality that varies per value (FR-25).
"""
from __future__ import annotations

from .fields import DEF, LABELS, QARTOD_FLAGS, UNITS

SAMPLING_TIME = "http://www.opengis.net/def/property/OGC/0/SamplingTime"
UTC = "http://www.opengis.net/def/trs/BIPM/0/UTC"
ISO8601 = "http://www.opengis.net/def/uom/ISO-8601/0/Gregorian"
QARTOD = "https://ioos.github.io/qartod/"
SWE_JSON = "application/swe+json"
JSON = "application/json"
OBS_FORMATS = (JSON, SWE_JSON)
NUMERIC = {"Quantity", "Count", "Boolean"}


def time_field(name="time", label="Sampling time") -> dict:
    return {"type": "Time", "name": name, "label": label, "definition": SAMPLING_TIME,
            "referenceFrame": UTC, "uom": {"href": ISO8601}}


def quantity(name, label=None, uom=None, lo=None, hi=None, definition=None, quality=False) -> dict:
    c = {"type": "Quantity", "name": name, "label": label or LABELS.get(name, name),
         "definition": definition or DEF + name, "uom": {"code": uom or UNITS.get(name, "1")}}
    if lo is not None:
        c["constraint"] = {"type": "AllowedValues", "intervals": [[lo, hi]]}
    if quality:
        c["quality"] = [{"href": f"#{name}_qc"}]
    return c


def count(name, label, lo=None, hi=None) -> dict:
    c = {"type": "Count", "name": name, "label": label, "definition": DEF + name}
    if lo is not None:
        c["constraint"] = {"type": "AllowedValues", "intervals": [[lo, hi]]}
    return c


def category(name, label, tokens, definition=None) -> dict:
    return {"type": "Category", "name": name, "label": label, "definition": definition or DEF + name,
            "codeSpace": DEF + name, "constraint": {"type": "AllowedTokens", "values": list(tokens)}}


def text(name, label, definition=None) -> dict:
    return {"type": "Text", "name": name, "label": label, "definition": definition or DEF + name}


def boolean(name, label) -> dict:
    return {"type": "Boolean", "name": name, "label": label, "definition": DEF + name}


def time_value(name, label) -> dict:
    return {"type": "Time", "name": name, "label": label, "definition": DEF + name, "referenceFrame": UTC,
            "uom": {"href": ISO8601}}


def qc_field(name: str) -> dict:
    return {"type": "Category", "name": f"{name}_qc", "id": f"{name}_qc",
            "label": f"QC flag: {LABELS.get(name, name)}", "definition": QARTOD + "flag",
            "codeSpace": QARTOD, "constraint": {"type": "AllowedTokens", "values": list(QARTOD_FLAGS)},
            "description": "QARTOD: 1 pass, 2 not evaluated, 3 suspect, 4 fail, 9 missing"}


def record(fields: list[dict], label: str, name: str = "record") -> dict:
    return {"type": "DataRecord", "name": name, "label": label, "fields": fields}


def measurement_record(names: list[str], label: str) -> dict:
    """A sensor's record: each quantity followed by its QC flag."""
    fields = [time_field()]
    for n in names:
        fields.append(quantity(n, quality=True))
        fields.append(qc_field(n))
    return record(fields, label)


def schema_response(rec: dict, obs_format: str) -> dict:
    """The body of GET /datastreams/{id}/schema?obsFormat=…"""
    if obs_format == SWE_JSON:
        return {"obsFormat": SWE_JSON, "recordSchema": rec, "encoding": {"type": "JSONEncoding"}}
    result = dict(rec, fields=[f for f in rec["fields"] if not (f["type"] == "Time" and f["name"] == "time")])
    return {"obsFormat": JSON, "resultSchema": result}

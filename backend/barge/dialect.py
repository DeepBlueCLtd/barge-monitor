"""The data folder's CSV dialect (docs/v4-interfaces.md §5): the only code that reads it (FR-20).

* lines 1–3: a ``#`` comment block (logger, export tool, ``#MISSION=<name>``);
* line 4: the header, ``;``-separated, with the **decimal comma**;
* column 1 ``T_HS94``: half-seconds since 1994-01-01T00:00:00Z;
* then ``BOW_<code>[<unit>]`` and ``STN_<code>[<unit>]``: tenths of a degree (``dC``), knots
  (``kn``), and so on, converted here to the declared units (°C, m/s);
* ``-9999`` (or ``////`` for text) is missing; ``VRB`` is a variable wind direction;
* a column missing from a file means the field is absent from that dataset (FR-21).

``parse`` returns ``Parsed``: times (Unix seconds) and, per (sensor, field), the readings
in declared units, plus which readings were "variable". Importing over this is the
importer's job (importer.py); a second dialect replaces this module only (AT-03).
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

import numpy as np

LOGGER_EPOCH_UNIX = 757382400  # 1994-01-01T00:00:00Z
KNOT = 0.514444  # m/s
PREFIX = {"BOW": "bow", "STN": "stern"}
CODES = {"AT": "air_temperature", "RH": "relative_humidity", "PR": "pressure", "AWS": "apparent_wind_speed",
         "AWD": "apparent_wind_direction", "SR": "solar_irradiance", "WT": "water_temperature", "CO2": "co2"}
# Bracketed unit -> factor to the declared unit.
UNIT_FACTOR = {"dC": 0.1, "kn": KNOT, "%": 1.0, "hPa": 1.0, "deg": 1.0, "W/m2": 1.0, "ppm": 1.0, "C": 1.0, "m/s": 1.0}
_COL = re.compile(r"^(BOW|STN)_([A-Z0-9]+)\[([^\]]*)\]$")


@dataclass
class Parsed:
    t: np.ndarray  # Unix seconds
    values: dict = field(default_factory=dict)  # (sensor, field) -> float array, declared units, NaN missing
    variable: dict = field(default_factory=dict)  # (sensor, field) -> bool array (VRB)
    mission: str = ""
    header: list = field(default_factory=list)
    first_rows: list = field(default_factory=list)  # the first three data lines, as written


class DialectError(ValueError):
    pass


def parse(raw: bytes) -> Parsed:
    text = raw.decode("ascii", errors="replace")
    lines = text.split("\r\n") if "\r\n" in text else text.split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    comments = [ln for ln in lines[:3] if ln.startswith("#")]
    if len(comments) != 3:
        raise DialectError("expected three # comment lines before the header")
    mission = next((c.split("=", 1)[1] for c in comments if c.startswith("#MISSION=")), "")
    header = lines[3].split(";")
    if header[0] != "T_HS94":
        raise DialectError(f"the first column must be T_HS94, not {header[0]}")
    body = lines[4:]
    n = len(body)
    ncol = len(header)
    # The decimal comma is the only comma in the file: fields are separated by ';'.
    cells = np.array(";".join(body).replace(",", ".").split(";"), dtype=object) if n else np.empty(0, dtype=object)
    if len(cells) != n * ncol:
        raise DialectError("rows do not all have the header's number of columns")
    grid = cells.reshape(n, ncol) if n else np.empty((0, ncol), dtype=object)
    t = grid[:, 0].astype(np.int64) // 2 + LOGGER_EPOCH_UNIX if n else np.empty(0, dtype=np.int64)
    out = Parsed(t=t.astype(float), mission=mission, header=header, first_rows=body[:3])
    for j, name in enumerate(header[1:], start=1):
        m = _COL.match(name)
        if not m:
            raise DialectError(f"column {name} is not <BOW|STN>_<code>[<unit>]")
        sensor, code, unit = PREFIX[m.group(1)], m.group(2), m.group(3)
        if code not in CODES:
            continue  # a column this system does not know is left out
        if unit not in UNIT_FACTOR:
            raise DialectError(f"column {name}: unknown unit {unit}")
        col = grid[:, j]
        var = col == "VRB"
        miss = (col == "-9999") | (col == "////") | var | (col == "")
        v = np.where(miss, "nan", col).astype(float) * UNIT_FACTOR[unit]
        out.values[(sensor, CODES[code])] = v
        out.variable[(sensor, CODES[code])] = var
    return out

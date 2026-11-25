"""A second, differently awkward CSV dialect (AT-03; docs/v4-interfaces.md §5), for tests only.

The same data as the data folder's files, written with ``,`` separators, ``.`` decimals, ISO 8601
times, °C and m/s, and missing values as empty fields:

    time,bow.air_temperature (C),bow.apparent_wind_speed (m/s),…,stern.co2 (ppm)
    2031-04-07T00:00:00Z,17.3,2.8809,…

``write`` makes such a file from a first-dialect file; ``parse`` is what the importer is given to
read it. Only the importer changes (its parser is a port): the server, the models and the
responses are the same.
"""
from __future__ import annotations

import numpy as np

from barge import dialect
from barge.dialect import Parsed
from barge.times import iso_many, parse_many

UNIT = {"air_temperature": "C", "water_temperature": "C", "apparent_wind_speed": "m/s", "relative_humidity": "%",
        "pressure": "hPa", "apparent_wind_direction": "deg", "solar_irradiance": "W/m2", "co2": "ppm"}


def _fmt(v: np.ndarray) -> list[str]:
    out = []
    for x in np.round(v, 4).tolist():
        out.append("" if x != x else (str(int(x)) if x == int(x) else repr(x)))
    return out


def write(first: bytes) -> bytes:
    p = dialect.parse(first)
    keys = list(p.values)
    head = ["time"] + [f"{s}.{f} ({UNIT[f]})" for s, f in keys]
    cols = [iso_many(p.t)] + [_fmt(p.values[k]) for k in keys]
    lines = [",".join(head)] + [",".join(row) for row in zip(*cols)]
    return ("\n".join(lines) + "\n").encode("ascii")


def parse(raw: bytes) -> Parsed:
    lines = raw.decode("ascii").splitlines()
    head = lines[0].split(",")
    body = [ln.split(",") for ln in lines[1:] if ln]
    grid = np.array(body, dtype=object)
    out = Parsed(t=parse_many(grid[:, 0].tolist()), mission="", header=head, first_rows=lines[1:4])
    for j, name in enumerate(head[1:], start=1):
        sensor, rest = name.split(".", 1)
        field = rest.split(" ", 1)[0]
        col = grid[:, j]
        missing = col == ""
        out.values[(sensor, field)] = np.where(missing, "nan", col).astype(float)
        out.variable[(sensor, field)] = np.zeros(len(col), dtype=bool)
    return out

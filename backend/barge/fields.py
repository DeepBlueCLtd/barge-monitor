"""What the server can publish, and what it publishes now (FR-32a, FR-46b..e).

The catalogue lists every measured and calculated field. Each calculated field
declares its inputs; a calculated field is published only when it is switched
on *and* all its inputs are published. The configuration is read once, at
server start: a toggle is pending until the next start (FR-46d).
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass, field

DEF = "https://deepbluecltd.github.io/barge-monitor/def/"
QARTOD_FLAGS = {"1": "pass", "2": "not evaluated", "3": "suspect", "4": "fail", "9": "missing"}


@dataclass(frozen=True)
class Field:
    name: str
    label: str
    swe_type: str  # Quantity, Category, Count, Boolean, Text, Time, Matrix
    uom: str | None = None
    kind: str = "measured"  # measured | calculated
    inputs: tuple = ()
    default_on: bool = True
    essential: bool = False
    tokens: tuple = ()
    description: str = ""
    extra: bool = False  # one of the three fields the display has never seen

    @property
    def definition(self) -> str:
        return DEF + self.name


MEASURED = [
    Field("air_temperature", "Air temperature", "Quantity", "Cel", essential=True),
    Field("apparent_wind_speed", "Apparent wind speed", "Quantity", "m/s", essential=True),
    Field("relative_humidity", "Relative humidity", "Quantity", "%"),
    Field("pressure", "Barometric pressure (station)", "Quantity", "hPa"),
    Field("apparent_wind_direction", "Apparent wind direction, relative to the bow", "Quantity", "deg"),
    Field("solar_irradiance", "Solar irradiance", "Quantity", "W/m2"),
    Field("water_temperature", "Water temperature", "Quantity", "Cel"),
    Field("precipitation_type", "Precipitation type", "Category", None, default_on=False,
          tokens=("none", "drizzle", "rain", "showers"), extra=True,
          description="Measured by both sensors; published only when switched on."),
]
QUANTITIES = [f.name for f in MEASURED if f.swe_type == "Quantity"]

CALCULATED = [
    Field("dew_point", "Dew point (bow)", "Quantity", "Cel", "calculated",
          ("air_temperature", "relative_humidity"), essential=True),
    Field("air_minus_water", "Air minus water temperature (bow)", "Quantity", "Cel", "calculated",
          ("air_temperature", "water_temperature")),
    *[Field(f"bow_minus_stern_{p}", f"Bow minus stern: {m.label.lower()}", "Quantity", m.uom, "calculated", (p,),
            description="Unaligned: no lag correction is possible without speed.")
      for p, m in ((m.name, m) for m in MEASURED if m.swe_type == "Quantity")],
    Field("pressure_tendency_3h", "Pressure tendency over three hours (bow)", "Quantity", "hPa", "calculated",
          ("pressure",), default_on=False, extra=True),
    Field("spikes_last_hour", "Readings flagged as spikes in the last hour (both sensors)", "Count", None,
          "calculated", ("air_temperature",), default_on=False, extra=True),
]
CATALOGUE = {f.name: f for f in MEASURED + CALCULATED}


@dataclass
class Offering:
    """The fields switched on. Frozen into the server at each start."""

    on: dict = field(default_factory=lambda: {f.name: f.default_on for f in MEASURED + CALCULATED})

    def copy(self) -> "Offering":
        return Offering(dict(self.on))

    def measured(self) -> list[Field]:
        return [f for f in MEASURED if self.on[f.name]]

    def calculated(self) -> list[Field]:
        pub = {f.name for f in self.measured()}
        return [f for f in CALCULATED if self.on[f.name] and all(i in pub for i in f.inputs)]

    def published(self, name: str) -> bool:
        return name in {f.name for f in self.measured() + self.calculated()}


def schema_id(base: str, names: list[str]) -> str:
    """A datastream's identifier changes whenever its schema does (FR-46c)."""
    h = hashlib.sha1(",".join(names).encode()).hexdigest()[:6]
    return f"{base}-{h}"

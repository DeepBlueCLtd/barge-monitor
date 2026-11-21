"""What the server can publish, and what it publishes now (FR-50..FR-52).

The catalogue lists every field the control panel can switch: the raw
parameters (both sensors together), the model outputs the server knows about,
and three extra fields, off by default, that the display client has never
seen: a Category, a Quantity and a Count (FR-50). A field is published only
when it is switched on *and* all its inputs are published (FR-52). The
offering is read once, at server start: a toggle is pending until then (FR-51).

The server applies the offering to every datastream it serves, its own and
the models': a field named in the catalogue and not published is left out of
the schema and the observations. Fields the catalogue does not know (a new
model's outputs) are always published.
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
    kind: str = "raw"  # raw | model
    inputs: tuple = ()
    default_on: bool = True
    essential: bool = False
    tokens: tuple = ()
    description: str = ""
    extra: bool = False  # one of the three fields the display has never seen

    @property
    def definition(self) -> str:
        return DEF + self.name


RAW = [
    Field("air_temperature", "Air temperature", "Quantity", "Cel", essential=True),
    Field("apparent_wind_speed", "Wind speed", "Quantity", "m/s", essential=True,
          description="Apparent wind speed, as felt aboard."),
    Field("relative_humidity", "Humidity", "Quantity", "%"),
    Field("pressure", "Pressure", "Quantity", "hPa", description="Barometric pressure at the sensor."),
    Field("apparent_wind_direction", "Wind direction", "Quantity", "deg",
          description="Apparent wind direction, degrees relative to the bow."),
    Field("solar_irradiance", "Solar irradiance", "Quantity", "W/m2"),
    Field("water_temperature", "Water temp", "Quantity", "Cel"),
    Field("precipitation_type", "Precipitation", "Category", None, default_on=False,
          tokens=("none", "drizzle", "rain", "showers"), extra=True,
          description="Measured by both sensors; published only when switched on."),
]
QUANTITIES = [f.name for f in RAW if f.swe_type == "Quantity"]

MODEL_OUTPUTS = [
    Field("dew_point", "Dew point", "Quantity", "Cel", "model", ("air_temperature", "relative_humidity"),
          essential=True, description="From bow air temperature and humidity (Model A)."),
    Field("bow_minus_stern", "Bow − stern", "Quantity", "Cel", "model", ("air_temperature",), essential=True,
          description="Bow minus stern air temperature (Model A). Unaligned: no lag correction is possible without speed."),
    Field("pressure_tendency_3h", "Pressure tendency", "Quantity", "hPa", "model", ("pressure",),
          default_on=False, extra=True, description="Change in bow pressure over three hours (Model A)."),
    Field("readings_removed", "Readings removed", "Count", None, "model", (),
          default_on=False, extra=True, description="Readings Data cleanse removed in the interval (Model A)."),
]
CATALOGUE = {f.name: f for f in RAW + MODEL_OUTPUTS}


@dataclass
class Offering:
    """The fields switched on. Frozen into the server at each start."""

    on: dict = field(default_factory=lambda: {f.name: f.default_on for f in RAW + MODEL_OUTPUTS})

    def copy(self) -> "Offering":
        return Offering(dict(self.on))

    def raw(self) -> list[Field]:
        return [f for f in RAW if self.on[f.name]]

    def published(self, name: str) -> bool:
        """True for a field this offering publishes, and for any field the catalogue does not know."""
        f = CATALOGUE.get(name)
        if f is None:
            return True
        if not self.on[name]:
            return False
        return all(self.published(i) for i in f.inputs)

    def keep(self, field_name: str) -> bool:
        """Whether a field of any datastream is served (QC flags follow their measurement)."""
        base = field_name[:-3] if field_name.endswith("_qc") else field_name
        return self.published(base)


def schema_id(base: str, names: list[str]) -> str:
    """A datastream's identifier changes whenever its schema does (FR-51)."""
    h = hashlib.sha1(",".join(names).encode()).hexdigest()[:6]
    return f"{base}-{h}"
